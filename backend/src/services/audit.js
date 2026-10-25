import { AuditLog } from "../models/AuditLog.js";
import { Lead } from "../models/Lead.js";
import { clientIp } from "../middleware/auth.js";

/** Writes one audit entry; never throws (tracking must not break the request). */
export async function logAudit(entry) {
  try {
    await AuditLog.create(entry);
  } catch (err) {
    console.error("[audit]", err.message);
  }
}

const SECRET_KEYS = /pass(word)?|secret|token|apikey|api_key|googleplacesapikey/i;

/** Request body as stored in the log: no secrets, no spreadsheets, short strings. */
function sanitize(value, depth = 0) {
  if (value == null || depth > 3) return undefined;
  if (typeof value === "string") return value.length > 300 ? `${value.slice(0, 300)}…` : value;
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) return value.length > 20 ? `${value.length} items` : value.map((v) => sanitize(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (SECRET_KEYS.test(k)) out[k] = "••••";
    else if (k === "rows") out[k] = Array.isArray(v) ? `${v.length} rows` : undefined;
    else out[k] = sanitize(v, depth + 1);
  }
  return out;
}

const STAGE_LABELS = { new: "New", contacted: "Contacted", qualified: "Qualified", proposal: "Proposal", won: "Won", lost: "Lost" };
const count = (body) => (Array.isArray(body?.ids) ? body.ids.length : 0);

/**
 * Human-readable descriptions of API calls: [method, path pattern, action code, label(body, match)].
 * The first match wins. Unlisted changes are still logged with a generic label.
 */
const ROUTES = [
  ["POST", /^\/leads$/, "lead.create", (b) => `Added lead “${b?.businessName ?? ""}”`],
  ["PATCH", /^\/leads\/(\w{24})$/, "lead.update", (b) => (b?.stage ? `Moved lead to ${STAGE_LABELS[b.stage] ?? b.stage}` : typeof b?.pinned === "boolean" && Object.keys(b).length === 1 ? (b.pinned ? "Pinned lead" : "Unpinned lead") : b?.priority && Object.keys(b).length === 1 ? `Set lead priority to ${b.priority}` : b?.tags ? "Changed lead tags" : `Edited lead (${Object.keys(b ?? {}).join(", ")})`)],
  ["DELETE", /^\/leads\/(\w{24})$/, "lead.delete", () => "Deleted lead"],
  ["POST", /^\/leads\/(\w{24})\/activities$/, "lead.activity", (b) => ({ note: "Added a note", call: "Logged a call", email: "Logged an email", meeting: "Logged a meeting", whatsapp: "Sent a WhatsApp message" })[b?.type] ?? "Logged activity"],
  ["POST", /^\/leads\/bulk-update$/, "leads.bulk", (b) => (b?.stage ? `Moved ${count(b)} leads to ${STAGE_LABELS[b.stage] ?? b.stage}` : `Updated ${count(b)} leads`)],
  ["POST", /^\/leads\/bulk-delete$/, "leads.delete", (b) => `Deleted ${count(b)} leads`],
  ["POST", /^\/leads\/(\w{24})\/whatsapp-result$/, "whatsapp.result", (b) => (b?.result === "sent" ? "Sent a WhatsApp message" : b?.result === "not_on_whatsapp" ? "Marked a number as not on WhatsApp" : "Opened WhatsApp but didn't send")],
  ["PUT", /^\/leads\/(\w{24})\/whatsapp$/, "lead.whatsapp", () => "Set a lead's WhatsApp message"],
  ["POST", /^\/leads\/assign$/, "leads.assign", (b) => `Assigned ${count(b)} leads`],
  ["POST", /^\/leads\/distribute$/, "leads.distribute", (b) => (b?.preview ? "Previewed a lead distribution" : "Distributed leads to staff")],
  ["PUT", /^\/searches\/(\w{24})\/distribution$/, "search.distribution", () => "Changed a campaign's auto-assignment"],
  ["POST", /^\/leads\/enrich$/, "leads.enrich", () => "Started a website & rating check"],
  ["POST", /^\/leads\/merge$/, "leads.merge", () => "Merged duplicate leads"],
  ["DELETE", /^\/leads$/, "leads.delete_all", () => "Deleted ALL leads"],
  ["POST", /^\/tasks$/, "task.create", (b) => `Added task “${b?.title ?? ""}”`],
  ["PATCH", /^\/tasks\/(\w{24})$/, "task.update", (b) => (b?.done === true ? "Completed a task" : b?.done === false ? "Reopened a task" : "Edited a task")],
  ["DELETE", /^\/tasks\/(\w{24})$/, "task.delete", () => "Deleted a task"],
  ["POST", /^\/searches$/, "search.start", (b) => `Started search “${b?.niche ?? ""} in ${[b?.city, b?.country].filter(Boolean).join(", ")}”`],
  ["POST", /^\/searches\/(\w{24})\/(pause|resume|cancel)$/, "search.control", (_b, m) => `${{ pause: "Paused", resume: "Resumed", cancel: "Cancelled" }[m[2]]} a search`],
  ["DELETE", /^\/searches\/(\w{24})$/, "search.delete", () => "Deleted a search"],
  ["POST", /^\/campaigns$/, "campaign.create", () => "Created an email campaign"],
  ["PUT", /^\/campaigns\/(\w{24})$/, "campaign.update", () => "Edited an email campaign"],
  ["POST", /^\/campaigns\/(\w{24})\/start$/, "campaign.start", () => "Started sending an email campaign"],
  ["POST", /^\/campaigns\/(\w{24})\/(pause|resume|cancel)$/, "campaign.control", (_b, m) => `${{ pause: "Paused", resume: "Resumed", cancel: "Cancelled" }[m[2]]} an email campaign`],
  ["POST", /^\/campaigns\/test$/, "campaign.test", (b) => `Sent a test email to ${b?.to ?? ""}`],
  ["DELETE", /^\/campaigns\/(\w{24})$/, "campaign.delete", () => "Deleted an email campaign"],
  ["POST", /^\/imports$/, "import.run", (b) => `Imported “${b?.filename ?? "a file"}” (${Array.isArray(b?.rows) ? b.rows.length : 0} rows)`],
  ["POST", /^\/imports\/analyze$/, "import.check", (b) => `Checked a file for duplicates (${Array.isArray(b?.rows) ? b.rows.length : 0} rows)`],
  ["DELETE", /^\/imports\/(\w{24})$/, "import.undo", () => "Undid an import"],
  ["POST", /^\/exports$/, "export.file", (b) => `Downloaded ${b?.format?.toUpperCase() ?? ""} export “${b?.filename ?? ""}” (${b?.count ?? 0} leads)`],
  ["POST", /^\/whatsapp\/queue$/, "whatsapp.queue", () => "Built a WhatsApp send list"],
  ["POST", /^\/templates$/, "template.create", (b) => `Created template “${b?.name ?? ""}”`],
  ["PUT", /^\/templates\/(\w{24})$/, "template.update", () => "Edited a template"],
  ["DELETE", /^\/templates\/(\w{24})$/, "template.delete", () => "Deleted a template"],
  ["POST", /^\/senders$/, "sender.create", (b) => `Added sender ${b?.fromEmail ?? ""}`],
  ["PUT", /^\/senders\/(\w{24})$/, "sender.update", () => "Edited a sender account"],
  ["DELETE", /^\/senders\/(\w{24})$/, "sender.delete", () => "Removed a sender account"],
  ["POST", /^\/users$/, "user.create", (b) => `Added teammate ${b?.name ?? ""} (${b?.role ?? "member"})`],
  ["PUT", /^\/users\/(\w{24})$/, "user.update", (b) => (b?.access ? "Changed a teammate's lead access" : b?.permissions ? "Changed a teammate's permissions" : b?.active === false ? "Deactivated a teammate" : "Edited a teammate")],
  ["POST", /^\/users\/(\w{24})\/password$/, "user.reset_password", () => "Reset a teammate's password"],
  ["DELETE", /^\/users\/(\w{24})$/, "user.delete", () => "Removed a teammate"],
  ["PUT", /^\/settings$/, "settings.update", () => "Changed workspace settings"],
  ["POST", /^\/backups$/, "backup.create", () => "Made a backup"],
  ["GET", /^\/backups\/[^/]+\/download$/, "backup.download", () => "Downloaded a backup"],
  ["POST", /^\/suppressions$/, "suppression.add", () => "Added addresses to the do-not-email list"],
  ["PUT", /^\/auth\/me$/, "account.update", () => "Updated own profile"],
  ["DELETE", /^\/auth\/sessions$/, "account.signout_others", () => "Signed out on all other devices"],
  ["DELETE", /^\/auth\/sessions\/(\w{24})$/, "account.signout_device", () => "Signed out another device"],
  ["PUT", /^\/searches\/(\w{24})\/access$/, "search.access", () => "Changed who can see a search"],
  ["PUT", /^\/searches\/(\w{24})\/whatsapp$/, "search.whatsapp", () => "Changed a campaign's WhatsApp message"],
  ["POST", /^\/campaigns\/(\w{24})\/recipients\/(\w{24})\/replied$/, "campaign.mark_replied", () => "Marked a recipient as replied"],
  ["POST", /^\/auth\/password$/, "account.password", () => "Changed own password"],
];

const TARGETS = [
  [/^\/leads\/(\w{24})/, "lead"],
  [/^\/campaigns\/(\w{24})/, "campaign"],
  [/^\/searches\/(\w{24})/, "search"],
  [/^\/users\/(\w{24})/, "user"],
  [/^\/imports\/(\w{24})/, "import"],
  [/^\/tasks\/(\w{24})/, "task"],
];

// Calls the app makes on its own (polling, previews) — not something a person did.
const SKIP = [/^\/audit/, /^\/notifications/, /^\/auth\/(status|login|logout)$/, /^\/campaigns\/(audience|preview)$/, /^\/whatsapp\/render$/, /^\/senders\/\w{24}\/test-imap$/];

/**
 * Records API activity of signed-in users once the response is sent: every change (POST, PUT,
 * PATCH, DELETE — including refused attempts), plus reads a route flags via res.locals.audit.
 */
export function auditTrail(req, res, next) {
  const path = req.path;
  res.on("finish", () => {
    if (!req.user || SKIP.some((re) => re.test(path))) return;
    const explicit = res.locals.audit;
    if (req.method === "GET" && !explicit && !ROUTES.some(([m, re]) => m === "GET" && re.test(path))) return;

    const route = ROUTES.find(([m, re]) => m === req.method && re.test(path));
    const match = route ? path.match(route[1]) : null;
    let label = explicit?.label ?? (route ? route[3](req.body, match) : `${req.method} ${path}`);
    if (res.statusCode >= 400) label = `Tried to: ${label} (refused — ${res.statusCode})`;

    let target = explicit?.target ?? null;
    if (!target) {
      for (const [re, type] of TARGETS) {
        const m = path.match(re);
        if (m) target = { type, id: m[1], label: null };
      }
    }
    void (async () => {
      // Name the lead so the trail reads "Viewed lead Smile Dental" rather than an id.
      if (target?.type === "lead" && target.id && !target.label) {
        target.label = (await Lead.findById(target.id, { businessName: 1 }).lean())?.businessName ?? null;
      }
      await logAudit({
        userId: req.user._id,
        userName: req.user.name,
        role: req.user.role,
        kind: "action",
        action: explicit?.action ?? route?.[2] ?? `${req.method.toLowerCase()}`,
        label,
        path: req.originalUrl.slice(0, 300),
        method: req.method,
        status: res.statusCode,
        target,
        meta: req.method === "GET" ? undefined : sanitize(req.body),
        ip: clientIp(req),
      });
    })();
  });
  next();
}

/** Sign-in events (before a session exists, so recorded explicitly by the auth routes). */
export function logAuth(req, user, label, extra = {}) {
  return logAudit({
    userId: user?._id ?? null,
    userName: user?.name ?? extra.email ?? null,
    role: user?.role ?? null,
    kind: "auth",
    action: extra.action ?? "auth",
    label,
    ip: clientIp(req),
    meta: { userAgent: String(req.headers["user-agent"] ?? "").slice(0, 200) },
  });
}

/**
 * Active time from a sorted list of timestamps: gaps up to 5 minutes count as working,
 * longer gaps as a break. Each burst counts at least one minute.
 */
export function activeMinutes(times, idleMs = 5 * 60 * 1000) {
  if (!times.length) return 0;
  let total = 0;
  let start = times[0];
  let prev = times[0];
  for (const t of times.slice(1)) {
    if (t - prev > idleMs) {
      total += Math.max(60_000, prev - start);
      start = t;
    }
    prev = t;
  }
  total += Math.max(60_000, prev - start);
  return Math.round(total / 60_000);
}
