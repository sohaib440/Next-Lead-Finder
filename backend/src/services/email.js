import nodemailer from "nodemailer";
import { Activity } from "../models/Activity.js";
import { Campaign, Recipient, SendCount, Suppression } from "../models/Campaign.js";
import { Lead } from "../models/Lead.js";
import { Sender } from "../models/Sender.js";
import { leadFilter } from "../routes/leads.js";
import { scoped } from "./access.js";
import { logActivity } from "./crm.js";
import { decryptSecret } from "./security.js";

/* ------------------------------- Templating ------------------------------ */

/** Merge fields available in subjects and bodies, e.g. {{businessName}} or {{firstName|there}}. */
export const MERGE_FIELDS = [
  "businessName", "firstName", "contactName", "contactRole", "category", "city", "country",
  "address", "phone", "email", "website", "senderName", "senderEmail", "signature",
];

function mergeContext(lead, sender) {
  const contactName = lead?.contactName ?? "";
  return {
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
    senderName: sender?.fromName ?? "",
    senderEmail: sender?.fromEmail ?? "",
    signature: sender?.signature ?? "",
  };
}

const MERGE_RE = /\{\{\s*(\w+)\s*(?:\|\s*([^}]*?)\s*)?\}\}/g;

export function renderText(template, ctx) {
  return String(template ?? "").replace(MERGE_RE, (match, key, fallback) =>
    key in ctx ? ctx[key] || fallback || "" : match,
  );
}

const escapeHtml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Plain text -> simple HTML: paragraphs, line breaks and clickable links. */
function textToHtml(text) {
  const linked = escapeHtml(text).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>');
  const paragraphs = linked.split(/\n{2,}/).map((p) => `<p style="margin:0 0 1em">${p.replace(/\n/g, "<br>")}</p>`);
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#222">${paragraphs.join("")}</div>`;
}

/** Renders a campaign email for one lead. The sender's signature is appended unless {{signature}} is used. */
export function renderEmail({ subject, body }, lead, sender) {
  const ctx = mergeContext(lead, sender);
  let text = renderText(body, ctx).trim();
  if (sender?.signature && !/\{\{\s*signature/.test(body ?? "")) text += `\n\n${sender.signature.trim()}`;
  return { subject: renderText(subject, ctx).replace(/\s+/g, " ").trim(), text, html: textToHtml(text) };
}

/** Merge fields used in the text that aren't known (likely typos). */
export function unknownFields(...texts) {
  const unknown = new Set();
  for (const t of texts) for (const [, key] of String(t ?? "").matchAll(MERGE_RE)) if (!MERGE_FIELDS.includes(key)) unknown.add(key);
  return [...unknown];
}

/* -------------------------------- Transport ------------------------------ */

const transports = new Map(); // senderId -> { stamp, transport }

function transportFor(sender) {
  const id = String(sender._id);
  const stamp = sender.updatedAt?.getTime() ?? 0;
  const cached = transports.get(id);
  if (cached?.stamp === stamp) return cached.transport;
  cached?.transport.close();
  const transport = nodemailer.createTransport({
    host: sender.host,
    port: sender.port,
    secure: sender.secure,
    auth: { user: sender.username, pass: decryptSecret(sender.password) },
    pool: true,
    maxConnections: 1,
    connectionTimeout: 20000,
    greetingTimeout: 15000,
    socketTimeout: 30000,
  });
  transports.set(id, { stamp, transport });
  return transport;
}

export function forgetTransport(senderId) {
  transports.get(String(senderId))?.transport.close();
  transports.delete(String(senderId));
}

/** `thread` = Message-IDs already sent to this person, so a follow-up lands in the same conversation. */
export async function sendMail(sender, to, rendered, thread = []) {
  const replyTo = sender.replyTo || sender.fromEmail;
  const info = await transportFor(sender).sendMail({
    from: { name: sender.fromName, address: sender.fromEmail },
    to,
    replyTo,
    subject: rendered.subject,
    text: rendered.text,
    html: rendered.html,
    headers: { "List-Unsubscribe": `<mailto:${replyTo}?subject=unsubscribe>` },
    ...(thread.length ? { inReplyTo: thread.at(-1), references: thread } : {}),
  });
  await SendCount.updateOne({ senderId: sender._id, day: localDay() }, { $inc: { count: 1 } }, { upsert: true });
  return info;
}

const localDay = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** Human-readable SMTP error. */
export function smtpError(err) {
  if (err.code === "EAUTH") return `Login failed — check the username and password (${err.response ?? err.message})`;
  if (["ECONNECTION", "ETIMEDOUT", "ESOCKET", "EDNS"].includes(err.code)) {
    return `Could not connect to the mail server — check host, port and security (${err.message})`;
  }
  return err.response ?? err.message;
}

/* --------------------------------- Audience ------------------------------ */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Works out who a campaign would email. Returns the leads to send to and, for every other
 * matching lead that has an address, why it is skipped.
 */
export async function resolveAudience(audience, options = {}, excludeCampaignId = null, user = null) {
  // A member's campaign can only reach leads that member can see.
  const filter = scoped(user, audience?.leadIds?.length ? { _id: { $in: audience.leadIds } } : leadFilter(audience?.query ?? {}));
  const leads = await Lead.find(filter, {
    businessName: 1, email: 1, stage: 1, contactName: 1, contactRole: 1, category: 1, city: 1, country: 1,
    address: 1, phone: 1, website: 1,
  }).limit(20000);

  const emails = [...new Set(leads.map((l) => l.email?.trim().toLowerCase()).filter(Boolean))];
  // Each address gets one campaign email, whoever sends it — this isn't optional.
  const [suppressed, emailedBefore] = await Promise.all([
    Suppression.find({ email: { $in: emails } }, { email: 1 }).then((r) => new Set(r.map((s) => s.email))),
    Recipient.distinct("email", {
      email: { $in: emails },
      status: "sent",
      ...(excludeCampaignId ? { campaignId: { $ne: excludeCampaignId } } : {}),
    }).then((r) => new Set(r)),
  ]);

  const send = [];
  const skipped = [];
  const seen = new Set();
  let noEmail = 0;
  for (const lead of leads) {
    const email = lead.email?.trim().toLowerCase();
    if (!email) {
      noEmail++;
      continue;
    }
    let reason = null;
    if (!EMAIL_RE.test(email)) reason = "Invalid email address";
    else if (seen.has(email)) reason = "Duplicate address in this campaign";
    else if (suppressed.has(email)) reason = "On the do-not-email list";
    else if (options.skipClosed !== false && ["won", "lost"].includes(lead.stage)) reason = `Lead is ${lead.stage}`;
    else if (emailedBefore.has(email)) reason = "Already emailed";
    seen.add(email);
    (reason ? skipped : send).push({ lead, email, reason });
  }
  return { matched: leads.length, noEmail, send, skipped };
}

/* ---------------------------------- Worker ------------------------------- */

const TICK_MS = 2000;
let busy = false;

const startOfTomorrow = () => {
  const d = new Date();
  d.setHours(24, 0, 0, 0);
  return d;
};

async function sentToday(senderId) {
  return (await SendCount.findOne({ senderId, day: localDay() }))?.count ?? 0;
}

const DAY_MS = 86400000;
const nextStepAt = (campaign, step, from = Date.now()) => {
  const next = campaign.followUps?.[step];
  return next ? new Date(from + next.delayDays * DAY_MS) : null;
};

/** Stops a recipient's sequence, e.g. because they replied or the deal closed. */
export const endSequence = (recipientId, extra = {}) =>
  Recipient.updateOne({ _id: recipientId }, { $set: { nextStepAt: null, ...extra } });

/** Sends the next follow-up to a recipient whose sequence is due. Returns false if nothing was sent. */
async function sendFollowUp(campaign, sender, recipient) {
  const lead = await Lead.findById(recipient.leadId);
  if (!lead || ["won", "lost"].includes(lead.stage) || (await Suppression.exists({ email: recipient.email }))) {
    await endSequence(recipient._id);
    return false;
  }
  // A reply logged by hand (or by the inbox watcher) since the first email also ends the sequence.
  if (await Activity.exists({ leadId: lead._id, type: "email_reply", createdAt: { $gte: recipient.sentAt } })) {
    await endSequence(recipient._id, { repliedAt: recipient.repliedAt ?? new Date() });
    return false;
  }
  const step = recipient.step + 1;
  const followUp = campaign.followUps[step - 1];
  const base = recipient.subject ?? renderEmail(campaign, lead, sender).subject;
  const subject = followUp.subject?.trim() ? followUp.subject : `Re: ${base.replace(/^re:\s*/i, "")}`;
  const rendered = renderEmail({ subject, body: followUp.body }, lead, sender);
  const info = await sendMail(sender, recipient.email, rendered, recipient.messageIds);
  await Recipient.updateOne(
    { _id: recipient._id },
    { $set: { step, nextStepAt: nextStepAt(campaign, step) }, $push: { messageIds: info.messageId } },
  );
  await Campaign.updateOne(
    { _id: campaign._id },
    { $inc: { followUpsSent: 1 }, lastError: null, statusText: `Follow-up ${step} sent to ${recipient.email}` },
  );
  await logActivity(lead._id, "email", `Campaign “${campaign.name}” — follow-up ${step}\nSubject: ${rendered.subject}`, `Campaign (${sender.fromEmail})`);
  return true;
}

async function sendNext(campaign) {
  const sender = campaign.senderId ? await Sender.findById(campaign.senderId) : null;
  if (!sender) {
    await Campaign.updateOne({ _id: campaign._id }, { status: "paused", statusText: "Paused — the sender account was deleted." });
    return;
  }
  if ((await sentToday(sender._id)) >= sender.dailyLimit) {
    await Campaign.updateOne(
      { _id: campaign._id },
      { nextSendAt: startOfTomorrow(), statusText: `Daily limit of ${sender.dailyLimit} emails reached for ${sender.fromEmail} — continues tomorrow.` },
    );
    return;
  }

  const jitter = 0.7 + Math.random() * 0.6;
  const nextSendAt = new Date(Date.now() + campaign.options.delaySeconds * 1000 * jitter);
  const recipient = await Recipient.findOne({ campaignId: campaign._id, status: "queued" }).sort({ createdAt: 1 });
  if (!recipient) {
    // First emails are all out: send due follow-ups, or wait for the next one.
    const due = await Recipient.findOne({ campaignId: campaign._id, status: "sent", nextStepAt: { $lte: new Date() } }).sort({ nextStepAt: 1 });
    if (due) {
      try {
        if (await sendFollowUp(campaign, sender, due)) await Campaign.updateOne({ _id: campaign._id }, { nextSendAt });
      } catch (err) {
        await handleSendError(campaign, sender, due, err, nextSendAt, true);
      }
      return;
    }
    const upcoming = await Recipient.findOne({ campaignId: campaign._id, status: "sent", nextStepAt: { $ne: null } }).sort({ nextStepAt: 1 });
    if (upcoming) {
      const waiting = await Recipient.countDocuments({ campaignId: campaign._id, status: "sent", nextStepAt: { $ne: null } });
      await Campaign.updateOne(
        { _id: campaign._id },
        {
          nextSendAt: upcoming.nextStepAt,
          statusText: `All first emails sent. ${waiting} follow-up${waiting === 1 ? "" : "s"} scheduled — they stop automatically for anyone who replies.`,
        },
      );
      return;
    }
    await Campaign.updateOne(
      { _id: campaign._id },
      {
        status: "completed",
        completedAt: new Date(),
        nextSendAt: null,
        statusText: `Finished — ${campaign.sent} emails and ${campaign.followUpsSent} follow-ups sent.`,
      },
    );
    return;
  }

  // Unsubscribes can arrive while a campaign is running.
  if (await Suppression.exists({ email: recipient.email })) {
    await Recipient.updateOne({ _id: recipient._id }, { status: "skipped", reason: "On the do-not-email list" });
    await Campaign.updateOne({ _id: campaign._id }, { $inc: { skipped: 1 } });
    return;
  }

  // Another campaign may have reached this address since this one was queued.
  if (await Recipient.exists({ email: recipient.email, status: "sent", campaignId: { $ne: campaign._id } })) {
    await Recipient.updateOne({ _id: recipient._id }, { status: "skipped", reason: "Already emailed" });
    await Campaign.updateOne({ _id: campaign._id }, { $inc: { skipped: 1 } });
    return;
  }

  const lead = await Lead.findById(recipient.leadId);
  if (!lead) {
    await Recipient.updateOne({ _id: recipient._id }, { status: "skipped", reason: "Lead was deleted" });
    await Campaign.updateOne({ _id: campaign._id }, { $inc: { skipped: 1 } });
    return;
  }

  const rendered = renderEmail(campaign, lead, sender);
  try {
    const info = await sendMail(sender, recipient.email, rendered);
    await Recipient.updateOne(
      { _id: recipient._id },
      {
        status: "sent",
        sentAt: new Date(),
        messageId: info.messageId,
        messageIds: [info.messageId],
        step: 0,
        nextStepAt: nextStepAt(campaign, 0),
        subject: rendered.subject,
        senderId: sender._id,
      },
    );
    await Campaign.updateOne(
      { _id: campaign._id },
      { $inc: { sent: 1 }, nextSendAt, lastError: null, statusText: `Sent to ${recipient.email}` },
    );
    await logActivity(lead._id, "email", `Campaign “${campaign.name}”\nSubject: ${rendered.subject}`, `Campaign (${sender.fromEmail})`);
  } catch (err) {
    await handleSendError(campaign, sender, recipient, err, nextSendAt, false, rendered.subject);
  }
}

async function handleSendError(campaign, sender, recipient, err, nextSendAt, isFollowUp, subject = null) {
  const message = smtpError(err);
  // Login or connection problems affect every email: pause instead of failing the whole list.
  if (["EAUTH", "ECONNECTION", "ETIMEDOUT", "ESOCKET", "EDNS"].includes(err.code)) {
    forgetTransport(sender._id);
    await Campaign.updateOne({ _id: campaign._id }, { status: "paused", lastError: message, statusText: `Paused — ${message}` });
    return;
  }
  if (isFollowUp) await endSequence(recipient._id, { reason: `Follow-up failed: ${message}` });
  else await Recipient.updateOne({ _id: recipient._id }, { status: "failed", reason: message, subject, senderId: sender._id });
  await Campaign.updateOne({ _id: campaign._id }, { ...(isFollowUp ? {} : { $inc: { failed: 1 } }), nextSendAt, lastError: message });
  // A permanent rejection of the address (5xx) means it should not be tried again.
  if (err.responseCode >= 550 && err.responseCode < 560) {
    await Suppression.updateOne({ email: recipient.email }, { $setOnInsert: { reason: "bounced" } }, { upsert: true });
  }
}

async function tick() {
  if (busy) return;
  busy = true;
  try {
    const due = await Campaign.find({
      status: "sending",
      $or: [{ nextSendAt: null }, { nextSendAt: { $lte: new Date() } }],
    }).sort({ nextSendAt: 1 });
    for (const campaign of due) await sendNext(campaign);
  } catch (err) {
    console.error("[mailer]", err);
  } finally {
    busy = false;
  }
}

/** Sends queued campaign emails in the background. Campaigns left "sending" resume after a restart. */
export function startMailer() {
  setInterval(tick, TICK_MS).unref();
}
