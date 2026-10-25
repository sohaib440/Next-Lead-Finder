import mongoose from "mongoose";
import { Search } from "./Search.js";
import { phoneType } from "../services/phone.js";
import { keysFor } from "./leadKeys.js";
import { computeOpportunity } from "./opportunity.js";

export const BUSINESS_STATUSES = ["open", "closed_temporarily", "closed_permanently"];

export const LEAD_STAGES = ["new", "contacted", "qualified", "proposal", "won", "lost"];
export const LEAD_PRIORITIES = ["low", "medium", "high"];

const leadSchema = new mongoose.Schema(
  {
    businessName: { type: String, required: true, trim: true },
    category: { type: String, default: "" },
    country: { type: String, default: "" },
    city: { type: String, default: "" },
    address: { type: String, default: null },
    phone: { type: String, default: null },
    email: { type: String, default: null },
    website: { type: String, default: null },
    source: { type: String, default: "" },
    // Google Business Profile link (Maps listing).
    sourceUrl: { type: String, default: null },
    placeId: { type: String, default: null },
    // The search that first saved the lead, and every search that has found it since.
    searchId: { type: mongoose.Schema.Types.ObjectId, ref: "Search", index: true },
    searchIds: { type: [{ type: mongoose.Schema.Types.ObjectId, ref: "Search" }], index: true, default: [] },
    // From Google: refreshed whenever a search or enrich job sees the listing again.
    rating: { type: Number, default: null },
    reviewCount: { type: Number, default: null },
    businessStatus: { type: String, enum: [...BUSINESS_STATUSES, null], default: null },
    lat: { type: Number, default: null },
    lng: { type: Number, default: null },
    // From the business website (see scraper/email_finder.py inspect_site).
    socials: { type: mongoose.Schema.Types.Mixed, default: undefined },
    audit: { type: mongoose.Schema.Types.Mixed, default: null },
    // 0–100 sales potential for web & marketing services, with the reasons (opportunity.js).
    opportunity: { type: Number, default: 0, index: true },
    opportunityReasons: { type: [String], default: undefined },
    // CRM fields — never touched by the scraper once a lead exists.
    stage: { type: String, enum: LEAD_STAGES, default: "new", index: true },
    priority: { type: String, enum: LEAD_PRIORITIES, default: "medium", index: true },
    // The WhatsApp template assigned to this lead. Set from its campaign, or chosen for this lead alone.
    whatsappTemplateId: { type: mongoose.Schema.Types.ObjectId, ref: "Template", default: null },
    // WhatsApp: "yes" / "no" once someone tried to message the number, else "unknown".
    whatsappStatus: { type: String, enum: ["unknown", "yes", "no"], default: "unknown", index: true },
    whatsappCheckedAt: { type: Date, default: null },
    whatsappCheckedBy: { type: String, default: null },
    // mobile | landline | unknown | none, worked out from the number (refreshScores keeps it current).
    phoneType: { type: String, enum: ["mobile", "landline", "unknown", "none"], default: "unknown", index: true },
    // Pinned leads stay at the top of the list and the pipeline for everyone who can see them.
    pinned: { type: Boolean, default: false, index: true },
    pinnedAt: { type: Date, default: null },
    tags: { type: [String], default: [], index: true },
    contactName: { type: String, default: null, trim: true },
    contactRole: { type: String, default: null, trim: true },
    dealValue: { type: Number, default: null, min: 0 },
    lastContactedAt: { type: Date, default: null },
    stageChangedAt: { type: Date, default: null },
    // 0–100 data-completeness score, kept in sync by refreshScores().
    score: { type: Number, default: 0, index: true },
    // Normalised duplicate-matching keys (see leadKeys.js), kept in sync on every save.
    emailKey: { type: String, default: null, index: true },
    phoneKey: { type: String, default: null, index: true },
    domainKey: { type: String, default: null, index: true },
    nameKey: { type: String, default: null, index: true },
    // Duplicate-finder groups someone marked "not duplicates" (sorted id lists).
    mergeIgnore: { type: [String], default: undefined },
    // The staff member responsible for this lead (members always see leads assigned to them).
    assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null, index: true },
    // The import that created the lead, if any.
    importId: { type: mongoose.Schema.Types.ObjectId, ref: "Import", default: null, index: true },
    // Lowercased "name|city" — one lead per business per city, mirroring the UI's dedupe rule.
    dedupeKey: { type: String, required: true, unique: true },
  },
  {
    timestamps: true,
    toJSON: {
      transform(_doc, ret) {
        ret.id = String(ret._id);
        if (ret.whatsappTemplateId) ret.whatsappTemplateId = String(ret.whatsappTemplateId);
        ret.dateAdded = ret.createdAt;
        delete ret._id;
        delete ret.__v;
        delete ret.dedupeKey;
        delete ret.emailKey;
        delete ret.phoneKey;
        delete ret.domainKey;
        delete ret.nameKey;
        delete ret.mergeIgnore;
        return ret;
      },
    },
  },
);

export function dedupeKeyFor(businessName, city) {
  return `${businessName.trim().toLowerCase()}|${(city ?? "").trim().toLowerCase()}`;
}

leadSchema.index({ placeId: 1 });

leadSchema.pre("validate", function () {
  const keys = keysFor(this);
  this.set({ ...keys, placeId: keys.placeId ?? this.placeId });
});

export const Lead = mongoose.model("Lead", leadSchema);

/** Recomputes match keys for leads changed with updateOne/updateMany (which skip save hooks). */
export async function refreshKeys(filter) {
  const leads = await Lead.find(filter, { businessName: 1, city: 1, email: 1, phone: 1, website: 1, placeId: 1, sourceUrl: 1 });
  if (!leads.length) return;
  await Lead.bulkWrite(
    leads.map((l) => {
      const keys = keysFor(l);
      return { updateOne: { filter: { _id: l._id }, update: { $set: { ...keys, placeId: keys.placeId ?? l.placeId } } } };
    }),
  );
}

const filled = (field) => ({ $cond: [{ $gt: [{ $strLenCP: { $ifNull: [`$${field}`, ""] } }, 0] }, 1, 0] });
const SCORE_WEIGHTS = { email: 30, phone: 25, website: 20, contactName: 10, address: 10, sourceUrl: 5 };

/** Recomputes the completeness score and the opportunity score for every lead matching `filter`. */
export async function refreshScores(filter = {}) {
  const score = { $add: Object.entries(SCORE_WEIGHTS).map(([f, w]) => ({ $multiply: [filled(f), w] })) };
  await Lead.updateMany(filter, [{ $set: { score } }]);
  const leads = await Lead.find(filter, { website: 1, audit: 1, rating: 1, reviewCount: 1, businessStatus: 1, phone: 1, email: 1, country: 1 });
  if (leads.length) {
    await Lead.bulkWrite(
      leads.map((l) => ({
        updateOne: { filter: { _id: l._id }, update: { $set: { ...computeOpportunity(l), phoneType: phoneType(l.phone, l.country) } } },
      })),
    );
  }
}

const PLACE_ID_RE = /!19s(ChIJ[\w-]+)/;

/** One-off upgrades for leads saved by earlier versions. */
export async function migrateLeads() {
  await Lead.updateMany({ searchIds: { $exists: false } }, [{ $set: { searchIds: ["$searchId"] } }]);
  await Lead.updateMany({ searchIds: { $size: 0 }, searchId: { $ne: null } }, [{ $set: { searchIds: ["$searchId"] } }]);

  await Lead.updateMany({ stage: { $exists: false } }, { $set: { stage: "new", priority: "medium", tags: [] } });
  await refreshScores({ score: { $exists: false } });
  await refreshKeys({ nameKey: { $exists: false } });
  await refreshScores({ opportunityReasons: { $exists: false } });
  await refreshScores({ phoneType: { $exists: false } });
  await Lead.updateMany({ whatsappStatus: { $exists: false } }, { $set: { whatsappStatus: "unknown" } });

  // Copy each campaign's WhatsApp template onto its leads that don't have one of their own yet.
  const withMessage = await Search.find({ whatsappTemplateId: { $ne: null } }, { whatsappTemplateId: 1 });
  for (const search of withMessage) {
    await Lead.updateMany(
      {
        $and: [
          { $or: [{ searchIds: search._id }, { searchId: search._id }] },
          { whatsappTemplateId: null },
        ],
      },
      { $set: { whatsappTemplateId: search.whatsappTemplateId } },
    );
  }

  // Long Maps URLs -> short, stable Google Business Profile links.
  const longUrls = await Lead.find({ sourceUrl: /!19sChIJ/ }, { sourceUrl: 1 });
  if (longUrls.length) {
    await Lead.bulkWrite(
      longUrls.map((l) => {
        const placeId = l.sourceUrl.match(PLACE_ID_RE)[1];
        return {
          updateOne: {
            filter: { _id: l._id },
            update: { $set: { placeId, sourceUrl: `https://www.google.com/maps/place/?q=place_id:${placeId}` } },
          },
        };
      }),
    );
  }
}
