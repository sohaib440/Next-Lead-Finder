export type ContactType = "phone" | "email" | "website";

/** any: every business · with: only those listing a website · without: only those with no website. */
export type WebsiteFilter = "any" | "with" | "without";

export type LeadStage = "new" | "contacted" | "qualified" | "proposal" | "won" | "lost";
export type LeadPriority = "low" | "medium" | "high";

export interface Lead {
  id: string;
  businessName: string;
  category: string;
  country: string;
  city: string;
  phone: string | null;
  email: string | null;
  website: string | null;
  source: string;
  dateAdded: string; // ISO date string
  address?: string | null;
  /** Google Business Profile (Maps listing) link. */
  sourceUrl?: string | null;
  placeId?: string | null;
  searchId?: string;
  searchIds?: string[];
  // CRM
  stage: LeadStage;
  priority: LeadPriority;
  /** Pinned leads are listed first. */
  pinned?: boolean;
  /** WhatsApp template assigned to this lead. Null means use its campaign's message. */
  whatsappTemplateId?: string | null;
  whatsappStatus?: WhatsAppStatus;
  whatsappCheckedAt?: string | null;
  whatsappCheckedBy?: string | null;
  phoneType?: PhoneType;
  /** Lead lists only: who last worked on it, and who has open tasks on it. */
  lastActivity?: { type: ActivityType; by: string; date: string } | null;
  openTasks?: { count: number; assignees: string[] } | null;
  pinnedAt?: string | null;
  tags: string[];
  contactName: string | null;
  contactRole: string | null;
  dealValue: number | null;
  lastContactedAt: string | null;
  stageChangedAt: string | null;
  /** 0–100 data-completeness score. */
  score: number;
  /** The staff member responsible (an id in lists, populated on the lead page). */
  assignedTo?: string | { id: string; name: string; email: string } | null;
  // From Google
  rating?: number | null;
  reviewCount?: number | null;
  businessStatus?: BusinessStatus | null;
  lat?: number | null;
  lng?: number | null;
  // From the business website
  socials?: Partial<Record<SocialNetwork, string>>;
  audit?: WebsiteAudit | null;
  /** 0–100 sales potential for web & marketing services. */
  opportunity?: number;
  opportunityReasons?: string[];
}

export type BusinessStatus = "open" | "closed_temporarily" | "closed_permanently";
export type SocialNetwork =
  "facebook" | "instagram" | "linkedin" | "twitter" | "youtube" | "tiktok" | "whatsapp";

export interface WebsiteAudit {
  checkedAt?: string;
  reachable: boolean;
  statusCode?: number;
  error?: string;
  finalUrl?: string;
  https?: boolean;
  mobileFriendly?: boolean;
  loadMs?: number;
  platform?: string | null;
  title?: string | null;
  copyrightYear?: number | null;
}

/** Fields a user can edit (or set when adding a lead by hand). */
export type LeadInput = Partial<
  Pick<
    Lead,
    | "assignedTo"
    | "businessName"
    | "category"
    | "country"
    | "city"
    | "address"
    | "phone"
    | "email"
    | "website"
    | "contactName"
    | "contactRole"
    | "dealValue"
    | "priority"
    | "pinned"
    | "whatsappStatus"
    | "stage"
    | "tags"
  >
>;

export type ActivityType =
  | "note"
  | "call"
  | "email"
  | "meeting"
  | "whatsapp"
  | "whatsapp_unavailable"
  | "email_reply"
  | "stage_change";

/** Whether a lead's number is on WhatsApp, as found out by trying to message it. */
export type WhatsAppStatus = "unknown" | "yes" | "no";
export type PhoneType = "mobile" | "landline" | "unknown" | "none";
/** What staff say happened after a WhatsApp chat opened. */
export type WhatsAppResult = "sent" | "not_on_whatsapp" | "not_sent";

export interface Activity {
  id: string;
  leadId: string;
  type: ActivityType;
  text: string;
  meta: { from: LeadStage; to: LeadStage } | null;
  /** Who did it: a teammate's name, or e.g. "Campaign (you@…)". */
  by: string | null;
  date: string;
}

export type TaskType = "todo" | "call" | "email" | "meeting";

export interface Task {
  id: string;
  title: string;
  type: TaskType;
  leadId: string | null;
  lead?: { id: string; businessName: string };
  dueAt: string | null;
  done: boolean;
  doneAt: string | null;
  createdAt: string;
  /** Who should do it, and who added it (names included in lists). */
  assignedTo?: string | null;
  assignee?: { id: string; name: string };
  createdBy?: string | null;
  creator?: { id: string; name: string };
}

export type TaskInput = Partial<
  Pick<Task, "title" | "type" | "leadId" | "dueAt" | "done" | "assignedTo">
>;

export interface LeadDetail {
  lead: Lead;
  activities: Activity[];
  tasks: Task[];
}

export interface PipelineColumn {
  stage: LeadStage;
  count: number;
  value: number;
  leads: (Lead & { nextTask: { title: string; dueAt: string } | null })[];
}

export type SearchStatus = "completed" | "running" | "paused" | "cancelled" | "failed";

export interface SearchRecord {
  id: string;
  name: string;
  niche: string;
  country: string;
  city: string | null;
  keyword: string | null;
  maxResults: number;
  contactTypes: ContactType[];
  onlyWithWebsites: boolean;
  websiteFilter: WebsiteFilter;
  /** The WhatsApp template an admin chose for this campaign's leads. */
  whatsappTemplateId?: string | null;
  /** Staff who receive this search's new leads in turn. */
  autoDistribute?: { userIds: string[]; cursor: number };
  date: string; // ISO date string
  leadsFound: number;
  status: SearchStatus;
  durationSeconds?: number | null;
  // Live run details reported by the backend scraper.
  source?: string | null;
  progress?: number;
  statusText?: string;
  phonesFound?: number;
  emailsFound?: number;
  duplicatesSkipped?: number;
  error?: string | null;
}

export type ExportFormat = "csv" | "xlsx";

export interface ExportRecord {
  id: string;
  filename: string;
  format: ExportFormat;
  scope: string;
  fields: string[];
  count: number;
  date: string; // ISO date string
  status: "completed" | "failed";
}

export type LeadSource = "auto" | "google_maps" | "google_places";

export interface AppSettings {
  profileName: string;
  profileEmail: string;
  defaultCountry: string;
  defaultResultLimit: number;
  rowsPerPage: number;
  compactTable: boolean;
  currency: string;
  defaultWhatsappTemplateId: string | null;
  /** Members must send the admin's WhatsApp message (they can't write their own). */
  whatsappStaffMustUseFormat: boolean;
  defaultPhone: boolean;
  defaultEmail: boolean;
  defaultWebsite: boolean;
  defaultOnlyWithWebsites: boolean;
  defaultWebsiteFilter: WebsiteFilter;
  leadSource: LeadSource;
  hasPlacesApiKey: boolean;
  placesApiKeyHint: string | null;
}

/** Fields the Settings page can change; the Places key is write-only. */
export type SettingsUpdate = Partial<Omit<AppSettings, "hasPlacesApiKey" | "placesApiKeyHint">> & {
  googlePlacesApiKey?: string | null;
};

export const DEFAULT_SETTINGS: AppSettings = {
  profileName: "My Workspace",
  profileEmail: "",
  defaultCountry: "United States",
  defaultResultLimit: 100,
  rowsPerPage: 25,
  compactTable: false,
  currency: "USD",
  defaultWhatsappTemplateId: null,
  whatsappStaffMustUseFormat: true,
  defaultPhone: true,
  defaultEmail: true,
  defaultWebsite: true,
  defaultOnlyWithWebsites: false,
  defaultWebsiteFilter: "any",
  leadSource: "auto",
  hasPlacesApiKey: false,
  placesApiKeyHint: null,
};

export interface ChartPoint {
  date: string;
  leads: number;
  searches: number;
}

export interface Stats {
  totalLeads: number;
  withPhone: number;
  withEmail: number;
  withWebsite: number;
  searches: {
    total: number;
    completed: number;
    running: number;
    failed: number;
    cancelled: number;
  };
  activity: { day: string; leads: number; searches: number }[];
  topCountries: { country: string; count: number }[];
  pipeline: { stage: LeadStage; count: number; value: number }[];
  tasks: { overdue: number; dueToday: number; open: number };
}

export interface Health {
  ok: boolean;
  db: boolean;
  source: Exclude<LeadSource, "auto">;
  hasPlacesKey: boolean;
}

export type LeadSort =
  | "newest"
  | "oldest"
  | "name"
  | "city"
  | "score"
  | "value"
  | "contacted"
  | "opportunity"
  | "rating"
  | "reviews";

export interface LeadQuery {
  /** yes | no | unknown (not tried) | landline */
  whatsapp?: "yes" | "no" | "unknown" | "landline" | undefined;
  q?: string | undefined;
  country?: string | undefined;
  city?: string | undefined;
  category?: string | undefined;
  searchId?: string | undefined;
  importId?: string | undefined;
  /** A user id, "me" or "none" (unassigned). */
  assignedTo?: string | undefined;
  stage?: LeadStage[] | undefined;
  tag?: string | undefined;
  priority?: LeadPriority | undefined;
  has?: ContactType[] | undefined;
  missing?: ContactType[] | undefined;
  minRating?: number | undefined;
  minReviews?: number | undefined;
  minOpportunity?: number | undefined;
  hideClosed?: boolean | undefined;
  sort?: LeadSort | undefined;
  page?: number | undefined;
  limit?: number | undefined;
}

export interface Paged<T> {
  items: T[];
  total: number;
  page: number;
  limit: number;
}

export interface LeadFacets {
  countries: string[];
  categories: string[];
  cities: string[];
  tags: string[];
}

/* ---------------------------------- Email --------------------------------- */

export interface Sender {
  id: string;
  label: string;
  fromName: string;
  fromEmail: string;
  replyTo: string | null;
  host: string;
  port: number;
  secure: boolean;
  username: string;
  hasPassword: boolean;
  signature: string;
  dailyLimit: number;
  imap?: {
    enabled: boolean;
    host: string;
    port: number;
    secure: boolean;
    username: string;
    hasPassword?: boolean;
  };
  imapState?: { lastCheckedAt: string | null; lastError: string | null };
}

/** `password` is write-only: leave it empty when editing to keep the stored one. */
export type SenderInput = Omit<Sender, "id" | "hasPassword" | "imap" | "imapState"> & {
  password?: string;
  imap?: {
    enabled: boolean;
    host: string;
    port: number;
    secure: boolean;
    username: string;
    password?: string;
  };
};

export interface EmailTemplate {
  id: string;
  name: string;
  channel?: "email" | "whatsapp";
  subject: string;
  body: string;
  updatedAt: string;
}

export type CampaignStatus = "draft" | "sending" | "paused" | "completed" | "cancelled";

export interface CampaignAudience {
  /** Hand-picked leads; when set, `query` is ignored. */
  leadIds?: string[];
  /** Lead filter, same params as the All Leads page. */
  query?: {
    searchId?: string | undefined;
    stage?: string | undefined;
    tag?: string | undefined;
    country?: string | undefined;
    category?: string | undefined;
    missing?: string | undefined;
  };
  label: string;
}

export interface CampaignOptions {
  delaySeconds: number;
  skipEmailedBefore: boolean;
  skipClosed: boolean;
}

export interface FollowUp {
  delayDays: number;
  /** Empty = "Re: <first subject>", keeping the same conversation. */
  subject: string;
  body: string;
}

export interface Campaign {
  id: string;
  followUps: FollowUp[];
  followUpsSent: number;
  replied: number;
  unsubscribed: number;
  bounced: number;
  name: string;
  status: CampaignStatus;
  senderId: string | null;
  subject: string;
  body: string;
  audience: CampaignAudience;
  options: CampaignOptions;
  total: number;
  sent: number;
  failed: number;
  skipped: number;
  statusText: string;
  lastError: string | null;
  nextSendAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

export type CampaignInput = Partial<
  Pick<Campaign, "name" | "senderId" | "subject" | "body" | "audience" | "options" | "followUps">
>;

export interface CampaignRecipient {
  id: string;
  leadId: string;
  businessName: string;
  email: string;
  status: "queued" | "sent" | "failed" | "skipped";
  reason: string | null;
  subject: string | null;
  sentAt: string | null;
  step: number;
  nextStepAt: string | null;
  repliedAt: string | null;
  replySnippet: string | null;
  unsubscribedAt: string | null;
  bouncedAt: string | null;
}

export interface AudienceSummary {
  matched: number;
  noEmail: number;
  willSend: number;
  skipped: { reason: string; count: number }[];
  sample: { leadId: string; businessName: string; email: string }[];
}

export interface EmailPreview {
  subject: string;
  text: string;
  html: string;
  lead: { id: string; businessName: string; email: string | null } | null;
  unknownFields: string[];
}

export interface Suppression {
  id: string;
  email: string;
  reason: string;
  createdAt: string;
}

/* ---------------------------------- Auth ---------------------------------- */

export type Role = "admin" | "member";

/** Member switches. Finding new leads (searches) is admin-only and not one of them. */
export type Permission = "import" | "export" | "campaigns";

export interface User {
  id: string;
  name: string;
  email: string;
  role: Role;
  active: boolean;
  mustChangePassword: boolean;
  lastLoginAt: string | null;
  lastSeenAt?: string | null;
  createdAt: string;
  /** Searches/imports a member can see (admins see everything). */
  access?: { searchIds: string[]; importIds: string[] };
  permissions?: Partial<Record<Permission, boolean>>;
  /** Team list only: how many leads this person can see. */
  visibleLeads?: number;
  /** Team list only: what they're working on now. */
  workload?: { ownedLeads: number; openLeads: number; openTasks: number; overdueTasks: number };
}

export interface AuditEntry {
  id: string;
  userId: string | null;
  userName: string | null;
  role: Role | null;
  kind: "action" | "page" | "click" | "auth";
  action: string | null;
  label: string;
  path: string | null;
  status: number | null;
  target?: { type: string | null; id: string | null; label: string | null } | null;
  meta?: Record<string, unknown>;
  ip?: string | null;
  createdAt: string;
}

export interface StaffSummary {
  user: User;
  activeMinutes: number;
  firstAt: string | null;
  lastAt: string | null;
  pages: number;
  clicks: number;
  changes: number;
  refused: number;
  exports: number;
  leadsViewed: number;
  leadsWorked: number;
  outreach: {
    call: number;
    email: number;
    whatsapp: number;
    meeting: number;
    note: number;
    stage_change: number;
    won: number;
  };
}

export interface AuthStatus {
  setupRequired: boolean;
  user: User | null;
}

export interface SessionInfo {
  id: string;
  ip: string;
  userAgent: string;
  remember: boolean;
  lastSeenAt: string;
  createdAt: string;
  expiresAt: string;
  current: boolean;
}

/* --------------------------------- Imports -------------------------------- */

/** Lead fields a spreadsheet column can be mapped to. */
export type ImportField =
  | "businessName"
  | "category"
  | "phone"
  | "email"
  | "website"
  | "address"
  | "city"
  | "country"
  | "contactName"
  | "contactRole"
  | "sourceUrl"
  | "tags"
  | "stage"
  | "priority"
  | "dealValue"
  | "notes";

export type ImportRow = Partial<Record<ImportField, string>>;

export type MatchKey = "placeId" | "emailKey" | "phoneKey" | "domainKey" | "nameKey";

export interface ImportOptions {
  matchOn: MatchKey[];
  duplicateMode: "skip" | "fill";
  defaults: { country: string; category: string; stage: LeadStage; tags: string[] };
}

export interface ImportRowResult {
  index: number;
  status: "new" | "existing" | "in_file" | "invalid";
  by: string | null;
  reason: string | null;
  ofRow: number | null;
  fills: string[];
  existing: { id: string; businessName: string; city: string; stage: LeadStage } | null;
}

export interface ImportAnalysis {
  totalRows: number;
  counts: { new: number; existing: number; inFile: number; invalid: number; fillable: number };
  rows: ImportRowResult[];
}

export interface ImportRecord {
  id: string;
  filename: string;
  by: string | null;
  userId: string | null;
  totalRows: number;
  created: number;
  updated: number;
  skippedExisting: number;
  duplicatesInFile: number;
  invalid: number;
  undoneAt: string | null;
  createdAt: string;
}

export interface DuplicateGroup {
  id: string;
  matchedBy: string[];
  leads: Lead[];
}

/* ------------------------------ Enrich / backups / WhatsApp ------------------------------ */

export interface EnrichJob {
  id: string;
  status: "running" | "completed" | "failed" | "cancelled";
  statusText: string;
  done: number;
  total: number;
  leads: number;
  updated: number;
  emailsFound: number;
  startedAt: string;
  finishedAt: string | null;
  startedBy: string;
  error: string | null;
}

export interface BackupInfo {
  file: string;
  size: number;
  createdAt: string;
}

export interface WhatsAppMessage {
  text: string;
  number: string | null;
  /** false = landline (no WhatsApp); null = can't tell for this country. */
  likelyMobile: boolean | null;
  url: string | null;
}

export interface WhatsAppFormat {
  template: { id: string; name: string; body: string } | null;
  /** The campaign the message comes from, or "Default message". */
  source: string | null;
  /** True when this user must send exactly this message. */
  mustUse: boolean;
  preview: WhatsAppMessage | null;
}

export interface WhatsAppQueueItem extends WhatsAppMessage {
  templateName: string | null;
  source: string | null;
  reason: string | null;
  leadId: string;
  businessName: string;
  city: string;
  phone: string;
  stage: LeadStage;
  opportunity: number;
  lastMessagedAt: string | null;
  whatsappStatus?: WhatsAppStatus;
  phoneType?: PhoneType;
}

/* ------------------------------ Notifications ------------------------------ */

export interface AppNotification {
  id: string;
  userId: string;
  type:
    | "leads_assigned"
    | "campaign_shared"
    | "task_assigned"
    | "task_due"
    | "email_reply"
    | "search_done"
    | string;
  title: string;
  body: string;
  link: string | null;
  read: boolean;
  createdAt: string;
}

export interface DistributionPlan {
  total: number;
  plan: { userId: string; name: string; count: number }[];
}

/* --------------------------------- Reports --------------------------------- */

export interface ReportData {
  from: string;
  to: string;
  /** Buckets are weeks (Monday) for ranges over 45 days, otherwise days. */
  weekly: boolean;
  kpis: {
    newLeads: number;
    contacted: number;
    outreach: number;
    replies: number;
    won: number;
    wonValue: number;
    lost: number;
    winRate: number | null;
    openLeads: number;
    openValue: number;
    tasksDone: number;
    noWhatsapp: number;
  };
  series: {
    key: string;
    newLeads: number;
    contacted: number;
    won: number;
    call: number;
    email: number;
    whatsapp: number;
    meeting: number;
  }[];
  outreach: { call: number; email: number; whatsapp: number; meeting: number };
  funnel: { stage: LeadStage; count: number }[];
  team:
    | {
        userId: string;
        name: string;
        role: Role;
        owned: number;
        open: number;
        contacted: number;
        calls: number;
        emails: number;
        whatsapp: number;
        noWhatsapp: number;
        meetings: number;
        notes: number;
        stageMoves: number;
        won: number;
        wonValue: number;
        tasksDone: number;
      }[]
    | null;
  campaigns: {
    searchId: string;
    name: string;
    createdAt: string;
    leads: number;
    withPhone: number;
    withEmail: number;
    contacted: number;
    progressed: number;
    won: number;
    wonValue: number;
    avgOpportunity: number | null;
  }[];
  emailCampaigns: {
    id: string;
    name: string;
    status: string;
    sent: number;
    followUpsSent?: number;
    replied?: number;
    bounced?: number;
    unsubscribed?: number;
    startedAt: string;
  }[];
}
