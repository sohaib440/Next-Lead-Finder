import mongoose from "mongoose";
import { Activity } from "../models/Activity.js";
import { Lead } from "../models/Lead.js";
import { WhatsAppClaim, claimKey } from "../models/WhatsAppClaim.js";
import { renderText } from "./email.js";
import { callingCode, likelyMobile, whatsappNumber } from "./phone.js";

/**
 * WhatsApp outreach through click-to-chat links (https://wa.me/<number>?text=…). Free and needs no
 * API: the message opens prefilled in WhatsApp Web / the app, and the user presses send.
 */

export { callingCode, likelyMobile, whatsappNumber };

export function renderWhatsApp(body, lead, user, fallbackCountry) {
  const contactName = lead?.contactName ?? "";
  const ctx = {
    businessName: lead?.businessName ?? "",
    firstName: contactName.split(/\s+/)[0] ?? "",
    contactName,
    contactRole: lead?.contactRole ?? "",
    category: lead?.category ?? "",
    city: lead?.city ?? "",
    country: lead?.country ?? "",
    address: lead?.address ?? "",
    phone: lead?.phone ?? "",
    email: lead?.email ?? "",
    website: lead?.website ?? "",
    senderName: user?.name ?? "",
    senderEmail: user?.email ?? "",
    signature: "",
  };
  const text = renderText(body, ctx).trim();
  const number = whatsappNumber(lead?.phone, lead?.country, fallbackCountry);
  return {
    text,
    number,
    likelyMobile: likelyMobile(number),
    url: number ? `https://wa.me/${number}?text=${encodeURIComponent(text)}` : null,
  };
}

/**
 * Each phone number gets one WhatsApp message, whoever sends it. For every lead, the first message
 * logged to its number (on it or on any other lead with the same number), else null.
 */
export async function whatsappSent(leads) {
  const keys = [...new Set(leads.map((l) => l.phoneKey).filter(Boolean))];
  const sameNumber = keys.length ? await Lead.find({ phoneKey: { $in: keys } }, { phoneKey: 1 }) : [];
  const keyOf = new Map(sameNumber.map((l) => [String(l._id), l.phoneKey]));
  const ids = [...new Set([...leads.map((l) => String(l._id)), ...keyOf.keys()])];
  const sent = await Activity.aggregate([
    { $match: { leadId: { $in: ids.map((id) => new mongoose.Types.ObjectId(id)) }, type: "whatsapp" } },
    { $sort: { createdAt: 1 } },
    { $group: { _id: "$leadId", at: { $first: "$createdAt" }, by: { $first: "$by" } } },
    { $sort: { at: 1 } },
  ]);
  const byLead = new Map();
  const byKey = new Map();
  for (const a of sent) {
    const first = { at: a.at, by: a.by };
    byLead.set(String(a._id), first);
    const key = keyOf.get(String(a._id));
    if (key && !byKey.has(key)) byKey.set(key, first);
  }
  // A chat already opened on the number counts too, even before its sender says it went through.
  const claims = await WhatsAppClaim.find({ key: { $in: [...new Set(leads.map(claimKey))] } }, { key: 1, by: 1, createdAt: 1 });
  const byClaim = new Map(claims.map((c) => [c.key, { at: c.createdAt, by: c.by }]));
  return new Map(
    leads.map((l) => [
      String(l._id),
      byLead.get(String(l._id)) ?? (l.phoneKey && byKey.get(l.phoneKey)) ?? byClaim.get(claimKey(l)) ?? null,
    ]),
  );
}

/**
 * Reserves the lead's number for this user before WhatsApp opens. Returns null when reserved, or
 * who already messaged / is messaging the number.
 */
export async function claimWhatsApp(lead, user) {
  const already = (await whatsappSent([lead])).get(String(lead._id));
  if (already) return already;
  try {
    await WhatsAppClaim.create({ key: claimKey(lead), leadId: lead._id, by: user?.name ?? null, userId: user?._id ?? null });
    return null;
  } catch (err) {
    if (err?.code !== 11000) throw err;
    const claim = await WhatsAppClaim.findOne({ key: claimKey(lead) });
    return { at: claim?.createdAt ?? new Date(), by: claim?.by ?? null };
  }
}

export const alreadyMessagedText = (sent) =>
  `This number was already messaged on WhatsApp${sent.by ? ` by ${sent.by}` : ""} — each number gets one message.`;
