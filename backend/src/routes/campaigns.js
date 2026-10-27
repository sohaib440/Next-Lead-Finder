import { Router } from "express";
import mongoose from "mongoose";
import { Campaign, Recipient, Suppression } from "../models/Campaign.js";
import { Lead } from "../models/Lead.js";
import { Sender } from "../models/Sender.js";
import { renderEmail, resolveAudience, sendMail, smtpError, unknownFields } from "../services/email.js";
import { recordReply } from "../services/replies.js";
import { isAdmin, requirePermission, scoped } from "../services/access.js";

/** A campaign the user may open: their own, or any for admins. */
const findCampaign = (req) => Campaign.findOne({ _id: req.params.id, ...(isAdmin(req.user) ? {} : { createdBy: req.user._id }) });

export const campaignsRouter = Router();
campaignsRouter.use(requirePermission("campaigns", "Email campaigns are turned off for your account."));
export const suppressionsRouter = Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const QUERY_KEYS = ["q", "country", "city", "category", "tag", "stage", "priority", "searchId", "has", "missing"];

/** Keeps only lead-filter params (or valid lead ids) from a client-supplied audience. */
function cleanAudience(audience = {}) {
  const leadIds = Array.isArray(audience.leadIds) ? audience.leadIds.filter((id) => mongoose.isValidObjectId(id)) : [];
  if (leadIds.length) return { leadIds, label: String(audience.label ?? `${leadIds.length} selected leads`) };
  const query = {};
  for (const key of QUERY_KEYS) {
    const value = audience.query?.[key];
    if (value !== undefined && value !== null && value !== "") query[key] = Array.isArray(value) ? value.join(",") : String(value);
  }
  return { query, label: String(audience.label ?? "All leads") };
}

function cleanOptions(options = {}) {
  const delay = Number(options.delaySeconds);
  return {
    delaySeconds: Number.isFinite(delay) ? Math.min(3600, Math.max(5, Math.round(delay))) : 45,
    skipEmailedBefore: true,
    skipClosed: options.skipClosed !== false,
  };
}

/** Applies editable draft fields from a request body. */
function applyDraft(campaign, body) {
  if ("name" in body) campaign.name = String(body.name ?? "").trim() || "Untitled campaign";
  if ("senderId" in body) campaign.senderId = mongoose.isValidObjectId(body.senderId) ? body.senderId : null;
  if ("subject" in body) campaign.subject = String(body.subject ?? "");
  if ("body" in body) campaign.body = String(body.body ?? "");
  if ("audience" in body) campaign.audience = cleanAudience(body.audience);
  if ("options" in body) campaign.options = cleanOptions(body.options);
  if ("followUps" in body) {
    campaign.followUps = (Array.isArray(body.followUps) ? body.followUps : []).slice(0, 5).map((f) => ({
      delayDays: Math.min(60, Math.max(1, Math.round(Number(f?.delayDays) || 3))),
      subject: String(f?.subject ?? ""),
      body: String(f?.body ?? ""),
    }));
  }
}

/** A lead to render previews with: the one asked for, else the first one the campaign would email. */
async function sampleLead(leadId, audience, options, user) {
  if (leadId && mongoose.isValidObjectId(leadId)) {
    const lead = await Lead.findOne(scoped(user, { _id: leadId }));
    if (lead) return lead;
  }
  if (!audience) return null;
  const { send } = await resolveAudience(cleanAudience(audience), cleanOptions(options), null, user);
  return send[0]?.lead ?? null;
}

campaignsRouter.get("/", async (req, res) => {
  res.json(await Campaign.find(isAdmin(req.user) ? {} : { createdBy: req.user._id }).sort({ createdAt: -1 }).limit(500));
});

campaignsRouter.post("/", async (req, res) => {
  const campaign = new Campaign({ name: "Untitled campaign", createdBy: req.user._id });
  applyDraft(campaign, req.body ?? {});
  await campaign.save();
  res.status(201).json(campaign);
});

// How many leads an audience reaches, and why the rest are skipped.
campaignsRouter.post("/audience", async (req, res) => {
  const { send, skipped, matched, noEmail } = await resolveAudience(
    cleanAudience(req.body?.audience),
    cleanOptions(req.body?.options),
    mongoose.isValidObjectId(req.body?.campaignId) ? req.body.campaignId : null,
    req.user,
  );
  const reasons = {};
  for (const s of skipped) reasons[s.reason] = (reasons[s.reason] ?? 0) + 1;
  res.json({
    matched,
    noEmail,
    willSend: send.length,
    skipped: Object.entries(reasons).map(([reason, count]) => ({ reason, count })),
    sample: send.slice(0, 25).map((s) => ({ leadId: String(s.lead._id), businessName: s.lead.businessName, email: s.email })),
  });
});

campaignsRouter.post("/preview", async (req, res) => {
  const body = req.body ?? {};
  const [sender, lead] = await Promise.all([
    mongoose.isValidObjectId(body.senderId) ? Sender.findById(body.senderId) : null,
    sampleLead(body.leadId, body.audience, body.options, req.user),
  ]);
  res.json({
    ...renderEmail({ subject: body.subject, body: body.body }, lead, sender),
    lead: lead ? { id: String(lead._id), businessName: lead.businessName, email: lead.email } : null,
    unknownFields: unknownFields(body.subject, body.body),
  });
});

// Sends one rendered email (using a sample lead's data) to the given address.
campaignsRouter.post("/test", async (req, res) => {
  const body = req.body ?? {};
  const sender = mongoose.isValidObjectId(body.senderId) ? await Sender.findById(body.senderId) : null;
  if (!sender) return res.status(400).json({ error: "Choose a sender account first." });
  const to = String(body.to ?? "").trim();
  if (!EMAIL_RE.test(to)) return res.status(400).json({ error: "Enter a valid address to send the test to." });
  const lead = await sampleLead(body.leadId, body.audience, body.options, req.user);
  const rendered = renderEmail({ subject: body.subject, body: body.body }, lead, sender);
  if (!rendered.subject || !rendered.text) return res.status(400).json({ error: "Write a subject and body first." });
  try {
    await sendMail(sender, to, { ...rendered, subject: `[TEST] ${rendered.subject}` });
    res.json({ ok: true, to, lead: lead?.businessName ?? null });
  } catch (err) {
    res.status(400).json({ error: smtpError(err) });
  }
});

campaignsRouter.get("/:id", async (req, res) => {
  const campaign = await findCampaign(req);
  if (!campaign) return res.status(404).json({ error: "Campaign not found" });
  const recipients = await Recipient.find({ campaignId: campaign._id }).sort({ createdAt: 1 }).limit(20000);
  res.json({ campaign, recipients });
});

campaignsRouter.put("/:id", async (req, res) => {
  const campaign = await findCampaign(req);
  if (!campaign) return res.status(404).json({ error: "Campaign not found" });
  // Content can still be fixed while paused; the audience is fixed once sending starts.
  if (campaign.status !== "draft" && campaign.status !== "paused") {
    return res.status(409).json({ error: "Only draft or paused campaigns can be edited." });
  }
  const body = { ...req.body };
  if (campaign.status === "paused") delete body.audience;
  applyDraft(campaign, body);
  await campaign.save();
  res.json(campaign);
});

campaignsRouter.delete("/:id", async (req, res) => {
  const campaign = await findCampaign(req);
  if (!campaign) return res.status(404).json({ error: "Campaign not found" });
  if (campaign.status === "sending") return res.status(409).json({ error: "Pause or cancel the campaign before deleting it." });
  await Recipient.deleteMany({ campaignId: campaign._id });
  await campaign.deleteOne();
  res.status(204).end();
});

campaignsRouter.post("/:id/start", async (req, res) => {
  const campaign = await findCampaign(req);
  if (!campaign) return res.status(404).json({ error: "Campaign not found" });
  if (campaign.status !== "draft") return res.status(409).json({ error: "This campaign has already been started." });

  const errors = {};
  const sender = campaign.senderId ? await Sender.findById(campaign.senderId) : null;
  if (!sender) errors.senderId = "Choose a sender account.";
  if (!campaign.subject.trim()) errors.subject = "Enter a subject line.";
  if (!campaign.body.trim()) errors.body = "Write the email body.";
  const unknown = unknownFields(campaign.subject, campaign.body, ...campaign.followUps.flatMap((f) => [f.subject, f.body]));
  if (unknown.length) errors.body = `Unknown merge field${unknown.length > 1 ? "s" : ""}: ${unknown.map((f) => `{{${f}}}`).join(", ")}`;
  campaign.followUps.forEach((f, i) => {
    if (!f.body.trim()) errors[`followUp${i}`] = `Follow-up ${i + 1} has no message.`;
  });
  if (Object.keys(errors).length) return res.status(400).json({ error: "The campaign isn't ready to send.", errors });

  const { send, skipped } = await resolveAudience(campaign.audience, campaign.options, campaign._id, req.user);
  if (!send.length) return res.status(400).json({ error: "Nobody in this audience can be emailed." });

  const row = (s, status) => ({
    campaignId: campaign._id,
    leadId: s.lead._id,
    businessName: s.lead.businessName,
    email: s.email,
    status,
    reason: s.reason ?? null,
  });
  await Recipient.insertMany([...send.map((s) => row(s, "queued")), ...skipped.map((s) => row(s, "skipped"))]);
  campaign.set({
    status: "sending",
    total: send.length,
    skipped: skipped.length,
    startedAt: new Date(),
    nextSendAt: null,
    statusText: `Sending to ${send.length} businesses…`,
  });
  await campaign.save();
  res.json(campaign);
});

function transition(from, to, statusText) {
  return async (req, res) => {
    const campaign = await findCampaign(req);
    if (!campaign) return res.status(404).json({ error: "Campaign not found" });
    if (!from.includes(campaign.status)) return res.status(409).json({ error: `The campaign is ${campaign.status}.` });
    campaign.set({ status: to, statusText, ...(to === "sending" ? { nextSendAt: null, lastError: null } : {}) });
    if (to === "cancelled") {
      const result = await Recipient.updateMany(
        { campaignId: campaign._id, status: "queued" },
        { status: "skipped", reason: "Campaign cancelled" },
      );
      await Recipient.updateMany({ campaignId: campaign._id, nextStepAt: { $ne: null } }, { nextStepAt: null });
      campaign.skipped += result.modifiedCount;
      campaign.completedAt = new Date();
    }
    await campaign.save();
    res.json(campaign);
  };
}

campaignsRouter.post("/:id/pause", transition(["sending"], "paused", "Paused."));
campaignsRouter.post("/:id/resume", transition(["paused"], "sending", "Resuming…"));
campaignsRouter.post("/:id/cancel", transition(["sending", "paused"], "cancelled", "Cancelled — unsent emails were skipped."));

// Record a reply by hand (e.g. they answered by phone): stops their follow-ups.
campaignsRouter.post("/:id/recipients/:rid/replied", async (req, res) => {
  const campaign = await findCampaign(req);
  const recipient = campaign && (await Recipient.findOne({ _id: req.params.rid, campaignId: campaign._id }));
  if (!recipient) return res.status(404).json({ error: "Recipient not found" });
  await recordReply(recipient, { text: String(req.body?.note ?? "").trim() || "Marked as replied", by: req.user.name, manual: true });
  res.json(await Recipient.findById(recipient._id));
});

// Do-not-email list.
suppressionsRouter.get("/", async (_req, res) => {
  res.json(await Suppression.find().sort({ createdAt: -1 }).limit(5000));
});

suppressionsRouter.post("/", async (req, res) => {
  const emails = (Array.isArray(req.body?.emails) ? req.body.emails : [req.body?.email])
    .map((e) => String(e ?? "").trim().toLowerCase())
    .filter((e) => EMAIL_RE.test(e));
  if (!emails.length) return res.status(400).json({ error: "Enter at least one valid email address." });
  const reason = String(req.body?.reason ?? "manual");
  await Suppression.bulkWrite(
    emails.map((email) => ({ updateOne: { filter: { email }, update: { $setOnInsert: { email, reason } }, upsert: true } })),
  );
  res.status(201).json({ added: emails.length });
});

suppressionsRouter.delete("/:email", async (req, res) => {
  const result = await Suppression.deleteOne({ email: String(req.params.email).toLowerCase() });
  if (result.deletedCount === 0) return res.status(404).json({ error: "Address not on the list" });
  res.status(204).end();
});
