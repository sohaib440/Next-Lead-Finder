import { spawn } from "node:child_process";
import readline from "node:readline";
import { config } from "../config.js";
import { Lead, dedupeKeyFor, refreshKeys, refreshScores } from "../models/Lead.js";
import { Search } from "../models/Search.js";
import { User } from "../models/User.js";
import { nextAutoAssignee } from "./distribute.js";
import { notify, notifyAdmins } from "./notify.js";

/** searchId -> { child, startedAt, cancelRequested } for scraper processes still alive. */
const jobs = new Map();

export function isActive(searchId) {
  return jobs.has(String(searchId));
}

/**
 * Spawns the Python scraper for a search. The scraper prints NDJSON events on stdout
 * (status / progress / lead / error / done) and reads control commands on stdin.
 */
export function startScrape(search, { source = "auto", placesApiKey = "" } = {}) {
  const id = String(search._id);
  const payload = {
    niche: search.niche,
    country: search.country,
    city: search.city,
    keyword: search.keyword,
    maxResults: search.maxResults,
    contactTypes: search.contactTypes,
    websiteFilter: search.websiteFilter,
    headless: config.headless,
    source,
  };

  const child = spawn(config.pythonBin, [config.scraperEntry, JSON.stringify(payload)], {
    cwd: config.scraperDir,
    env: {
      // The scraper has no use for the app's secrets.
      ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !["APP_SECRET", "ADMIN_PASSWORD"].includes(k))),
      PYTHONUNBUFFERED: "1",
      PYTHONIOENCODING: "utf-8",
      GOOGLE_PLACES_API_KEY: placesApiKey,
    },
    windowsHide: true,
  });

  // assigned: userId -> number of new leads auto-assigned during this run.
  const job = { child, startedAt: Date.now(), cancelRequested: false, lastError: null, assigned: new Map() };
  jobs.set(id, job);

  // Events are handled strictly in order so lead counters never race each other.
  let queue = Promise.resolve();
  const lines = readline.createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    queue = queue.then(() => handleEvent(id, job, line)).catch((err) => {
      console.error(`[scrape ${id}] failed to handle event:`, err);
    });
  });

  child.stdin.on("error", () => {});
  child.stderr.on("data", (chunk) => {
    process.stderr.write(`[scrape ${id}] ${chunk}`);
  });

  child.on("error", (err) => {
    job.lastError = `Could not start the scraper (${config.pythonBin}): ${err.message}`;
  });

  child.on("close", (code) => {
    queue = queue.then(() => finish(id, job, code));
  });
}

async function handleEvent(id, job, line) {
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    console.log(`[scrape ${id}] ${line}`);
    return;
  }

  switch (event.type) {
    case "source":
      await Search.updateOne({ _id: id }, { source: event.source });
      break;
    case "status":
      await Search.updateOne({ _id: id }, { statusText: event.text });
      break;
    case "progress":
      await Search.updateOne({ _id: id }, { progress: Math.min(100, Math.max(0, event.progress)) });
      break;
    case "lead":
      await saveLead(id, event.lead, job);
      break;
    case "error":
      job.lastError = event.message;
      break;
    default:
      break;
  }
}

const FILLABLE = ["phone", "email", "website", "address", "sourceUrl", "placeId"];

async function saveLead(searchId, raw, job) {
  if (!raw?.businessName) return;
  const doc = {
    businessName: raw.businessName,
    category: raw.category ?? "",
    country: raw.country ?? "",
    city: raw.city ?? "",
    address: raw.address ?? null,
    phone: raw.phone ?? null,
    email: raw.email ?? null,
    website: raw.website ?? null,
    source: raw.source ?? "",
    sourceUrl: raw.sourceUrl ?? null,
    placeId: raw.placeId ?? null,
    rating: raw.rating ?? null,
    reviewCount: raw.reviewCount ?? null,
    businessStatus: raw.businessStatus ?? null,
    lat: raw.lat ?? null,
    lng: raw.lng ?? null,
    audit: raw.audit ? { ...raw.audit, checkedAt: new Date() } : null,
    socials: raw.socials && Object.keys(raw.socials).length ? raw.socials : undefined,
    searchId,
  };
  // The same Google listing is the same business even if its name or city reads differently.
  const samePlace = doc.placeId ? await Lead.findOne({ placeId: doc.placeId }, { dedupeKey: 1 }) : null;
  const dedupeKey = samePlace?.dedupeKey ?? dedupeKeyFor(doc.businessName, doc.city);
  const result = await Lead.updateOne(
    { dedupeKey },
    { $setOnInsert: doc, $addToSet: { searchIds: searchId } },
    { upsert: true },
  );

  const isNew = result.upsertedCount === 1;
  if (isNew) {
    // Auto-assignment: hand the new lead to the next staff member in this search's rotation.
    const assignee = await nextAutoAssignee(searchId);
    if (assignee && (await User.exists({ _id: assignee, active: true }))) {
      await Lead.updateOne({ dedupeKey }, { assignedTo: assignee });
      job?.assigned.set(String(assignee), (job.assigned.get(String(assignee)) ?? 0) + 1);
    }
  }
  if (!isNew) {
    // Ratings, status and the website audit change over time: keep the latest values.
    const fresh = Object.fromEntries(
      ["rating", "reviewCount", "businessStatus", "lat", "lng", "audit"].filter((f) => doc[f] != null).map((f) => [f, doc[f]]),
    );
    for (const [network, url] of Object.entries(doc.socials ?? {})) fresh[`socials.${network}`] = url;
    if (Object.keys(fresh).length) await Lead.updateOne({ dedupeKey }, { $set: fresh });
    // Fill in details the stored copy is missing (e.g. a website or email found this time).
    await Promise.all(
      FILLABLE.filter((f) => doc[f]).map((f) =>
        Lead.updateOne({ dedupeKey, [f]: { $in: [null, ""] } }, { $set: { [f]: doc[f] } }),
      ),
    );
  }
  const search = await Search.findById(searchId, { whatsappTemplateId: 1 });
  if (search?.whatsappTemplateId) {
    await Lead.updateOne(
      { dedupeKey, whatsappTemplateId: null },
      { $set: { whatsappTemplateId: search.whatsappTemplateId } },
    );
  }
  await Promise.all([refreshScores({ dedupeKey }), refreshKeys({ dedupeKey })]);
  await Search.updateOne(
    { _id: searchId },
    {
      $inc: {
        leadsFound: isNew ? 1 : 0,
        duplicatesSkipped: isNew ? 0 : 1,
        phonesFound: doc.phone ? 1 : 0,
        emailsFound: doc.email ? 1 : 0,
      },
    },
  );
}

async function finish(id, job, code) {
  jobs.delete(id);
  const durationSeconds = Math.round((Date.now() - job.startedAt) / 1000);

  let update;
  if (job.cancelRequested) {
    update = { status: "cancelled", statusText: "Search cancelled. Partial results were kept." };
  } else if (code === 0) {
    update = { status: "completed", progress: 100, statusText: "Search completed." };
  } else {
    update = {
      status: "failed",
      error: job.lastError ?? `Scraper exited with code ${code}`,
      statusText: job.lastError ?? "Search failed.",
    };
  }
  await Search.updateOne({ _id: id }, { ...update, durationSeconds });

  const search = await Search.findById(id, { name: 1, leadsFound: 1, createdBy: 1 });
  for (const [userId, count] of job.assigned) {
    await notify(userId, {
      type: "leads_assigned",
      title: `${count} new lead${count === 1 ? "" : "s"} assigned to you`,
      body: `From the search “${search?.name}”`,
      link: "/leads?assignedTo=me",
    });
  }
  if (search) {
    await notifyAdmins({
      type: "search_done",
      title: `Search ${update.status}: ${search.name}`,
      body: `${search.leadsFound} new leads${job.assigned.size ? ` · auto-assigned to ${job.assigned.size} staff` : ""}`,
      link: `/leads?searchId=${search._id}`,
    });
  }
}

function sendCommand(searchId, command) {
  const job = jobs.get(String(searchId));
  if (!job) return false;
  if (command === "cancel") job.cancelRequested = true;
  job.child.stdin.write(`${command}\n`);
  return true;
}

export const pauseScrape = (id) => sendCommand(id, "pause");
export const resumeScrape = (id) => sendCommand(id, "resume");

export function cancelScrape(id) {
  const sent = sendCommand(id, "cancel");
  if (sent) {
    // Give the scraper a moment to exit cleanly, then force it.
    const job = jobs.get(String(id));
    setTimeout(() => {
      if (jobs.get(String(id)) === job) job.child.kill();
    }, 15000).unref();
  }
  return sent;
}

/** Searches left "running" by a previous server process have no scraper behind them anymore. */
export async function markOrphanedSearches() {
  await Search.updateMany(
    { status: { $in: ["running", "paused"] } },
    { status: "cancelled", statusText: "Interrupted — the server restarted during this search." },
  );
}
