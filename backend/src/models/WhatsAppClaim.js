import mongoose from "mongoose";

/**
 * One row per phone number that has had a WhatsApp chat opened. The unique key makes the claim
 * atomic: when two people (or two tabs) open the same number at once, only one insert succeeds.
 * Rows are never removed: each number gets one message in its lifetime.
 */
const whatsappClaimSchema = new mongoose.Schema(
  {
    // The lead's phoneKey, or `lead:<id>` for a lead whose phone has no usable key.
    key: { type: String, required: true, unique: true },
    leadId: { type: mongoose.Schema.Types.ObjectId, ref: "Lead", required: true, index: true },
    by: { type: String, default: null },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true },
);

export const WhatsAppClaim = mongoose.model("WhatsAppClaim", whatsappClaimSchema);

export const claimKey = (lead) => lead.phoneKey || `lead:${lead._id}`;
