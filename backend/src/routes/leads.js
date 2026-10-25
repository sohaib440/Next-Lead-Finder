import { Router } from "express";
import mongoose from "mongoose";
import { requireAdmin } from "../middleware/auth.js";
import { User } from "../models/User.js";
import { can, isAdmin, scoped } from "../services/access.js";
import { activeUsers, applyDistribution, planDistribution } from "../services/distribute.js";
import { notify } from "../services/notify.js";
import { Activity } from "../models/Activity.js";
import { LEAD_PRIORITIES, LEAD_STAGES, Lead, dedupeKeyFor, refreshScores } from "../models/Lead.js";
import { Task } from "../models/Task.js";
import { Template } from "../models/Template.js";
import { deleteLeads, logActivity, setStage } from "../services/crm.js";
import { DEFAULT_MATCH_ON, findDuplicateGroups, mergeLeads } from "../services/dedupe.js";
import { cancelEnrich, currentEnrichJob, startEnrich } from "../services/enrichRunner.js";

export const leadsRouter = Router();

const SORTS = {
  newest: { createdAt: -1 },
  oldest: { createdAt: 1 },
  name: { businessName: 1 },
  city: { city: 1, businessName: 1 },
  score: { score: -1, createdAt: -1 },
  value: { dealValue: -1, createdAt: -1 },
  contacted: { lastContactedAt: -1, createdAt: -1 },
  opportunity: { opportunity: -1, reviewCount: -1, createdAt: -1 },
  rating: { rating: -1, reviewCount: -1 },
  reviews: { reviewCount: -1, rating: -1 },
};

/** Adds who last worked on each lead, and who has open tasks on it, to a page of leads. */
async function withWorkInfo(leads) {
  const ids = leads.map((l) => l._id);
  const [last, open] = await Promise.all([
    Activity.aggregate([
      // Stage moves often follow automatically from a call or message, so show the real work.
      { $match: { leadId: { $in: ids }, by: { $nin: [null, ""] }, type: { $ne: "stage_change" } } },
      { $sort: { createdAt: -1 } },
      { $group: { _id: "$leadId", type: { $first: "$type" }, by: { $first: "$by" }, date: { $first: "$createdAt" } } },
    ]),
    Task.aggregate([
      { $match: { leadId: { $in: ids }, done: false, assignedTo: { $ne: null } } },
      { $lookup: { from: "users", localField: "assignedTo", foreignField: "_id", as: "u" } },
      { $group: { _id: "$leadId", names: { $addToSet: { $first: "$u.name" } }, count: { $sum: 1 } } },
    ]),
  ]);
  const lastBy = new Map(last.map((a) => [String(a._id), { type: a.type, by: a.by, date: a.date }]));
  const openBy = new Map(open.map((t) => [String(t._id), { count: t.count, assignees: t.names.filter(Boolean) }]));
  return leads.map((l) => ({
    ...l.toJSON(),
    lastActivity: lastBy.get(String(l._id)) ?? null,
    openTasks: openBy.get(String(l._id)) ?? null,
  }));
}

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const list = (value) => String(value ?? "").split(",").map((s) => s.trim()).filter(Boolean);

/** Builds a Mongo filter from query params shared by listing, export, pipeline and bulk delete. */
export function leadFilter(query) {
  const filter = {};
  const q = String(query.q ?? "").trim();
  if (q) {
    const re = new RegExp(escapeRegex(q), "i");
    filter.$or = [
      { businessName: re }, { email: re }, { phone: re }, { website: re }, { address: re }, { category: re },
      { contactName: re }, { tags: re },
    ];
  }
  if (query.country) filter.country = String(query.country);
  if (query.city) filter.city = String(query.city);
  if (query.category) filter.category = String(query.category);
  if (query.tag) filter.tags = String(query.tag);
  // "none" = unassigned; otherwise a user id ("me" is resolved by the route).
  if (query.assignedTo === "none") filter.assignedTo = null;
  else if (query.assignedTo && mongoose.isValidObjectId(query.assignedTo)) {
    filter.assignedTo = new mongoose.Types.ObjectId(String(query.assignedTo));
  }
  if (query.importId && mongoose.isValidObjectId(query.importId)) {
    filter.importId = new mongoose.Types.ObjectId(String(query.importId));
  }
  const stages = list(query.stage).filter((s) => LEAD_STAGES.includes(s));
  if (stages.length) filter.stage = { $in: stages };
  if (LEAD_PRIORITIES.includes(query.priority)) filter.priority = query.priority;
  // ?whatsapp=yes | no | unknown (not tried yet, on a mobile or unknown number) | landline
  if (query.whatsapp === "yes" || query.whatsapp === "no") filter.whatsappStatus = query.whatsapp;
  else if (query.whatsapp === "unknown") Object.assign(filter, { whatsappStatus: "unknown", phoneType: { $in: ["mobile", "unknown"] } });
  else if (query.whatsapp === "landline") Object.assign(filter, { whatsappStatus: { $ne: "yes" }, phoneType: "landline" });
  const minRating = Number(query.minRating);
  if (minRating > 0) filter.rating = { $gte: minRating };
  const minReviews = Number(query.minReviews);
  if (minReviews > 0) filter.reviewCount = { $gte: minReviews };
  const minOpportunity = Number(query.minOpportunity);
  if (minOpportunity > 0) filter.opportunity = { $gte: minOpportunity };
  // Hide businesses Google lists as permanently closed.
  if (query.hideClosed === "true") filter.businessStatus = { $ne: "closed_permanently" };
  // Every lead a search found, including ones an earlier search had already saved.
  // Cast explicitly so the filter also works in aggregation pipelines.
  if (query.searchId && mongoose.isValidObjectId(query.searchId)) {
    filter.searchIds = new mongoose.Types.ObjectId(String(query.searchId));
  }
  for (const field of list(query.has)) {
    if (["phone", "email", "website"].includes(field)) filter[field] = { $nin: [null, ""] };
  }
  // ?missing=website lists businesses without one (e.g. prospects for web design).
  for (const field of list(query.missing)) {
    if (["phone", "email", "website"].includes(field)) filter[field] = { $in: [null, ""] };
  }
  return filter;
}

const TEXT_FIELDS = ["category", "country", "city"];
const NULLABLE_FIELDS = ["address", "phone", "email", "website", "contactName", "contactRole"];

function cleanTags(tags) {
  if (!Array.isArray(tags)) return [];
  return [...new Set(tags.map((t) => String(t).trim().slice(0, 40)).filter(Boolean))].slice(0, 30);
}

/**
 * Copies editable fields from a request body onto a lead document (stage is applied
 * separately so the change gets logged). Returns a map of field errors, if any.
 */
function applyFields(lead, body) {
  const errors = {};
  if ("businessName" in body) {
    const name = String(body.businessName ?? "").trim();
    if (name) lead.businessName = name;
    else errors.businessName = "Business name is required.";
  }
  for (const f of TEXT_FIELDS) if (f in body) lead[f] = String(body[f] ?? "").trim();
  for (const f of NULLABLE_FIELDS) if (f in body) lead[f] = String(body[f] ?? "").trim() || null;
  if ("website" in body && lead.website && !/^https?:\/\//i.test(lead.website)) lead.website = `https://${lead.website}`;
  if ("tags" in body) lead.tags = cleanTags(body.tags);
  if ("whatsappStatus" in body) {
    if (["unknown", "yes", "no"].includes(body.whatsappStatus)) lead.whatsappStatus = body.whatsappStatus;
    else errors.whatsappStatus = "WhatsApp status must be unknown, yes or no.";
  }
  if ("pinned" in body) {
    lead.pinned = body.pinned === true;
    lead.pinnedAt = lead.pinned ? new Date() : null;
  }
  if ("priority" in body) {
    if (LEAD_PRIORITIES.includes(body.priority)) lead.priority = body.priority;
    else errors.priority = `Priority must be one of ${LEAD_PRIORITIES.join(", ")}.`;
  }
  if ("dealValue" in body) {
    const value = body.dealValue === null || body.dealValue === "" ? null : Number(body.dealValue);
    if (value === null || (Number.isFinite(value) && value >= 0)) lead.dealValue = value;
    else errors.dealValue = "Deal value must be a positive number.";
  }
  if ("stage" in body && !LEAD_STAGES.includes(body.stage)) errors.stage = `Stage must be one of ${LEAD_STAGES.join(", ")}.`;
  lead.dedupeKey = dedupeKeyFor(lead.businessName ?? "", lead.city);
  return errors;
}

/** Saves a lead, mapping a dedupe-key clash to 409. Returns false when a response was already sent. */
async function saveLead(lead, res) {
  try {
    await lead.save();
    return true;
  } catch (err) {
    if (err.code === 11000) {
      res.status(409).json({ error: "A lead with this business name already exists in this city." });
      return false;
    }
    if (err.name === "ValidationError") {
      res.status(400).json({ error: err.message });
      return false;
    }
    throw err;
  }
}

/** Lead query params from a request; "assignedTo=me" means the signed-in user. */
const queryOf = (req, query = req.query) =>
  query.assignedTo === "me" ? { ...query, assignedTo: String(req.user._id) } : query;

/** Valid ids from a body array, limited to leads the user may see. */
async function visibleIds(req, ids) {
  const valid = (Array.isArray(ids) ? ids : []).filter((id) => mongoose.isValidObjectId(id));
  if (!valid.length || isAdmin(req.user)) return valid;
  return (await Lead.find(scoped(req.user, { _id: { $in: valid } }), { _id: 1 })).map((l) => String(l._id));
}

leadsRouter.get("/", async (req, res) => {
  const filter = scoped(req.user, leadFilter(queryOf(req)));
  const sort = SORTS[req.query.sort] ?? SORTS.newest;
  // Pinned leads come first on screen; exports keep the plain order.
  const pageSort = { pinned: -1, ...sort };

  // ?all=true returns every match (used for exports).
  if (req.query.all === "true") {
    if (!can(req.user, "export")) {
      return res.status(403).json({ error: "Exporting leads is turned off for your account. Ask an admin.", code: "forbidden" });
    }
    const items = await Lead.find(filter).sort(sort).limit(100000);
    res.locals.audit = { action: "leads.export", label: `Exported ${items.length} leads` };
    return res.json({ items, total: items.length, page: 1, limit: items.length });
  }

  const limit = Math.min(Math.max(Number(req.query.limit) || 25, 1), 500);
  const page = Math.max(Number(req.query.page) || 1, 1);
  const [items, total] = await Promise.all([
    Lead.find(filter).sort(pageSort).skip((page - 1) * limit).limit(limit),
    Lead.countDocuments(filter),
  ]);
  res.json({ items: await withWorkInfo(items), total, page, limit });
});

leadsRouter.get("/facets", async (req, res) => {
  const scope = scoped(req.user);
  const [countries, categories, cities, tags] = await Promise.all([
    Lead.distinct("country", scope),
    Lead.distinct("category", scope),
    Lead.distinct("city", scope),
    Lead.distinct("tags", scope),
  ]);
  const clean = (list) => list.filter(Boolean).sort((a, b) => a.localeCompare(b));
  res.json({ countries: clean(countries), categories: clean(categories), cities: clean(cities), tags: clean(tags) });
});

// A lead added by hand rather than found by a search. Members own the leads they add.
leadsRouter.post("/", async (req, res) => {
  const body = req.body ?? {};
  const lead = new Lead({ businessName: "-", source: "Manual" });
  const errors = applyFields(lead, { businessName: "", ...body });
  if (Object.keys(errors).length) return res.status(400).json({ error: "Invalid lead", errors });
  if (body.stage) lead.stage = body.stage;
  if (!isAdmin(req.user)) lead.assignedTo = req.user._id;
  else if (mongoose.isValidObjectId(body.assignedTo)) lead.assignedTo = body.assignedTo;
  if (!(await saveLead(lead, res))) return;
  await refreshScores({ _id: lead._id });
  res.status(201).json(await Lead.findById(lead._id));
});

leadsRouter.post("/bulk-update", async (req, res) => {
  const body = req.body ?? {};
  const ids = await visibleIds(req, body.ids);
  if (!ids.length) return res.status(400).json({ error: "No lead ids given" });
  if (body.stage !== undefined && !LEAD_STAGES.includes(body.stage)) {
    return res.status(400).json({ error: `Stage must be one of ${LEAD_STAGES.join(", ")}` });
  }

  const addTags = cleanTags(body.addTags);
  const removeTags = cleanTags(body.removeTags);
  if (addTags.length) await Lead.updateMany({ _id: { $in: ids } }, { $addToSet: { tags: { $each: addTags } } });
  if (removeTags.length) await Lead.updateMany({ _id: { $in: ids } }, { $pull: { tags: { $in: removeTags } } });
  if (LEAD_PRIORITIES.includes(body.priority)) await Lead.updateMany({ _id: { $in: ids } }, { priority: body.priority });
  if (typeof body.pinned === "boolean") {
    await Lead.updateMany({ _id: { $in: ids } }, { pinned: body.pinned, pinnedAt: body.pinned ? new Date() : null });
  }
  const moved = body.stage ? await setStage(ids, body.stage, {}, req.user.name, req.user._id) : 0;
  // Log what actually changed (ids outside the user's leads were dropped above).
  res.locals.audit = {
    label: body.stage
      ? `Moved ${ids.length} lead${ids.length === 1 ? "" : "s"} to ${body.stage}`
      : typeof body.pinned === "boolean"
        ? `${body.pinned ? "Pinned" : "Unpinned"} ${ids.length} lead${ids.length === 1 ? "" : "s"}`
        : body.priority
          ? `Set priority ${body.priority} on ${ids.length} lead${ids.length === 1 ? "" : "s"}`
          : `Updated ${ids.length} lead${ids.length === 1 ? "" : "s"}`,
  };
  res.json({ updated: ids.length, moved });
});

// Admin: hand leads to a staff member (userId null = unassign).
leadsRouter.post("/assign", requireAdmin, async (req, res) => {
  const ids = (Array.isArray(req.body?.ids) ? req.body.ids : []).filter((id) => mongoose.isValidObjectId(id));
  const userId = req.body?.userId ?? null;
  if (!ids.length) return res.status(400).json({ error: "No lead ids given" });
  let user = null;
  if (userId !== null) {
    user = mongoose.isValidObjectId(userId) ? await User.findById(userId, { name: 1 }) : null;
    if (!user) return res.status(400).json({ error: "Staff member not found" });
  }
  const result = await Lead.updateMany({ _id: { $in: ids } }, { assignedTo: user?._id ?? null });
  await Activity.insertMany(
    ids.map((id) => ({
      leadId: id,
      type: "note",
      text: user ? `Assigned to ${user.name}` : "Unassigned",
      by: req.user.name,
      userId: req.user._id,
    })),
  );
  res.locals.audit = { label: user ? `Assigned ${ids.length} leads to ${user.name}` : `Unassigned ${ids.length} leads` };
  if (user && String(user._id) !== String(req.user._id)) {
    await notify(user._id, {
      type: "leads_assigned",
      title: `${ids.length} lead${ids.length === 1 ? "" : "s"} assigned to you`,
      body: `By ${req.user.name}`,
      link: ids.length === 1 ? `/leads/${ids[0]}` : "/leads?assignedTo=me",
    });
  }
  res.json({ updated: result.modifiedCount });
});

/**
 * Admin: split leads between staff. Body: { ids | query | searchId, userIds, method: "even" |
 * "balanced", onlyUnassigned (default true), preview }. With preview, nothing changes.
 */
leadsRouter.post("/distribute", requireAdmin, async (req, res) => {
  const body = req.body ?? {};
  const users = await activeUsers((Array.isArray(body.userIds) ? body.userIds : []).filter((id) => mongoose.isValidObjectId(id)));
  if (!users.length) return res.status(400).json({ error: "Choose at least one active staff member." });
  const ids = (Array.isArray(body.ids) ? body.ids : []).filter((id) => mongoose.isValidObjectId(id));
  const filter = ids.length
    ? { _id: { $in: ids } }
    : leadFilter(mongoose.isValidObjectId(body.searchId) ? { searchId: body.searchId } : (body.query ?? {}));
  if (body.onlyUnassigned !== false) filter.assignedTo = null;
  // Closed deals stay with whoever closed them.
  filter.stage = { $nin: ["won", "lost"] };
  const leads = await Lead.find(filter, { opportunity: 1, reviewCount: 1 }).limit(20000);
  const plan = await planDistribution(leads, users, body.method === "balanced" ? "balanced" : "even");
  const summary = plan.map(({ userId, name, leadIds }) => ({ userId, name, count: leadIds.length }));
  if (body.preview) return res.json({ total: leads.length, plan: summary });
  const label = String(body.label ?? "").slice(0, 120) || null;
  await applyDistribution(plan, { by: req.user.name, byUserId: req.user._id, label });
  res.locals.audit = { label: `Distributed ${leads.length} leads to ${users.map((u) => u.name).join(", ")}` };
  res.json({ total: leads.length, plan: summary });
});

// Enrich: audit websites, find missing emails and socials, refresh Google ratings.
leadsRouter.get("/enrich", (_req, res) => res.json(currentEnrichJob()));

leadsRouter.post("/enrich", async (req, res) => {
  const body = req.body ?? {};
  const ids = Array.isArray(body.ids) ? body.ids.filter((id) => mongoose.isValidObjectId(id)) : [];
  const filter = scoped(req.user, ids.length ? { _id: { $in: ids } } : leadFilter(queryOf(req, body.query ?? {})));
  const leads = await Lead.find(filter, { website: 1, sourceUrl: 1, email: 1, rating: 1, audit: 1 }).limit(5000);
  try {
    res.status(201).json(
      startEnrich(
        leads,
        { website: body.website !== false, google: body.google !== false, onlyMissing: body.onlyMissing !== false },
        req.user.name,
      ),
    );
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    throw err;
  }
});

leadsRouter.post("/enrich/cancel", (req, res) => {
  const job = currentEnrichJob();
  if (job && !isAdmin(req.user) && job.startedBy !== req.user.name) {
    return res.status(403).json({ error: "Only the person who started this check or an admin can stop it." });
  }
  if (!cancelEnrich()) return res.status(409).json({ error: "No enrich job is running." });
  res.json(currentEnrichJob());
});

// Duplicates span everyone's leads, so finding and merging them is for admins.
leadsRouter.get("/duplicates", requireAdmin, async (req, res) => {
  const matchOn = list(req.query.matchOn).filter((k) => DEFAULT_MATCH_ON.includes(k));
  res.json(await findDuplicateGroups(matchOn.length ? matchOn : DEFAULT_MATCH_ON));
});

// "Not duplicates": hide this exact group from the duplicate finder.
leadsRouter.post("/duplicates/ignore", requireAdmin, async (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.filter((id) => mongoose.isValidObjectId(id)).map(String) : [];
  if (ids.length < 2) return res.status(400).json({ error: "Give at least two lead ids" });
  const groupId = [...ids].sort().join(",");
  await Lead.updateMany({ _id: { $in: ids } }, { $addToSet: { mergeIgnore: groupId } });
  res.json({ ignored: ids.length });
});

leadsRouter.post("/merge", requireAdmin, async (req, res) => {
  const { primaryId, duplicateIds } = req.body ?? {};
  const ids = Array.isArray(duplicateIds) ? duplicateIds.filter((id) => mongoose.isValidObjectId(id)) : [];
  if (!mongoose.isValidObjectId(primaryId) || !ids.length) {
    return res.status(400).json({ error: "Choose the lead to keep and at least one duplicate" });
  }
  try {
    res.json(await mergeLeads(primaryId, ids, req.user.name));
  } catch (err) {
    if (err.status === 404) return res.status(404).json({ error: err.message });
    throw err;
  }
});

// Deleting leads is admin-only; staff can close a lead as Lost instead.
leadsRouter.post("/bulk-delete", requireAdmin, async (req, res) => {
  const ids = await visibleIds(req, req.body?.ids);
  if (!ids.length) return res.status(400).json({ error: "No lead ids given" });
  const deleted = await deleteLeads({ _id: { $in: ids } });
  res.locals.audit = { label: `Deleted ${deleted} lead${deleted === 1 ? "" : "s"}` };
  res.json({ deleted });
});

leadsRouter.delete("/", requireAdmin, async (req, res) => {
  if (req.query.confirm !== "true") return res.status(400).json({ error: "Pass ?confirm=true to delete every lead" });
  res.json({ deleted: await deleteLeads({}) });
});

leadsRouter.get("/:id", async (req, res) => {
  const lead = await Lead.findOne(scoped(req.user, { _id: req.params.id })).populate("assignedTo", "name email");
  if (!lead) return res.status(404).json({ error: "Lead not found" });
  const [activities, tasks] = await Promise.all([
    Activity.find({ leadId: lead._id }).sort({ createdAt: -1 }).limit(300),
    Task.find({ leadId: lead._id })
      .sort({ done: 1, dueAt: 1, createdAt: -1 })
      .populate("assignedTo", "name")
      .populate("createdBy", "name"),
  ]);
  res.locals.audit = { action: "lead.view", target: { type: "lead", id: String(lead._id), label: lead.businessName } };
  res.json({ lead, activities, tasks });
});

leadsRouter.patch("/:id", async (req, res) => {
  const lead = await Lead.findOne(scoped(req.user, { _id: req.params.id }));
  if (!lead) return res.status(404).json({ error: "Lead not found" });
  const body = req.body ?? {};
  const errors = applyFields(lead, body);
  if (Object.keys(errors).length) return res.status(400).json({ error: "Invalid lead", errors });
  // Only admins choose who a lead belongs to.
  const previousOwner = lead.assignedTo ? String(lead.assignedTo) : null;
  if ("assignedTo" in body && isAdmin(req.user)) {
    lead.assignedTo =
      mongoose.isValidObjectId(body.assignedTo) && (await User.exists({ _id: body.assignedTo })) ? body.assignedTo : null;
  }
  const newOwner = lead.assignedTo ? String(lead.assignedTo) : null;
  if (newOwner && newOwner !== previousOwner && newOwner !== String(req.user._id)) {
    await notify(newOwner, { type: "leads_assigned", title: `Lead assigned to you: ${lead.businessName}`, body: `By ${req.user.name}`, link: `/leads/${lead._id}` });
  }
  if (!(await saveLead(lead, res))) return;
  if (body.stage) await setStage([lead._id], body.stage, {}, req.user.name, req.user._id);
  await refreshScores({ _id: lead._id });
  res.json(await Lead.findById(lead._id).populate("assignedTo", "name email"));
});

leadsRouter.delete("/:id", requireAdmin, async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: "Invalid id" });
  const deleted = await deleteLeads(scoped(req.user, { _id: req.params.id }));
  if (deleted === 0) return res.status(404).json({ error: "Lead not found" });
  res.status(204).end();
});

/** Admin: the WhatsApp template for this one lead. null clears it so the campaign message is used. */
leadsRouter.put("/:id/whatsapp", requireAdmin, async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: "Invalid id" });
  const lead = await Lead.findById(req.params.id);
  if (!lead) return res.status(404).json({ error: "Lead not found" });
  const templateId = req.body?.templateId ?? null;
  let template = null;
  if (templateId !== null) {
    if (!mongoose.isValidObjectId(templateId)) return res.status(400).json({ error: "Choose a WhatsApp template." });
    template = await Template.findOne({ _id: templateId, channel: "whatsapp" });
    if (!template) return res.status(400).json({ error: "Choose a WhatsApp template." });
  }
  lead.whatsappTemplateId = templateId;
  if (!(await saveLead(lead, res))) return;
  res.locals.audit = {
    label: template
      ? `Set the WhatsApp message for “${lead.businessName}” to “${template.name}”`
      : `Cleared the WhatsApp message on “${lead.businessName}”`,
    target: { type: "lead", id: String(lead._id), label: lead.businessName },
  };
  res.json(lead);
});

/**
 * After opening a WhatsApp chat, staff say what happened: "sent" logs the message (and marks the
 * number as on WhatsApp), "not_on_whatsapp" marks it as not on WhatsApp, "not_sent" records nothing.
 */
leadsRouter.post("/:id/whatsapp-result", async (req, res) => {
  const { result, text } = req.body ?? {};
  if (!["sent", "not_on_whatsapp", "not_sent"].includes(result)) {
    return res.status(400).json({ error: "result must be sent, not_on_whatsapp or not_sent" });
  }
  const lead = await Lead.findOne(scoped(req.user, { _id: req.params.id }), { _id: 1, businessName: 1 });
  if (!lead) return res.status(404).json({ error: "Lead not found" });
  const target = { type: "lead", id: String(lead._id), label: lead.businessName };
  if (result === "not_sent") {
    res.locals.audit = { action: "whatsapp.not_sent", label: "Opened WhatsApp but didn't send", target };
    return res.json({ ok: true });
  }
  const status = result === "sent" ? "yes" : "no";
  await Lead.updateOne({ _id: lead._id }, { $set: { whatsappStatus: status, whatsappCheckedAt: new Date(), whatsappCheckedBy: req.user.name } });
  const activity =
    result === "sent"
      ? await logActivity(lead._id, "whatsapp", String(text ?? "").trim().slice(0, 10000), req.user.name, req.user._id)
      : await logActivity(lead._id, "whatsapp_unavailable", "This number is not on WhatsApp.", req.user.name, req.user._id);
  res.locals.audit = {
    action: result === "sent" ? "whatsapp.sent" : "whatsapp.unavailable",
    label: result === "sent" ? "Sent a WhatsApp message" : "Marked a number as not on WhatsApp",
    target,
  };
  res.status(201).json(activity);
});

leadsRouter.post("/:id/activities", async (req, res) => {
  const { type, text } = req.body ?? {};
  if (!["note", "call", "email", "meeting", "whatsapp"].includes(type)) {
    return res.status(400).json({ error: "type must be note, call, email, meeting or whatsapp" });
  }
  if (type === "note" && !String(text ?? "").trim()) return res.status(400).json({ error: "A note needs some text." });
  const lead = await Lead.findOne(scoped(req.user, { _id: req.params.id }), { _id: 1 });
  if (!lead) return res.status(404).json({ error: "Lead not found" });
  if (type === "whatsapp") {
    await Lead.updateOne({ _id: lead._id }, { $set: { whatsappStatus: "yes", whatsappCheckedAt: new Date(), whatsappCheckedBy: req.user.name } });
  }
  res
    .status(201)
    .json(await logActivity(lead._id, type, String(text ?? "").trim().slice(0, 10000), req.user.name, req.user._id));
});
