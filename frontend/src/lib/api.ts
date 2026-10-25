import type {
  Activity,
  AppNotification,
  ReportData,
  WhatsAppResult,
  AppSettings,
  DistributionPlan,
  AuditEntry,
  Permission,
  StaffSummary,
  BackupInfo,
  EnrichJob,
  WhatsAppFormat,
  WhatsAppMessage,
  WhatsAppQueueItem,
  DuplicateGroup,
  ImportAnalysis,
  ImportOptions,
  ImportRecord,
  ImportRow,
  MatchKey,
  AuthStatus,
  SessionInfo,
  User,
  Role,
  AudienceSummary,
  Campaign,
  CampaignAudience,
  CampaignInput,
  CampaignOptions,
  CampaignRecipient,
  EmailPreview,
  EmailTemplate,
  Sender,
  SenderInput,
  Suppression,
  ExportRecord,
  Health,
  Lead,
  LeadDetail,
  LeadFacets,
  LeadInput,
  LeadPriority,
  LeadQuery,
  LeadStage,
  Paged,
  PipelineColumn,
  SearchRecord,
  SettingsUpdate,
  Stats,
  Task,
  TaskInput,
  WebsiteFilter,
} from "@/types";

// Same address as the page by default (the frontend server proxies /api to the backend), so the
// app works the same from localhost or the computer's IP. Set VITE_API_URL to call an API elsewhere.
export const API_URL = (import.meta.env["VITE_API_URL"] as string | undefined) ?? "/api";

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public errors?: Record<string, string>,
  ) {
    super(message);
  }
}

/** Fired when the API says the session is gone or a password change is due; the auth gate listens. */
export const AUTH_EVENT = "leadfinder:auth";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, {
      ...init,
      // Send the httpOnly session cookie.
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        // Required by the API's CSRF guard on every state-changing request.
        "X-Requested-With": "LeadFinder",
        ...init?.headers,
      },
    });
  } catch {
    throw new ApiError(`Cannot reach the API at ${API_URL}. Is the backend running?`, 0);
  }
  if (res.status === 204) return undefined as T;
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (
      typeof window !== "undefined" &&
      !path.startsWith("/auth/") &&
      (body.code === "unauthenticated" || body.code === "password_change_required")
    ) {
      window.dispatchEvent(new Event(AUTH_EVENT));
    }
    throw new ApiError(body.error ?? `Request failed (${res.status})`, res.status, body.errors);
  }
  return body as T;
}

const json = (method: string, body?: unknown): RequestInit =>
  body === undefined ? { method } : { method, body: JSON.stringify(body) };

export function leadQueryString(query: LeadQuery & { all?: boolean }): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === "") continue;
    if (Array.isArray(value)) {
      if (value.length) params.set(key, value.join(","));
    } else {
      params.set(key, String(value));
    }
  }
  const s = params.toString();
  return s ? `?${s}` : "";
}

export interface NewSearchInput {
  niche: string;
  country: string;
  city: string | null;
  keyword: string | null;
  maxResults: number;
  contactTypes: SearchRecord["contactTypes"];
  websiteFilter: WebsiteFilter;
  /** Admin: hand each new lead to these staff in turn. */
  autoDistributeTo?: string[];
}

export const api = {
  authStatus: () => request<AuthStatus>("/auth/status"),
  login: (input: { email: string; password: string; remember: boolean }) =>
    request<{ user: User }>("/auth/login", json("POST", input)),
  logout: () => request<void>("/auth/logout", json("POST")),
  updateMe: (input: { name?: string; email?: string; currentPassword?: string }) =>
    request<{ user: User }>("/auth/me", json("PUT", input)),
  changePassword: (input: { currentPassword: string; newPassword: string }) =>
    request<{ user: User }>("/auth/password", json("POST", input)),
  listSessions: () => request<SessionInfo[]>("/auth/sessions"),
  revokeSession: (id: string) => request<void>(`/auth/sessions/${id}`, json("DELETE")),
  revokeOtherSessions: () => request<{ signedOut: number }>("/auth/sessions", json("DELETE")),

  listUsers: () => request<User[]>("/users"),
  createUser: (input: { name: string; email: string; role: Role; password: string }) =>
    request<User>("/users", json("POST", input)),
  updateUser: (
    id: string,
    input: {
      name?: string;
      role?: Role;
      active?: boolean;
      access?: { searchIds?: string[]; importIds?: string[] };
      permissions?: Partial<Record<Permission, boolean>>;
    },
  ) => request<User>(`/users/${id}`, json("PUT", input)),
  resetUserPassword: (id: string, password: string) =>
    request<User>(`/users/${id}/password`, json("POST", { password })),
  deleteUser: (id: string) => request<void>(`/users/${id}`, json("DELETE")),

  health: () => request<Health>("/health"),
  stats: () => request<Stats>(`/stats?tzOffset=${new Date().getTimezoneOffset()}`),

  listLeads: (query: LeadQuery) => request<Paged<Lead>>(`/leads${leadQueryString(query)}`),
  allLeads: (query: LeadQuery) =>
    request<Paged<Lead>>(`/leads${leadQueryString({ ...query, all: true })}`),
  leadFacets: () => request<LeadFacets>("/leads/facets"),
  deleteLead: (id: string) => request<void>(`/leads/${id}`, json("DELETE")),
  deleteLeads: (ids: string[]) =>
    request<{ deleted: number }>("/leads/bulk-delete", json("POST", { ids })),
  deleteAllLeads: () => request<{ deleted: number }>("/leads?confirm=true", json("DELETE")),
  getLead: (id: string) => request<LeadDetail>(`/leads/${id}`),
  createLead: (input: LeadInput) => request<Lead>("/leads", json("POST", input)),
  updateLead: (id: string, patch: LeadInput) => request<Lead>(`/leads/${id}`, json("PATCH", patch)),
  bulkUpdateLeads: (input: {
    ids: string[];
    stage?: LeadStage;
    priority?: LeadPriority;
    pinned?: boolean;
    addTags?: string[];
    removeTags?: string[];
  }) => request<{ updated: number; moved: number }>("/leads/bulk-update", json("POST", input)),

  addActivity: (
    leadId: string,
    input: { type: Exclude<Activity["type"], "stage_change">; text: string },
  ) => request<Activity>(`/leads/${leadId}/activities`, json("POST", input)),
  updateActivity: (id: string, text: string) =>
    request<Activity>(`/activities/${id}`, json("PATCH", { text })),
  deleteActivity: (id: string) => request<void>(`/activities/${id}`, json("DELETE")),

  listTasks: (status: "open" | "done" | "all" = "open") =>
    request<Task[]>(`/tasks?status=${status}`),
  createTask: (input: TaskInput) => request<Task>("/tasks", json("POST", input)),
  updateTask: (id: string, patch: TaskInput) => request<Task>(`/tasks/${id}`, json("PATCH", patch)),
  deleteTask: (id: string) => request<void>(`/tasks/${id}`, json("DELETE")),

  pipeline: (query: Pick<LeadQuery, "q" | "tag" | "priority" | "assignedTo">) =>
    request<PipelineColumn[]>(`/pipeline${leadQueryString(query)}`),

  listSearches: () => request<SearchRecord[]>("/searches"),
  getSearch: (id: string) => request<{ search: SearchRecord; preview: Lead[] }>(`/searches/${id}`),
  startSearch: (input: NewSearchInput) => request<SearchRecord>("/searches", json("POST", input)),
  pauseSearch: (id: string) => request<SearchRecord>(`/searches/${id}/pause`, json("POST")),
  resumeSearch: (id: string) => request<SearchRecord>(`/searches/${id}/resume`, json("POST")),
  cancelSearch: (id: string) => request<SearchRecord>(`/searches/${id}/cancel`, json("POST")),
  deleteSearch: (id: string, withLeads: boolean) =>
    request<{ deletedLeads: number }>(`/searches/${id}?withLeads=${withLeads}`, json("DELETE")),

  listExports: () => request<ExportRecord[]>("/exports"),
  recordExport: (record: Omit<ExportRecord, "id" | "date">) =>
    request<ExportRecord>("/exports", json("POST", record)),
  deleteExport: (id: string) => request<void>(`/exports/${id}`, json("DELETE")),
  clearExports: () => request<{ deleted: number }>("/exports", json("DELETE")),

  whatsappResult: (leadId: string, input: { result: WhatsAppResult; text?: string }) =>
    request<unknown>(`/leads/${leadId}/whatsapp-result`, json("POST", input)),
  reports: (query: {
    from: string;
    to: string;
    tzOffset: number;
    searchId?: string;
    userId?: string;
  }) => request<ReportData>(`/reports${leadQueryString(query as unknown as LeadQuery)}`),
  notifications: () => request<{ items: AppNotification[]; unread: number }>("/notifications"),
  readNotification: (id: string) => request<void>(`/notifications/${id}/read`, json("POST")),
  readAllNotifications: () => request<{ updated: number }>("/notifications/read-all", json("POST")),
  distributeLeads: (input: {
    ids?: string[];
    query?: LeadQuery;
    searchId?: string;
    userIds: string[];
    method: "even" | "balanced";
    onlyUnassigned: boolean;
    preview: boolean;
    label?: string;
  }) => request<DistributionPlan>("/leads/distribute", json("POST", input)),
  setSearchDistribution: (searchId: string, userIds: string[]) =>
    request<SearchRecord>(`/searches/${searchId}/distribution`, json("PUT", { userIds })),
  assignLeads: (ids: string[], userId: string | null) =>
    request<{ updated: number }>("/leads/assign", json("POST", { ids, userId })),
  setSearchAccess: (searchId: string, userIds: string[]) =>
    request<{ userIds: string[] }>(`/searches/${searchId}/access`, json("PUT", { userIds })),

  auditEvents: (events: { kind: "page" | "click"; path: string; label: string; at: string }[]) =>
    request<void>("/audit/events", { ...json("POST", { events }), keepalive: true }),
  audit: (query: {
    userId?: string;
    kind?: string;
    q?: string;
    from?: string;
    to?: string;
    before?: string;
    targetId?: string;
    limit?: number;
  }) =>
    request<{ items: AuditEntry[]; next: string | null }>(
      `/audit${leadQueryString(query as LeadQuery)}`,
    ),
  auditSummary: (from: string, to: string) =>
    request<{ from: string; to: string; users: StaffSummary[] }>(
      `/audit/summary?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
    ),
  leadHistory: (leadId: string) => request<AuditEntry[]>(`/audit/lead/${leadId}`),

  enrichStatus: () => request<EnrichJob | null>("/leads/enrich"),
  startEnrich: (input: {
    ids?: string[];
    query?: LeadQuery;
    website?: boolean;
    google?: boolean;
    onlyMissing?: boolean;
  }) => request<EnrichJob>("/leads/enrich", json("POST", input)),
  cancelEnrich: () => request<EnrichJob>("/leads/enrich/cancel", json("POST")),

  listBackups: () =>
    request<{ enabled: boolean; keepDays: number; dir: string; backups: BackupInfo[] }>("/backups"),
  createBackup: () =>
    request<{ file: string; size: number; documents: number }>("/backups", json("POST")),
  downloadBackupUrl: (file: string) => `${API_URL}/backups/${encodeURIComponent(file)}/download`,

  renderWhatsApp: (leadId: string, body: string) =>
    request<WhatsAppMessage & { templateName?: string | null }>(
      "/whatsapp/render",
      json("POST", { leadId, body }),
    ),
  whatsappFormat: (leadId: string) => request<WhatsAppFormat>(`/whatsapp/format/${leadId}`),
  whatsappQueue: (input: {
    leadIds?: string[];
    query?: CampaignAudience["query"];
    body: string;
    onlyNotMessaged: boolean;
    skipLandlines?: boolean;
    useFormats?: boolean;
  }) =>
    request<{ total: number; mustUse: boolean; useFormats: boolean; items: WhatsAppQueueItem[] }>(
      "/whatsapp/queue",
      json("POST", input),
    ),
  setSearchWhatsapp: (searchId: string, templateId: string | null) =>
    request<SearchRecord & { leadsAssigned: number }>(
      `/searches/${searchId}/whatsapp`,
      json("PUT", { templateId }),
    ),
  setLeadWhatsapp: (leadId: string, templateId: string | null) =>
    request<Lead>(`/leads/${leadId}/whatsapp`, json("PUT", { templateId })),

  markRecipientReplied: (campaignId: string, recipientId: string) =>
    request<CampaignRecipient>(
      `/campaigns/${campaignId}/recipients/${recipientId}/replied`,
      json("POST", {}),
    ),
  testImap: (senderId: string) =>
    request<{ ok: true; checked: number; reply: number; unsubscribe: number; bounce: number }>(
      `/senders/${senderId}/test-imap`,
      json("POST"),
    ),

  analyzeImport: (rows: ImportRow[], options: ImportOptions) =>
    request<ImportAnalysis>("/imports/analyze", json("POST", { rows, options })),
  runImport: (rows: ImportRow[], options: ImportOptions, filename: string) =>
    request<ImportRecord>("/imports", json("POST", { rows, options, filename })),
  listImports: () => request<ImportRecord[]>("/imports"),
  undoImport: (id: string) =>
    request<{ deleted: number; kept: number }>(`/imports/${id}`, json("DELETE")),

  duplicates: (matchOn: MatchKey[]) =>
    request<DuplicateGroup[]>(`/leads/duplicates?matchOn=${matchOn.join(",")}`),
  ignoreDuplicates: (ids: string[]) =>
    request<{ ignored: number }>("/leads/duplicates/ignore", json("POST", { ids })),
  mergeLeads: (primaryId: string, duplicateIds: string[]) =>
    request<Lead>("/leads/merge", json("POST", { primaryId, duplicateIds })),

  listSenders: () => request<Sender[]>("/senders"),
  createSender: (input: SenderInput) => request<Sender>("/senders", json("POST", input)),
  updateSender: (id: string, input: Partial<SenderInput>) =>
    request<Sender>(`/senders/${id}`, json("PUT", input)),
  deleteSender: (id: string) => request<void>(`/senders/${id}`, json("DELETE")),
  testSender: (id: string, to: string) =>
    request<{ ok: true; to: string }>(`/senders/${id}/test`, json("POST", { to })),

  listTemplates: () => request<EmailTemplate[]>("/templates"),
  mergeFields: () => request<string[]>("/templates/fields"),
  createTemplate: (input: Pick<EmailTemplate, "name" | "subject" | "body" | "channel">) =>
    request<EmailTemplate>("/templates", json("POST", input)),
  updateTemplate: (id: string, input: Partial<Pick<EmailTemplate, "name" | "subject" | "body">>) =>
    request<EmailTemplate>(`/templates/${id}`, json("PUT", input)),
  deleteTemplate: (id: string) => request<void>(`/templates/${id}`, json("DELETE")),

  listCampaigns: () => request<Campaign[]>("/campaigns"),
  getCampaign: (id: string) =>
    request<{ campaign: Campaign; recipients: CampaignRecipient[] }>(`/campaigns/${id}`),
  createCampaign: (input: CampaignInput) => request<Campaign>("/campaigns", json("POST", input)),
  updateCampaign: (id: string, input: CampaignInput) =>
    request<Campaign>(`/campaigns/${id}`, json("PUT", input)),
  deleteCampaign: (id: string) => request<void>(`/campaigns/${id}`, json("DELETE")),
  startCampaign: (id: string) => request<Campaign>(`/campaigns/${id}/start`, json("POST")),
  pauseCampaign: (id: string) => request<Campaign>(`/campaigns/${id}/pause`, json("POST")),
  resumeCampaign: (id: string) => request<Campaign>(`/campaigns/${id}/resume`, json("POST")),
  cancelCampaign: (id: string) => request<Campaign>(`/campaigns/${id}/cancel`, json("POST")),
  campaignAudience: (input: {
    audience: CampaignAudience;
    options: CampaignOptions;
    campaignId?: string;
  }) => request<AudienceSummary>("/campaigns/audience", json("POST", input)),
  previewEmail: (input: {
    subject: string;
    body: string;
    senderId: string | null;
    leadId?: string | undefined;
    audience?: CampaignAudience;
    options?: CampaignOptions;
  }) => request<EmailPreview>("/campaigns/preview", json("POST", input)),
  sendTestEmail: (input: {
    to: string;
    subject: string;
    body: string;
    senderId: string | null;
    leadId?: string | undefined;
    audience?: CampaignAudience;
  }) =>
    request<{ ok: true; to: string; lead: string | null }>("/campaigns/test", json("POST", input)),

  listSuppressions: () => request<Suppression[]>("/suppressions"),
  addSuppressions: (emails: string[], reason = "manual") =>
    request<{ added: number }>("/suppressions", json("POST", { emails, reason })),
  removeSuppression: (email: string) =>
    request<void>(`/suppressions/${encodeURIComponent(email)}`, json("DELETE")),

  getSettings: () => request<AppSettings>("/settings"),
  updateSettings: (patch: SettingsUpdate) => request<AppSettings>("/settings", json("PUT", patch)),
};
