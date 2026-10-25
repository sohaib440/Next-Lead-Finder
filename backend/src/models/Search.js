import mongoose from "mongoose";

export const SEARCH_STATUSES = ["running", "paused", "completed", "cancelled", "failed"];
export const CONTACT_TYPES = ["phone", "email", "website"];
/** any: every business · with: only those listing a website · without: only those with no website. */
export const WEBSITE_FILTERS = ["any", "with", "without"];

const searchSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    // The WhatsApp message (template) an admin chose for this campaign's leads.
    whatsappTemplateId: { type: mongoose.Schema.Types.ObjectId, ref: "Template", default: null },
    // New leads found by this search are assigned to these staff in turn (cursor = next turn).
    autoDistribute: {
      userIds: { type: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }], default: [] },
      cursor: { type: Number, default: 0 },
    },
    niche: { type: String, required: true, trim: true },
    country: { type: String, required: true, trim: true },
    city: { type: String, default: null },
    keyword: { type: String, default: null },
    maxResults: { type: Number, required: true, min: 1, max: 5000 },
    contactTypes: [{ type: String, enum: CONTACT_TYPES }],
    websiteFilter: { type: String, enum: WEBSITE_FILTERS, default: "any" },
    // Legacy flag kept in sync with websiteFilter === "with".
    onlyWithWebsites: { type: Boolean, default: false },
    status: { type: String, enum: SEARCH_STATUSES, default: "running", index: true },
    source: { type: String, default: null },
    progress: { type: Number, default: 0 },
    statusText: { type: String, default: "Starting…" },
    leadsFound: { type: Number, default: 0 },
    duplicatesSkipped: { type: Number, default: 0 },
    phonesFound: { type: Number, default: 0 },
    emailsFound: { type: Number, default: 0 },
    durationSeconds: { type: Number, default: null },
    error: { type: String, default: null },
  },
  {
    timestamps: true,
    toJSON: {
      transform(_doc, ret) {
        ret.id = String(ret._id);
        if (ret.whatsappTemplateId) ret.whatsappTemplateId = String(ret.whatsappTemplateId);
        ret.date = ret.createdAt;
        delete ret._id;
        delete ret.__v;
        return ret;
      },
    },
  },
);

export const Search = mongoose.model("Search", searchSchema);

/** One-off upgrade: searches saved before websiteFilter existed. */
export async function migrateSearches() {
  await Search.collection.updateMany({ websiteFilter: { $exists: false } }, [
    { $set: { websiteFilter: { $cond: [{ $eq: ["$onlyWithWebsites", true] }, "with", "any"] } } },
  ]);
}
