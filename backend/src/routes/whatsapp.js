import { Router } from "express";
import mongoose from "mongoose";
import { Lead } from "../models/Lead.js";
import { getSettings } from "../models/Settings.js";
import { alreadyMessagedText, renderWhatsApp, whatsappSent } from "../services/whatsapp.js";
import { templateSummary, whatsappFormats } from "../services/whatsappFormat.js";
import { scoped } from "../services/access.js";
import { leadFilter } from "./leads.js";

export const whatsappRouter = Router();

/** The admin's WhatsApp message for a lead, already personalised, and whether this user must use it. */
whatsappRouter.get("/format/:leadId", async (req, res) => {
  const lead = mongoose.isValidObjectId(req.params.leadId) ? await Lead.findOne(scoped(req.user, { _id: req.params.leadId })) : null;
  if (!lead) return res.status(404).json({ error: "Lead not found" });
  const [{ formats, mustUse }, settings, sent] = await Promise.all([
    whatsappFormats([lead], req.user),
    getSettings(),
    whatsappSent([lead]),
  ]);
  const format = formats.get(String(lead._id));
  const already = sent.get(String(lead._id));
  res.json({
    template: templateSummary(format.template),
    source: format.source,
    mustUse,
    alreadyMessaged: already ? { ...already, message: alreadyMessagedText(already) } : null,
    preview: format.template ? renderWhatsApp(format.template.body, lead, req.user, settings.defaultCountry) : null,
  });
});

// One lead: the message as it will open in WhatsApp. Staff who must use the admin's format get it
// regardless of what they send. A number already messaged gets no chat link; `preview` still
// returns the text (for template previews).
whatsappRouter.post("/render", async (req, res) => {
  const { leadId, body, preview } = req.body ?? {};
  if (!mongoose.isValidObjectId(leadId)) return res.status(400).json({ error: "Invalid lead" });
  const lead = await Lead.findOne(scoped(req.user, { _id: leadId }));
  if (!lead) return res.status(404).json({ error: "Lead not found" });
  const already = (await whatsappSent([lead])).get(String(lead._id));
  if (already && !preview) return res.status(409).json({ error: alreadyMessagedText(already), code: "already_messaged" });
  const [settings, { formats, mustUse }] = await Promise.all([getSettings(), whatsappFormats([lead], req.user)]);
  const format = formats.get(String(lead._id));
  if (mustUse && !format.template) {
    return res.status(400).json({ error: "Your admin hasn't set a WhatsApp message for this campaign yet.", code: "no_format" });
  }
  const text = mustUse ? format.template.body : String(body ?? "");
  const rendered = renderWhatsApp(text, lead, req.user, settings.defaultCountry);
  res.json({ ...rendered, ...(already ? { url: null } : {}), templateName: mustUse ? format.template.name : null });
});

/**
 * A send queue: every lead in the audience that has a phone, with its personal chat link. Numbers
 * already messaged on WhatsApp (by anyone, on any lead) are always left out.
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

  const sent = await whatsappSent(leads);

  // Each lead gets its own campaign's message when formats are required (staff) or chosen (admin).
  const { formats, mustUse } = await whatsappFormats(leads, req.user);
  const useFormats = mustUse || body.useFormats === true;

  const seen = new Set();
  const items = leads
    .filter((lead) => {
      // One message per number, also when two leads in this list share it.
      if (sent.get(String(lead._id))) return false;
      if (!lead.phoneKey) return true;
      if (seen.has(lead.phoneKey)) return false;
      seen.add(lead.phoneKey);
      return true;
    })
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
        lastMessagedAt: null,
        whatsappStatus: lead.whatsappStatus,
        phoneType: lead.phoneType,
        ...rendered,
      };
    });
  res.json({ total: items.length, mustUse, useFormats, items });
});
