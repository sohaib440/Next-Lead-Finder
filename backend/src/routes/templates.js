import { Router } from "express";
import { Template } from "../models/Template.js";
import { isAdmin } from "../services/access.js";

/** Members can't create, change or delete WhatsApp templates: the admin controls the format. */
function adminForWhatsApp(req, res, channel) {
  if (channel === "whatsapp" && !isAdmin(req.user)) {
    res.status(403).json({ error: "Only an admin can change WhatsApp message formats." });
    return false;
  }
  return true;
}
import { MERGE_FIELDS, unknownFields } from "../services/email.js";

export const templatesRouter = Router();

function validate(body) {
  const errors = {};
  if (!String(body.name ?? "").trim()) errors.name = "Give the template a name.";
  if (body.channel !== "whatsapp" && !String(body.subject ?? "").trim()) errors.subject = "Enter a subject line.";
  if (!String(body.body ?? "").trim()) errors.body = body.channel === "whatsapp" ? "Write the WhatsApp message." : "Write the email body.";
  const unknown = unknownFields(body.subject, body.body);
  if (unknown.length) errors.body = `Unknown merge field${unknown.length > 1 ? "s" : ""}: ${unknown.map((f) => `{{${f}}}`).join(", ")}`;
  return errors;
}

templatesRouter.get("/", async (_req, res) => {
  res.json(await Template.find().sort({ updatedAt: -1 }));
});

templatesRouter.get("/fields", (_req, res) => {
  res.json(MERGE_FIELDS);
});

templatesRouter.post("/", async (req, res) => {
  const body = req.body ?? {};
  if (!adminForWhatsApp(req, res, body.channel)) return;
  const errors = validate(body);
  if (Object.keys(errors).length) return res.status(400).json({ error: "Invalid template", errors });
  const template = await Template.create({
    name: String(body.name).trim(),
    channel: body.channel === "whatsapp" ? "whatsapp" : "email",
    subject: body.channel === "whatsapp" ? "" : String(body.subject ?? "").trim(),
    body: String(body.body),
  });
  res.status(201).json(template);
});

templatesRouter.put("/:id", async (req, res) => {
  const template = await Template.findById(req.params.id);
  if (!template) return res.status(404).json({ error: "Template not found" });
  if (!adminForWhatsApp(req, res, template.channel)) return;
  const body = { ...template.toObject(), ...req.body };
  const errors = validate(body);
  if (Object.keys(errors).length) return res.status(400).json({ error: "Invalid template", errors });
  template.set({
    name: String(body.name).trim(),
    subject: template.channel === "whatsapp" ? "" : String(body.subject ?? "").trim(),
    body: String(body.body),
  });
  await template.save();
  res.json(template);
});

templatesRouter.delete("/:id", async (req, res) => {
  const template = await Template.findById(req.params.id);
  if (!template) return res.status(404).json({ error: "Template not found" });
  if (!adminForWhatsApp(req, res, template.channel)) return;
  await template.deleteOne();
  res.status(204).end();
});
