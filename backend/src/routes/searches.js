import { Router } from "express";
import { config } from "../config.js";
import { Lead } from "../models/Lead.js";
import { CONTACT_TYPES, Search, WEBSITE_FILTERS } from "../models/Search.js";
import { getSettings } from "../models/Settings.js";
import mongoose from "mongoose";
import { requireAdmin } from "../middleware/auth.js";
import { User } from "../models/User.js";
import { grantAccess, isAdmin, scoped, searchScope } from "../services/access.js";
import { deleteLeads } from "../services/crm.js";
import { activeUsers } from "../services/distribute.js";
import { notify } from "../services/notify.js";

/** The search, if the user may see it. */
const findSearch = (req) => Search.findOne({ $and: [{ _id: req.params.id }, searchScope(req.user)] });
/** Only admins run, control or delete searches. */
const ownsSearch = (req) => isAdmin(req.user);
import { decryptSecret } from "../services/security.js";
import { assignCampaignWhatsapp } from "../services/whatsappFormat.js";
import { cancelScrape, isActive, pauseScrape, resumeScrape, startScrape } from "../services/scrapeRunner.js";

export const searchesRouter = Router();

searchesRouter.get("/", async (req, res) => {
  const searches = await Search.find(searchScope(req.user)).sort({ createdAt: -1 }).limit(500);
  res.json(searches);
});

// Finding new leads is for admins only; members work the searches an admin shares with them.
searchesRouter.post("/", requireAdmin, async (req, res) => {
  const body = req.body ?? {};
  const niche = String(body.niche ?? "").trim();
  const country = String(body.country ?? "").trim();
  const city = String(body.city ?? "").trim() || null;
  const keyword = String(body.keyword ?? "").trim() || null;
  const maxResults = Number(body.maxResults ?? 100);
  const contactTypes = Array.isArray(body.contactTypes)
    ? body.contactTypes.filter((t) => CONTACT_TYPES.includes(t))
    : [];

  // Older clients send onlyWithWebsites instead of websiteFilter.
  const websiteFilter = body.websiteFilter ?? (body.onlyWithWebsites ? "with" : "any");

  const errors = {};
  if (!WEBSITE_FILTERS.includes(websiteFilter)) errors.websiteFilter = "Website filter must be any, with or without.";
  if (!niche) errors.niche = "Please enter a business niche.";
  if (!country) errors.country = "Please select a target country.";
  if (contactTypes.length === 0) errors.contact = "Select at least one type of contact information.";
  if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > 5000) {
    errors.maxResults = "Maximum results must be between 1 and 5000.";
  }
  if (Object.keys(errors).length) return res.status(400).json({ error: "Invalid search", errors });

  const search = await Search.create({
    name: `${niche} — ${country}${city ? ` (${city})` : ""}${websiteFilter === "without" ? " · no website" : ""}`,
    niche,
    country,
    city,
    keyword,
    maxResults,
    contactTypes,
    websiteFilter,
    onlyWithWebsites: websiteFilter === "with",
    createdBy: req.user._id,
    // Optional: hand each new lead to these staff in turn as it's found.
    autoDistribute: {
      userIds: (await activeUsers((Array.isArray(body.autoDistributeTo) ? body.autoDistributeTo : []).filter((id) => mongoose.isValidObjectId(id)))).map((u) => u._id),
      cursor: 0,
    },
  });
  // Members see the leads their own searches find.
  await grantAccess(req.user, { searchId: search._id });
  const settings = await getSettings();
  startScrape(search, {
    source: settings.leadSource,
    placesApiKey: decryptSecret(settings.googlePlacesApiKey) || config.placesApiKey,
  });
  res.status(201).json(search);
});

searchesRouter.delete("/:id", async (req, res) => {
  const search = await findSearch(req);
  if (!search) return res.status(404).json({ error: "Search not found" });
  if (!ownsSearch(req)) return res.status(403).json({ error: "Only an admin can delete a search." });
  if (isActive(search._id)) return res.status(409).json({ error: "Cancel the search before deleting it." });
  await Lead.updateMany({ searchIds: search._id }, { $pull: { searchIds: search._id } });
  // ?withLeads=true also removes leads that no other search has found.
  // Leads someone has started working (moved past "new") are always kept.
  const deletedLeads =
    req.query.withLeads === "true"
      ? await deleteLeads({ searchId: search._id, searchIds: { $size: 0 }, stage: "new" })
      : 0;
  await search.deleteOne();
  res.json({ deletedLeads });
});

// Admin: the WhatsApp message staff send to this campaign's leads (null = workspace default).
searchesRouter.put("/:id/whatsapp", requireAdmin, async (req, res) => {
  const search = await Search.findById(req.params.id);
  if (!search) return res.status(404).json({ error: "Search not found" });
  const templateId = req.body?.templateId ?? null;
  if (templateId !== null) {
    const { Template } = await import("../models/Template.js");
    if (!mongoose.isValidObjectId(templateId) || !(await Template.exists({ _id: templateId, channel: "whatsapp" }))) {
      return res.status(400).json({ error: "Choose a WhatsApp template." });
    }
  }
  const leadsAssigned = await assignCampaignWhatsapp(search, templateId);
  res.locals.audit = {
    label: templateId
      ? `Set the WhatsApp message for “${search.name}” and assigned it to ${leadsAssigned} lead${leadsAssigned === 1 ? "" : "s"}`
      : `Removed the WhatsApp message from “${search.name}”`,
    target: { type: "search", id: String(search._id), label: search.name },
  };
  res.json({ ...search.toJSON(), leadsAssigned });
});

// Admin: staff who receive this search's new leads in turn ([] = off).
searchesRouter.put("/:id/distribution", requireAdmin, async (req, res) => {
  const search = await Search.findById(req.params.id);
  if (!search) return res.status(404).json({ error: "Search not found" });
  const users = await activeUsers((Array.isArray(req.body?.userIds) ? req.body.userIds : []).filter((id) => mongoose.isValidObjectId(id)));
  search.set("autoDistribute.userIds", users.map((u) => u._id));
  await search.save();
  res.json(search);
});

// Admin: which members can see this search's leads (replaces the current list).
searchesRouter.put("/:id/access", requireAdmin, async (req, res) => {
  const search = await Search.findById(req.params.id);
  if (!search) return res.status(404).json({ error: "Search not found" });
  const userIds = (Array.isArray(req.body?.userIds) ? req.body.userIds : []).filter((id) => mongoose.isValidObjectId(id));
  const newlyShared = await User.find({ _id: { $in: userIds }, "access.searchIds": { $ne: search._id } }, { _id: 1 });
  await User.updateMany({ _id: { $in: userIds } }, { $addToSet: { "access.searchIds": search._id } });
  await notify(newlyShared.map((u) => u._id), {
    type: "campaign_shared",
    title: `New campaign shared with you: ${search.name}`,
    body: `${search.leadsFound} leads · by ${req.user.name}`,
    link: `/leads?searchId=${search._id}`,
  });
  await User.updateMany({ _id: { $nin: userIds } }, { $pull: { "access.searchIds": search._id } });
  res.locals.audit = { label: `Shared search “${search.name}” with ${userIds.length} staff`, target: { type: "search", id: String(search._id), label: search.name } };
  res.json({ userIds });
});

searchesRouter.get("/:id", async (req, res) => {
  const search = await findSearch(req);
  if (!search) return res.status(404).json({ error: "Search not found" });
  const preview = await Lead.find(scoped(req.user, { searchIds: search._id })).sort({ updatedAt: -1 }).limit(8);
  res.json({ search, preview });
});

function control(action, nextStatus, statusText) {
  return async (req, res) => {
    const search = await findSearch(req);
    if (!search) return res.status(404).json({ error: "Search not found" });
    if (!ownsSearch(req)) return res.status(403).json({ error: "Only an admin can control a search." });
    if (!isActive(search._id) || !action(search._id)) {
      return res.status(409).json({ error: "This search is no longer running." });
    }
    if (nextStatus) {
      search.status = nextStatus;
      search.statusText = statusText;
      await search.save();
    }
    res.json(search);
  };
}

searchesRouter.post("/:id/pause", control(pauseScrape, "paused", "Paused — press Resume to continue."));
searchesRouter.post("/:id/resume", control(resumeScrape, "running", "Resuming…"));
// Final status is written by the runner once the scraper process has exited.
searchesRouter.post("/:id/cancel", control(cancelScrape, null, null));
