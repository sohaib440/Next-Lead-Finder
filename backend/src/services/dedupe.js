import { Activity } from "../models/Activity.js";
import { Recipient } from "../models/Campaign.js";
import { LEAD_STAGES, Lead, refreshKeys, refreshScores } from "../models/Lead.js";
import { MATCH_KEYS, keysFor } from "../models/leadKeys.js";
import { Task } from "../models/Task.js";
import { logActivity } from "./crm.js";

export const DEFAULT_MATCH_ON = MATCH_KEYS.map((k) => k.key);
const labelOf = (key) => MATCH_KEYS.find((k) => k.key === key)?.label ?? key;

/**
 * Looks up existing leads sharing any enabled key with the given key sets.
 * Returns find(keys) -> { lead, by } | null.
 */
export async function existingMatcher(keySets, matchOn = DEFAULT_MATCH_ON) {
  const values = Object.fromEntries(matchOn.map((k) => [k, new Set()]));
  for (const keys of keySets) for (const k of matchOn) if (keys[k]) values[k].add(keys[k]);
  const or = matchOn.filter((k) => values[k].size).map((k) => ({ [k]: { $in: [...values[k]] } }));
  const leads = or.length
    ? await Lead.find({ $or: or }, { businessName: 1, city: 1, country: 1, email: 1, phone: 1, website: 1, stage: 1, ...Object.fromEntries(matchOn.map((k) => [k, 1])) })
    : [];

  const index = Object.fromEntries(matchOn.map((k) => [k, new Map()]));
  for (const lead of leads) for (const k of matchOn) if (lead[k] && !index[k].has(lead[k])) index[k].set(lead[k], lead);

  return (keys) => {
    for (const k of matchOn) {
      const lead = keys[k] && index[k].get(keys[k]);
      if (lead) return { lead, by: k };
    }
    return null;
  };
}

/** Index for rows seen earlier in the same file. */
export function fileMatcher(matchOn = DEFAULT_MATCH_ON) {
  const index = Object.fromEntries(matchOn.map((k) => [k, new Map()]));
  return {
    find(keys) {
      for (const k of matchOn) {
        const hit = keys[k] && index[k].get(keys[k]);
        if (hit !== undefined && hit !== null && keys[k]) return { row: hit, by: k };
      }
      return null;
    },
    add(keys, row) {
      for (const k of matchOn) if (keys[k] && !index[k].has(keys[k])) index[k].set(keys[k], row);
    },
  };
}

export { labelOf as matchLabel };

/* --------------------------- Duplicates in the DB -------------------------- */

/** Groups of existing leads that share a match key (connected via any key). */
export async function findDuplicateGroups(matchOn = DEFAULT_MATCH_ON) {
  const leads = await Lead.find({}, {
    businessName: 1, category: 1, city: 1, country: 1, address: 1, phone: 1, email: 1, website: 1, sourceUrl: 1,
    stage: 1, tags: 1, score: 1, dealValue: 1, source: 1, createdAt: 1, contactName: 1, mergeIgnore: 1,
    ...Object.fromEntries(matchOn.map((k) => [k, 1])),
  }).sort({ createdAt: 1 });

  // Union-find over lead ids.
  const parent = new Map(leads.map((l) => [String(l._id), String(l._id)]));
  const root = (id) => {
    while (parent.get(id) !== id) {
      parent.set(id, parent.get(parent.get(id)));
      id = parent.get(id);
    }
    return id;
  };
  const reasons = new Map(); // root -> Set of key labels
  for (const k of matchOn) {
    const first = new Map();
    for (const l of leads) {
      const v = l[k];
      if (!v) continue;
      const id = String(l._id);
      if (first.has(v)) {
        const a = root(first.get(v));
        const b = root(id);
        if (a !== b) parent.set(b, a);
        const r = root(a);
        if (!reasons.has(r)) reasons.set(r, new Set());
        reasons.get(r).add(labelOf(k));
      } else first.set(v, id);
    }
  }

  const groups = new Map();
  for (const l of leads) {
    const r = root(String(l._id));
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(l);
  }
  // Re-collect reasons after all unions (roots may have moved).
  const reasonByRoot = new Map();
  for (const [r, set] of reasons) {
    const rr = root(r);
    if (!reasonByRoot.has(rr)) reasonByRoot.set(rr, new Set());
    for (const s of set) reasonByRoot.get(rr).add(s);
  }

  return [...groups.entries()]
    .filter(([, members]) => members.length > 1)
    // Groups someone marked "not duplicates" stay hidden until their membership changes.
    .filter(([, members]) => {
      const ids = members.map((m) => String(m._id)).sort().join(",");
      return !members.every((m) => (m.mergeIgnore ?? []).includes(ids));
    })
    .map(([r, members]) => ({
      id: members.map((m) => String(m._id)).sort().join(","),
      matchedBy: [...(reasonByRoot.get(r) ?? [])],
      leads: members.map((m) => m.toJSON()),
    }))
    .sort((a, b) => b.leads.length - a.leads.length);
}

/* ---------------------------------- Merge ---------------------------------- */

const FILL_FIELDS = ["category", "country", "city", "address", "phone", "email", "website", "sourceUrl", "placeId", "contactName", "contactRole"];

/**
 * Merges `duplicateIds` into `primaryId`: fills the primary's empty fields, combines tags and
 * search history, moves notes, tasks and campaign history over, then deletes the duplicates.
 */
export async function mergeLeads(primaryId, duplicateIds, by) {
  const primary = await Lead.findById(primaryId);
  if (!primary) throw Object.assign(new Error("Lead not found"), { status: 404 });
  const dups = await Lead.find({ _id: { $in: duplicateIds.filter((id) => String(id) !== String(primary._id)) } });
  if (!dups.length) return primary;

  for (const d of dups) {
    for (const f of FILL_FIELDS) if (!primary[f] && d[f]) primary[f] = d[f];
    if (primary.dealValue == null && d.dealValue != null) primary.dealValue = d.dealValue;
    if (!primary.whatsappTemplateId && d.whatsappTemplateId) primary.whatsappTemplateId = d.whatsappTemplateId;
    if (d.lastContactedAt && (!primary.lastContactedAt || d.lastContactedAt > primary.lastContactedAt)) {
      primary.lastContactedAt = d.lastContactedAt;
    }
    // Keep the most progressed stage, but never let a "lost" duplicate close an open lead.
    if (primary.stage === "new" && d.stage !== "new") primary.stage = d.stage;
    else if (d.stage !== "lost" && primary.stage !== "lost" && LEAD_STAGES.indexOf(d.stage) > LEAD_STAGES.indexOf(primary.stage)) {
      primary.stage = d.stage;
    }
  }
  primary.tags = [...new Set([...primary.tags, ...dups.flatMap((d) => d.tags)])];
  primary.searchIds = [...new Map([...primary.searchIds, ...dups.flatMap((d) => d.searchIds)].map((id) => [String(id), id])).values()];
  primary.mergeIgnore = [];

  const dupIds = dups.map((d) => d._id);
  await Promise.all([
    Activity.updateMany({ leadId: { $in: dupIds } }, { leadId: primary._id }),
    Task.updateMany({ leadId: { $in: dupIds } }, { leadId: primary._id }),
    Recipient.updateMany({ leadId: { $in: dupIds } }, { leadId: primary._id }),
  ]);
  await Lead.deleteMany({ _id: { $in: dupIds } });
  await primary.save();
  await Promise.all([refreshScores({ _id: primary._id }), refreshKeys({ _id: primary._id })]);
  await logActivity(primary._id, "note", `Merged ${dups.length} duplicate${dups.length > 1 ? "s" : ""}: ${dups.map((d) => d.businessName).join(", ")}`, by);
  return Lead.findById(primary._id);
}

export { keysFor };
