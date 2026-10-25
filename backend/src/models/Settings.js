import mongoose from "mongoose";
import { decryptSecret } from "../services/security.js";

export const LEAD_SOURCES = ["auto", "google_maps", "google_places"];

// Single-document collection holding workspace settings.
const settingsSchema = new mongoose.Schema(
  {
    _id: { type: String, default: "workspace" },
    profileName: { type: String, default: "My Workspace", trim: true },
    profileEmail: { type: String, default: "", trim: true },
    defaultCountry: { type: String, default: "United States" },
    defaultResultLimit: { type: Number, default: 100, min: 1, max: 5000 },
    rowsPerPage: { type: Number, default: 25, enum: [10, 25, 50, 100] },
    compactTable: { type: Boolean, default: false },
    // ISO 4217 code used to display deal values.
    currency: { type: String, default: "USD", uppercase: true, trim: true, match: /^[A-Z]{3}$/ },
    // WhatsApp message for leads whose campaign has none, and whether staff must send the admin's message.
    defaultWhatsappTemplateId: { type: mongoose.Schema.Types.ObjectId, ref: "Template", default: null },
    whatsappStaffMustUseFormat: { type: Boolean, default: true },
    defaultPhone: { type: Boolean, default: true },
    defaultEmail: { type: Boolean, default: true },
    defaultWebsite: { type: Boolean, default: true },
    defaultOnlyWithWebsites: { type: Boolean, default: false },
    defaultWebsiteFilter: { type: String, enum: ["any", "with", "without"], default: "any" },
    leadSource: { type: String, enum: LEAD_SOURCES, default: "auto" },
    googlePlacesApiKey: { type: String, default: "" },
  },
  {
    timestamps: true,
    toJSON: {
      transform(_doc, ret) {
        // The key is write-only from the API's point of view.
        if (ret.defaultWhatsappTemplateId) ret.defaultWhatsappTemplateId = String(ret.defaultWhatsappTemplateId);
        ret.hasPlacesApiKey = Boolean(ret.googlePlacesApiKey);
        ret.placesApiKeyHint = ret.googlePlacesApiKey ? `••••${decryptSecret(ret.googlePlacesApiKey).slice(-4)}` : null;
        delete ret.googlePlacesApiKey;
        delete ret._id;
        delete ret.__v;
        return ret;
      },
    },
  },
);

export const Settings = mongoose.model("Settings", settingsSchema);

/** One-off upgrade: carry the old "only with websites" default over to defaultWebsiteFilter. */
export async function migrateSettings() {
  await Settings.collection.updateOne({ _id: "workspace", defaultWebsiteFilter: { $exists: false } }, [
    { $set: { defaultWebsiteFilter: { $cond: [{ $eq: ["$defaultOnlyWithWebsites", true] }, "with", "any"] } } },
  ]);
}

export async function getSettings() {
  return (await Settings.findById("workspace")) ?? (await Settings.create({ _id: "workspace" }));
}
