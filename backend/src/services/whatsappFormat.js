import { Lead } from "../models/Lead.js";
import { Search } from "../models/Search.js";
import { getSettings } from "../models/Settings.js";
import { Template } from "../models/Template.js";
import { isAdmin } from "./access.js";

/** Every campaign id stored on a lead, including the original searchId from older records. */
function leadSearchIds(lead) {
  const ids = (lead.searchIds ?? []).map(String);
  if (lead.searchId) ids.push(String(lead.searchId));
  return [...new Set(ids)];
}

/**
 * The WhatsApp message for each lead, in order:
 * the template assigned to that lead, then the newest campaign it belongs to that has one,
 * then the workspace default.
 *
 * Returns { formats: Map<leadId, { template, source }>, mustUse } where mustUse says whether this
 * user has to send exactly that message (members, when "staff must use the admin's message" is on).
 */
export async function whatsappFormats(leads, user) {
  const settings = await getSettings();
  const searchIds = [...new Set(leads.flatMap(leadSearchIds))];
  const searches = searchIds.length
    ? await Search.find({ _id: { $in: searchIds }, whatsappTemplateId: { $ne: null } }, { name: 1, whatsappTemplateId: 1, createdAt: 1 }).sort({ createdAt: -1 })
    : [];
  const templateIds = [
    ...new Set(
      [
        ...leads.map((l) => (l.whatsappTemplateId ? String(l.whatsappTemplateId) : null)),
        ...searches.map((s) => String(s.whatsappTemplateId)),
        settings.defaultWhatsappTemplateId ? String(settings.defaultWhatsappTemplateId) : null,
      ].filter(Boolean),
    ),
  ];
  const templates = new Map(
    (await Template.find({ _id: { $in: templateIds }, channel: "whatsapp" })).map((t) => [String(t._id), t]),
  );
  const fallback = settings.defaultWhatsappTemplateId ? templates.get(String(settings.defaultWhatsappTemplateId)) : null;

  const formats = new Map();
  for (const lead of leads) {
    const ownTemplate = lead.whatsappTemplateId ? templates.get(String(lead.whatsappTemplateId)) : null;
    if (ownTemplate) {
      formats.set(String(lead._id), { template: ownTemplate, source: "This lead" });
      continue;
    }
    const own = new Set(leadSearchIds(lead));
    // Searches are sorted newest first, so the first match is the most recent campaign.
    const search = searches.find((s) => own.has(String(s._id)) && templates.has(String(s.whatsappTemplateId)));
    if (search) formats.set(String(lead._id), { template: templates.get(String(search.whatsappTemplateId)), source: search.name });
    else if (fallback) formats.set(String(lead._id), { template: fallback, source: "Default message" });
    else formats.set(String(lead._id), { template: null, source: null });
  }
  return { formats, mustUse: !isAdmin(user) && settings.whatsappStaffMustUseFormat !== false };
}

/**
 * Saves a campaign's WhatsApp template and copies it onto that campaign's leads.
 * A lead that already has a different message of its own is left alone.
 * Returns how many leads were updated.
 */
export async function assignCampaignWhatsapp(search, templateId) {
  const previous = search.whatsappTemplateId ? String(search.whatsappTemplateId) : null;
  const next = templateId ? String(templateId) : null;
  search.whatsappTemplateId = next;
  await search.save();

  const inCampaign = { $or: [{ searchIds: search._id }, { searchId: search._id }] };
  if (next) {
    const replace = [{ whatsappTemplateId: null }, { whatsappTemplateId: { $exists: false } }];
    if (previous && previous !== next) replace.push({ whatsappTemplateId: previous });
    const result = await Lead.updateMany({ $and: [inCampaign, { $or: replace }] }, { $set: { whatsappTemplateId: next } });
    return result.modifiedCount ?? 0;
  }
  if (previous) {
    const result = await Lead.updateMany(
      { $and: [inCampaign, { whatsappTemplateId: previous }] },
      { $set: { whatsappTemplateId: null } },
    );
    return result.modifiedCount ?? 0;
  }
  return 0;
}

export const templateSummary = (t) => (t ? { id: String(t._id), name: t.name, body: t.body } : null);
