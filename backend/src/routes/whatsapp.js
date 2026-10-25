import { Router } from "express";
import mongoose from "mongoose";
import { Activity } from "../models/Activity.js";
import { Lead } from "../models/Lead.js";
import { getSettings } from "../models/Settings.js";
import { renderWhatsApp } from "../services/whatsapp.js";
import { templateSummary, whatsappFormats } from "../services/whatsappFormat.js";
import { scoped } from "../services/access.js";
import { leadFilter } from "./leads.js";

export const whatsappRouter = Router();

/** The admin's WhatsApp message for a lead, already personalised, and whether this user must use it. */
whatsappRouter.get("/format/:leadId", async (req, res) => {
  const lead = mongoose.isValidObjectId(req.params.leadId) ? await Lead.findOne(scoped(req.user, { _id: req.params.leadId })) : null;
  if (!lead) return res.status(404).json({ error: "Lead not found" });
  const [{ formats, mustUse }, settings] = await Promise.all([whatsappFormats([lead], req.user), getSettings()]);
  const format = formats.get(String(lead._id));
  res.json({
    template: templateSummary(format.template),
    source: format.source,
    mustUse,
    preview: format.template ? renderWhatsApp(format.template.body, lead, req.user, settings.defaultCountry) : null,
  });
});

// One lead: the message as it will open in WhatsApp. Staff who must use the admin's format get it
// regardless of what they send.
whatsappRouter.post("/render", async (req, res) => {
  const { leadId, body } = req.body ?? {};
  if (!mongoose.isValidObjectId(leadId)) return res.status(400).json({ error: "Invalid lead" });
  const lead = await Lead.findOne(scoped(req.user, { _id: leadId }));
  if (!lead) return res.status(404).json({ error: "Lead not found" });
  const [settings, { formats, mustUse }] = await Promise.all([getSettings(), whatsappFormats([lead], req.user)]);
  const format = formats.get(String(lead._id));
  if (mustUse && !format.template) {
    return res.status(400).json({ error: "Your admin hasn't set a WhatsApp message for this campaign yet.", code: "no_format" });
  }
  const text = mustUse ? format.template.body : String(body ?? "");
  res.json({ ...renderWhatsApp(text, lead, req.user, settings.defaultCountry), templateName: mustUse ? format.template.name : null });
});

/**
 * A send queue: every lead in the audience that has a phone, with its personal chat link and
 * when it was last messaged on WhatsApp (so nobody gets the same message twice).
 */
whatsappRouter.post("/queue", async (req, res) => {
  const body = req.body ?? {};
  const ids = Array.isArray(body.leadIds) ? body.leadIds.filter((id) => mongoose.isValidObjectId(id)) : [];
  const base = { ...(ids.length ? { _id: { $in: ids } } : leadFilter(body.query ?? {})), phone: { $nin: [null, ""] } };
  if (body.skipClosed !== false) base.stage = { $nin: ["won", "lost"] };
  if (body.skipNoWhatsapp !== false) base.whatsappStatus = { $ne: "no" };
  if (body.skipLandlines === true) base.phoneType = { $ne: "landline" };
  const filter = scoped(req.user, base);
  const [leads, settings] = await Promise.all([Lead.find(filter).sort({ opportunity: -1, createdAt: 1 }).limit(2000), getSettings()]);

  const last = await Activity.aggregate([
    { $match: { leadId: { $in: leads.map((l) => l._id) }, type: "whatsapp" } },
    { $group: { _id: "$leadId", at: { $max: "$createdAt" } } },
  ]);
  const lastBy = new Map(last.map((a) => [String(a._id), a.at]));

  // Each lead gets its own campaign's message when formats are required (staff) or chosen (admin).
  const { formats, mustUse } = await whatsappFormats(leads, req.user);
  const useFormats = mustUse || body.useFormats === true;

  const items = leads
    .map((lead) => {
      const format = formats.get(String(lead._id));
      const text = useFormats ? format.template?.body : String(body.body ?? "");
      const rendered = text
        ? renderWhatsApp(text, lead, req.user, settings.defaultCountry)
        : { text: "", number: null, likelyMobile: null, url: null };
      return {
        templateName: useFormats ? (format.template?.name ?? null) : null,
        source: useFormats ? format.source : null,
        reason: useFormats && !format.template ? "No WhatsApp message set for this lead" : null,
        leadId: String(lead._id),
        businessName: lead.businessName,
        city: lead.city,
        phone: lead.phone,
        stage: lead.stage,
        opportunity: lead.opportunity,
        lastMessagedAt: lastBy.get(String(lead._id)) ?? null,
        whatsappStatus: lead.whatsappStatus,
        phoneType: lead.phoneType,
        ...rendered,
      };
    })
    .filter((i) => !(body.onlyNotMessaged !== false && i.lastMessagedAt));
  res.json({ total: items.length, mustUse, useFormats, items });
});
