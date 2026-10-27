import { useEffect, useRef, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  AlertTriangle,
  Plus,
  Reply,
  Repeat,
  ArrowLeft,
  Ban,
  CheckCircle2,
  Clock,
  Eye,
  FileText,
  Loader2,
  Mail,
  MailCheck,
  Pause,
  Play,
  Save,
  Send,
  Users,
  XCircle,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { CampaignStatusBadge } from "@/components/CampaignStatusBadge";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { STAGES } from "@/components/CrmBadges";
import { EmailEditor } from "@/components/EmailEditor";
import { EmptyState } from "@/components/EmptyState";
import {
  queryKeys,
  useCampaign,
  useInvalidateData,
  useLeadFacets,
  useSearches,
  useSenders,
  useTemplates,
} from "@/hooks/queries";
import { ApiError, api } from "@/lib/api";
import { formatDateTime, formatNumber, relativeTime } from "@/utils/format";
import type { Campaign, CampaignAudience, CampaignOptions, CampaignRecipient } from "@/types";
import { RequirePermission } from "@/components/RequirePermission";

export const Route = createFileRoute("/campaigns_/$id")({
  head: () => ({ meta: [{ title: "Campaign — LeadFinder Pro" }] }),
  component: () => (
    <RequirePermission permission="campaigns">
      <CampaignPage />
    </RequirePermission>
  ),
});

const DELAYS = [15, 30, 45, 60, 90, 120, 300];
const OPEN_STAGES = "new,contacted,qualified,proposal";

function useDebounced<T>(value: T, ms = 600): T {
  const [debounced, setDebounced] = useState(value);
  const key = JSON.stringify(value);
  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(value), ms);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, ms]);
  return debounced;
}

function formatEta(seconds: number): string {
  if (seconds < 90) return "about a minute";
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `about ${minutes} minutes`;
  const hours = Math.round((minutes / 60) * 10) / 10;
  return `about ${hours} hours`;
}

function CampaignPage() {
  const { id } = Route.useParams();
  const { data, isPending, isError, error } = useCampaign(id);

  if (isPending) {
    return (
      <div className="flex justify-center py-24 text-muted-foreground">
        <Loader2 className="h-6 w-6 animate-spin" />
      </div>
    );
  }
  if (isError) {
    return (
      <EmptyState
        icon={Mail}
        title="Campaign not found"
        description={error.message}
        action={
          <Button asChild variant="outline">
            <Link to="/campaigns">
              <ArrowLeft className="h-4 w-4" /> All campaigns
            </Link>
          </Button>
        }
      />
    );
  }
  // key: remount the editor with fresh state when switching between draft and sent views.
  return data.campaign.status === "draft" ? (
    <CampaignEditor key={data.campaign.id} campaign={data.campaign} />
  ) : (
    <CampaignProgress campaign={data.campaign} recipients={data.recipients} />
  );
}

/* --------------------------------- Editor -------------------------------- */

type Draft = Pick<
  Campaign,
  "name" | "senderId" | "subject" | "body" | "audience" | "options" | "followUps"
>;

const FOLLOW_UP_DELAYS = [1, 2, 3, 4, 5, 7, 10, 14];
const FOLLOW_UP_SUGGESTIONS = [
  "Hi {{firstName|there}},\n\nJust bumping this to the top of your inbox in case it got buried. Would it be worth a quick chat about {{businessName}}?\n\nThanks,",
  "Hi {{firstName|there}},\n\nI don't want to be a bother, so this is my last note. If improving {{businessName}}'s online presence is ever on your list, just reply and I'll be happy to help.\n\nAll the best,",
];

const toDraft = (c: Campaign): Draft => ({
  name: c.name,
  senderId: c.senderId,
  subject: c.subject,
  body: c.body,
  audience: c.audience,
  options: c.options,
  followUps: c.followUps ?? [],
});

function CampaignEditor({ campaign }: { campaign: Campaign }) {
  const qc = useQueryClient();
  const { data: senders = [] } = useSenders();
  const { data: templates = [] } = useTemplates();
  const [draft, setDraft] = useState<Draft>(() => toDraft(campaign));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const lastSaved = useRef(JSON.stringify(toDraft(campaign)));
  const [sampleLeadId, setSampleLeadId] = useState<string | undefined>();
  const [testTo, setTestTo] = useState("");
  const [testing, setTesting] = useState(false);
  const [confirmStart, setConfirmStart] = useState(false);
  const [starting, setStarting] = useState(false);

  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));
  const sender = senders.find((s) => s.id === draft.senderId) ?? null;

  // Pick the only sender automatically.
  useEffect(() => {
    if (!draft.senderId && senders.length === 1) set({ senderId: senders[0]!.id });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [senders.length]);

  /** Saves pending edits; returns false if the save failed. */
  async function flush(value: Draft = draft): Promise<boolean> {
    const json = JSON.stringify(value);
    if (json === lastSaved.current) return true;
    setSaving(true);
    try {
      await api.updateCampaign(campaign.id, value);
      lastSaved.current = json;
      void qc.invalidateQueries({ queryKey: queryKeys.campaigns, exact: true });
      return true;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save the campaign.");
      return false;
    } finally {
      setSaving(false);
    }
  }

  // Autosave shortly after the user stops typing.
  const debouncedDraft = useDebounced(draft, 900);
  useEffect(() => {
    void flush(debouncedDraft);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedDraft]);

  const audienceKey = useDebounced({ audience: draft.audience, options: draft.options }, 400);
  const audience = useQuery({
    queryKey: ["campaigns", "audience", campaign.id, audienceKey],
    queryFn: () => api.campaignAudience({ ...audienceKey, campaignId: campaign.id }),
  });

  const [previewStep, setPreviewStep] = useState(0);
  const step = previewStep > 0 ? draft.followUps[previewStep - 1] : undefined;
  const previewKey = useDebounced(
    {
      subject: step ? step.subject || `Re: ${draft.subject}` : draft.subject,
      body: step ? step.body : draft.body,
      senderId: draft.senderId,
      leadId: sampleLeadId,
      audience: draft.audience,
      options: draft.options,
    },
    500,
  );
  const preview = useQuery({
    queryKey: ["campaigns", "preview", campaign.id, previewKey],
    queryFn: () => api.previewEmail(previewKey),
    enabled: !!(previewKey.subject || previewKey.body),
  });

  async function sendTest() {
    const to = testTo.trim() || sender?.fromEmail || "";
    setTesting(true);
    try {
      await flush();
      const res = await api.sendTestEmail({
        to,
        subject: draft.subject,
        body: draft.body,
        senderId: draft.senderId,
        leadId: sampleLeadId,
        audience: draft.audience,
      });
      toast.success(`Test sent to ${res.to}${res.lead ? ` using ${res.lead}'s details` : ""}.`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Test failed.");
    } finally {
      setTesting(false);
    }
  }

  async function saveAsTemplate() {
    try {
      await api.createTemplate({
        name: draft.name,
        subject: draft.subject,
        body: draft.body,
        channel: "email",
      });
      toast.success("Saved as a template.");
      void qc.invalidateQueries({ queryKey: queryKeys.templates });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save the template.");
    }
  }

  async function start() {
    setStarting(true);
    try {
      if (!(await flush())) return;
      await api.startCampaign(campaign.id);
      toast.success(
        "Campaign started. You can leave this page — sending continues in the background.",
      );
      void qc.invalidateQueries({ queryKey: ["campaigns"] });
    } catch (err) {
      if (err instanceof ApiError && err.errors) setErrors(err.errors);
      toast.error(err instanceof Error ? err.message : "Could not start the campaign.");
    } finally {
      setStarting(false);
      setConfirmStart(false);
    }
  }

  const summary = audience.data;
  const willSend = summary?.willSend ?? 0;
  const ready =
    !!sender &&
    !!draft.subject.trim() &&
    !!draft.body.trim() &&
    willSend > 0 &&
    draft.followUps.every((f) => f.body.trim()) &&
    !preview.data?.unknownFields.length;
  const emailTemplates = templates.filter((t) => (t.channel ?? "email") === "email");

  const setFollowUp = (i: number, patch: Partial<Draft["followUps"][number]>) =>
    set({ followUps: draft.followUps.map((f, j) => (j === i ? { ...f, ...patch } : f)) });

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0 flex-1">
          <Link
            to="/campaigns"
            className="mb-2 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-primary"
          >
            <ArrowLeft className="h-3.5 w-3.5" /> All campaigns
          </Link>
          <div className="flex items-center gap-3">
            <Input
              value={draft.name}
              onChange={(e) => set({ name: e.target.value })}
              className="h-10 max-w-md font-display text-lg font-bold"
              aria-label="Campaign name"
            />
            <CampaignStatusBadge status="draft" />
            <span className="hidden text-xs text-muted-foreground sm:inline">
              {saving
                ? "Saving…"
                : JSON.stringify(draft) === lastSaved.current
                  ? "All changes saved"
                  : "Unsaved changes"}
            </span>
          </div>
        </div>
        <Button size="lg" disabled={!ready || starting} onClick={() => setConfirmStart(true)}>
          <Send className="h-4 w-4" /> Review & send
        </Button>
      </div>

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_26rem]">
        <div className="space-y-5">
          {/* 1. Sender */}
          <Card className="card-shadow rounded-xl">
            <CardHeader>
              <CardTitle className="font-display text-base font-semibold">1. From</CardTitle>
              <CardDescription>
                The mailbox this campaign sends from. Replies go to its inbox.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {senders.length === 0 ? (
                <div className="flex flex-wrap items-center gap-3 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-sm">
                  <AlertTriangle className="h-4 w-4" /> No sender accounts yet.
                  <Button asChild size="sm" variant="outline" className="ml-auto">
                    <Link to="/email-setup">Set up email</Link>
                  </Button>
                </div>
              ) : (
                <Select value={draft.senderId ?? ""} onValueChange={(v) => set({ senderId: v })}>
                  <SelectTrigger className="w-full sm:w-96" aria-invalid={!!errors["senderId"]}>
                    <SelectValue placeholder="Choose a sender" />
                  </SelectTrigger>
                  <SelectContent>
                    {senders.map((s) => (
                      <SelectItem key={s.id} value={s.id}>
                        {s.fromName} &lt;{s.fromEmail}&gt;
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </CardContent>
          </Card>

          {/* 2. Audience */}
          <AudienceCard
            audience={draft.audience}
            options={draft.options}
            onChange={(patch) => set(patch)}
            summary={summary}
            loading={audience.isFetching}
          />

          {/* 3. Email */}
          <Card className="card-shadow rounded-xl">
            <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
              <div>
                <CardTitle className="font-display text-base font-semibold">3. Email</CardTitle>
                <CardDescription>
                  Every email is personalised with each business's details.
                </CardDescription>
              </div>
              <div className="flex flex-wrap gap-2">
                <Select
                  value=""
                  onValueChange={(id) => {
                    const t = emailTemplates.find((x) => x.id === id);
                    if (t) {
                      set({ subject: t.subject, body: t.body });
                      toast.success(`Loaded “${t.name}”.`);
                    }
                  }}
                >
                  <SelectTrigger className="min-w-0 flex-1 sm:w-44 sm:flex-none">
                    <FileText className="h-4 w-4" />
                    <SelectValue placeholder="Use template" />
                  </SelectTrigger>
                  <SelectContent>
                    {emailTemplates.length === 0 && (
                      <div className="px-2 py-1.5 text-xs text-muted-foreground">
                        No templates yet — create them on the Templates page.
                      </div>
                    )}
                    {emailTemplates.map((t) => (
                      <SelectItem key={t.id} value={t.id}>
                        {t.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  variant="outline"
                  disabled={!draft.subject.trim() || !draft.body.trim()}
                  onClick={saveAsTemplate}
                >
                  <Save className="h-4 w-4" /> Save as template
                </Button>
              </div>
            </CardHeader>
            <CardContent>
              <EmailEditor
                subject={draft.subject}
                body={draft.body}
                errors={errors}
                onChange={(patch) => set(patch)}
              />
            </CardContent>
          </Card>

          {/* 4. Follow-ups */}
          <Card className="card-shadow rounded-xl">
            <CardHeader>
              <CardTitle className="font-display text-base font-semibold">4. Follow-ups</CardTitle>
              <CardDescription>
                Sent in the same conversation to people who haven't replied. They stop automatically
                when someone replies, unsubscribes or bounces — or when you mark the lead won or
                lost.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {draft.followUps.map((f, i) => (
                <div key={i} className="space-y-3 rounded-lg border border-border p-4">
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <span className="font-medium">Follow-up {i + 1}</span>
                    <span className="text-muted-foreground">if no reply after</span>
                    <Select
                      value={String(f.delayDays)}
                      onValueChange={(v) => setFollowUp(i, { delayDays: Number(v) })}
                    >
                      <SelectTrigger className="h-8 w-28">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {FOLLOW_UP_DELAYS.map((d) => (
                          <SelectItem key={d} value={String(d)}>
                            {d} day{d > 1 ? "s" : ""}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="ml-auto h-8 text-destructive"
                      onClick={() => set({ followUps: draft.followUps.filter((_, j) => j !== i) })}
                    >
                      Remove
                    </Button>
                  </div>
                  <EmailEditor
                    idPrefix={`followup-${i}`}
                    subject={f.subject}
                    body={f.body}
                    rows={6}
                    subjectPlaceholder={`Leave empty to reply in the same thread (Re: ${draft.subject || "…"})`}
                    errors={errors[`followUp${i}`] ? { body: errors[`followUp${i}`]! } : {}}
                    onChange={(patch) => setFollowUp(i, patch)}
                  />
                </div>
              ))}
              {draft.followUps.length < 5 && (
                <Button
                  variant="outline"
                  onClick={() =>
                    set({
                      followUps: [
                        ...draft.followUps,
                        {
                          delayDays: draft.followUps.length ? 4 : 3,
                          subject: "",
                          body: FOLLOW_UP_SUGGESTIONS[
                            Math.min(draft.followUps.length, FOLLOW_UP_SUGGESTIONS.length - 1)
                          ]!,
                        },
                      ],
                    })
                  }
                >
                  <Plus className="h-4 w-4" /> Add follow-up
                </Button>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Preview */}
        <div className="space-y-5 xl:sticky xl:top-20 xl:self-start">
          <Card className="card-shadow rounded-xl">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 font-display text-base font-semibold">
                <Eye className="h-4 w-4" /> Preview
                {preview.isFetching && (
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                )}
              </CardTitle>
              {draft.followUps.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {[0, ...draft.followUps.map((_, i) => i + 1)].map((s) => (
                    <button
                      key={s}
                      onClick={() => setPreviewStep(s)}
                      className={`rounded-md border px-2 py-0.5 text-xs ${
                        previewStep === s
                          ? "border-primary bg-primary/10 text-primary"
                          : "border-border text-muted-foreground hover:bg-muted"
                      }`}
                    >
                      {s === 0 ? "First email" : `Follow-up ${s}`}
                    </button>
                  ))}
                </div>
              )}
              {!!summary?.sample.length && (
                <Select
                  value={sampleLeadId ?? summary.sample[0]!.leadId}
                  onValueChange={setSampleLeadId}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {summary.sample.map((s) => (
                      <SelectItem key={s.leadId} value={s.leadId}>
                        As sent to {s.businessName}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </CardHeader>
            <CardContent className="space-y-3">
              {!!preview.data?.unknownFields.length && (
                <p className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
                  Unknown merge field{preview.data.unknownFields.length > 1 ? "s" : ""}:{" "}
                  {preview.data.unknownFields.map((f) => `{{${f}}}`).join(", ")} — check the
                  spelling.
                </p>
              )}
              <div className="space-y-1 rounded-lg border border-border bg-muted/40 p-3 text-xs">
                <p>
                  <span className="text-muted-foreground">From:</span>{" "}
                  {sender ? (
                    `${sender.fromName} <${sender.fromEmail}>`
                  ) : (
                    <em className="text-muted-foreground">choose a sender</em>
                  )}
                </p>
                <p>
                  <span className="text-muted-foreground">To:</span>{" "}
                  {preview.data?.lead?.email ?? (
                    <em className="text-muted-foreground">no recipient yet</em>
                  )}
                </p>
                <p className="font-semibold">
                  <span className="font-normal text-muted-foreground">Subject:</span>{" "}
                  {preview.data?.subject || "—"}
                </p>
              </div>
              <div className="max-h-[28rem] overflow-y-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-card p-4 text-sm leading-relaxed">
                {preview.data?.text || (
                  <span className="text-muted-foreground">Write your email to see a preview.</span>
                )}
              </div>
              <form
                className="flex gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  void sendTest();
                }}
              >
                <Input
                  type="email"
                  value={testTo}
                  onChange={(e) => setTestTo(e.target.value)}
                  placeholder={sender ? `Test to ${sender.fromEmail}` : "your@email.com"}
                  className="h-9"
                />
                <Button
                  type="submit"
                  variant="outline"
                  disabled={testing || !sender || !draft.subject.trim()}
                >
                  {testing ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <MailCheck className="h-4 w-4" />
                  )}{" "}
                  Send test
                </Button>
              </form>
            </CardContent>
          </Card>
        </div>
      </div>

      <ConfirmDialog
        open={confirmStart}
        onOpenChange={setConfirmStart}
        destructive={false}
        title={`Send to ${formatNumber(willSend)} businesses?`}
        description={
          <>
            From <strong>{sender?.fromEmail}</strong>, about one email every{" "}
            {draft.options.delaySeconds} seconds — finishes in{" "}
            {formatEta(willSend * draft.options.delaySeconds)}
            {sender &&
              willSend > sender.dailyLimit &&
              ` (spread over several days: this sender's limit is ${sender.dailyLimit} a day)`}
            {draft.followUps.length > 0 &&
              `, then up to ${draft.followUps.length} follow-up${draft.followUps.length > 1 ? "s" : ""} to anyone who doesn't reply`}
            . You can pause or cancel at any time.
          </>
        }
        confirmLabel={starting ? "Starting…" : "Start sending"}
        onConfirm={() => void start()}
      />
    </div>
  );
}

function AudienceCard({
  audience,
  options,
  onChange,
  summary,
  loading,
}: {
  audience: CampaignAudience;
  options: CampaignOptions;
  onChange: (patch: { audience?: CampaignAudience; options?: CampaignOptions }) => void;
  summary: Awaited<ReturnType<typeof api.campaignAudience>> | undefined;
  loading: boolean;
}) {
  const { data: searches = [] } = useSearches();
  const { data: facets } = useLeadFacets();
  const hasSelection = !!audience.leadIds?.length;
  const [mode, setMode] = useState<"selected" | "search" | "filter">(
    hasSelection ? "selected" : audience.query?.searchId ? "search" : "filter",
  );
  // Remember the hand-picked leads so switching away and back doesn't lose them.
  const [selection] = useState(audience.leadIds && audience.leadIds.length ? audience : null);
  const query = audience.query ?? {};
  const searchesWithLeads = searches.filter((s) => s.leadsFound > 0);

  const setFilter = (patch: NonNullable<CampaignAudience["query"]>) => {
    const next = { ...query, ...patch, searchId: undefined };
    const stage =
      next.stage === OPEN_STAGES ? "Open" : STAGES.find((s) => s.value === next.stage)?.label;
    const label =
      [stage && `${stage} leads`, next.tag && `#${next.tag}`, next.country]
        .filter(Boolean)
        .join(" · ") || "All leads";
    onChange({ audience: { query: next, label } });
  };

  return (
    <Card className="card-shadow rounded-xl">
      <CardHeader>
        <CardTitle className="font-display text-base font-semibold">2. To</CardTitle>
        <CardDescription>
          Choose which leads get this email. Only leads with an email address can be reached.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <Tabs
          value={mode}
          onValueChange={(v) => {
            const next = v as typeof mode;
            setMode(next);
            if (next === "selected" && selection) onChange({ audience: selection });
            if (next === "filter") setFilter({});
            if (next === "search" && searchesWithLeads[0]) {
              onChange({
                audience: {
                  query: { searchId: searchesWithLeads[0].id },
                  label: searchesWithLeads[0].name,
                },
              });
            }
          }}
        >
          <TabsList>
            {selection && <TabsTrigger value="selected">Selected leads</TabsTrigger>}
            <TabsTrigger value="search">From a search</TabsTrigger>
            <TabsTrigger value="filter">By stage / tag</TabsTrigger>
          </TabsList>
        </Tabs>

        {mode === "selected" && selection && (
          <p className="text-sm text-muted-foreground">
            {formatNumber(selection.leadIds!.length)} leads picked on the All Leads page.
          </p>
        )}

        {mode === "search" &&
          (searchesWithLeads.length === 0 ? (
            <p className="text-sm text-muted-foreground">No searches with leads yet.</p>
          ) : (
            <Select
              value={query.searchId ?? ""}
              onValueChange={(id) => {
                const s = searches.find((x) => x.id === id);
                onChange({ audience: { query: { searchId: id }, label: s?.name ?? "Search" } });
              }}
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Choose a search" />
              </SelectTrigger>
              <SelectContent>
                {searchesWithLeads.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.name} · {formatNumber(s.leadsFound)} leads · {formatDateTime(s.date)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ))}

        {mode === "filter" && (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Select
              value={query.stage ?? "__all"}
              onValueChange={(v) => setFilter({ stage: v === "__all" ? undefined : v })}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__all">All stages</SelectItem>
                <SelectItem value={OPEN_STAGES}>Open (not closed)</SelectItem>
                {STAGES.map((s) => (
                  <SelectItem key={s.value} value={s.value}>
                    {s.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={query.tag ?? "__all"}
              onValueChange={(v) => setFilter({ tag: v === "__all" ? undefined : v })}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__all">Any tag</SelectItem>
                {facets?.tags.map((t) => (
                  <SelectItem key={t} value={t}>
                    {t}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={query.country ?? "__all"}
              onValueChange={(v) => setFilter({ country: v === "__all" ? undefined : v })}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__all">Any country</SelectItem>
                {facets?.countries.map((c) => (
                  <SelectItem key={c} value={c}>
                    {c}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        {/* Reach */}
        <div className="rounded-lg border border-border bg-muted/40 p-3">
          <div className="flex items-baseline gap-2">
            <Users className="h-4 w-4 self-center text-muted-foreground" />
            <span className="font-display text-2xl font-bold">
              {summary ? formatNumber(summary.willSend) : "—"}
            </span>
            <span className="text-sm text-muted-foreground">will receive this email</span>
            {loading && (
              <Loader2 className="h-3.5 w-3.5 animate-spin self-center text-muted-foreground" />
            )}
          </div>
          {summary && (
            <ul className="mt-2 space-y-0.5 text-xs text-muted-foreground">
              <li>{formatNumber(summary.matched)} leads match</li>
              {summary.noEmail > 0 && (
                <li>{formatNumber(summary.noEmail)} have no email address</li>
              )}
              {summary.skipped.map((s) => (
                <li key={s.reason}>
                  {formatNumber(s.count)} skipped — {s.reason.toLowerCase()}
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Sending options */}
        <div className="grid grid-cols-1 gap-3 border-t border-border pt-4 sm:grid-cols-3">
          <div className="space-y-1.5">
            <Label>Pace</Label>
            <Select
              value={String(options.delaySeconds)}
              onValueChange={(v) => onChange({ options: { ...options, delaySeconds: Number(v) } })}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(DELAYS.includes(options.delaySeconds)
                  ? DELAYS
                  : [...DELAYS, options.delaySeconds].sort((a, b) => a - b)
                ).map((d) => (
                  <SelectItem key={d} value={String(d)}>
                    1 email every {d < 60 ? `${d}s` : `${d / 60} min`}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-[11px] text-muted-foreground">
              Slower sending looks less like spam.
            </p>
          </div>
          <p className="rounded-lg border border-border p-3 text-[11px] text-muted-foreground">
            <span className="block text-sm font-medium text-foreground">One email per address</span>
            Addresses an earlier campaign already reached are always skipped.
          </p>
          <Label className="flex items-start justify-between gap-3 rounded-lg border border-border p-3 font-normal">
            <span>
              <span className="block text-sm font-medium">Skip won & lost</span>
              <span className="block text-[11px] text-muted-foreground">
                Leave closed deals alone.
              </span>
            </span>
            <Switch
              checked={options.skipClosed}
              onCheckedChange={(v) => onChange({ options: { ...options, skipClosed: v } })}
            />
          </Label>
        </div>
      </CardContent>
    </Card>
  );
}

/* -------------------------------- Progress ------------------------------- */

const RECIPIENT_STATUS: Record<
  CampaignRecipient["status"],
  { label: string; icon: typeof Mail; className: string }
> = {
  sent: { label: "Sent", icon: CheckCircle2, className: "text-success" },
  failed: { label: "Failed", icon: XCircle, className: "text-destructive" },
  skipped: { label: "Skipped", icon: Ban, className: "text-muted-foreground" },
  queued: { label: "Queued", icon: Clock, className: "text-primary" },
};

function CampaignProgress({
  campaign,
  recipients,
}: {
  campaign: Campaign;
  recipients: CampaignRecipient[];
}) {
  const qc = useQueryClient();
  const invalidateData = useInvalidateData();
  const { data: senders = [] } = useSenders();
  const [tab, setTab] = useState<"all" | "replied" | CampaignRecipient["status"]>("all");
  const [busy, setBusy] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const sender = senders.find((s) => s.id === campaign.senderId);

  // Sent emails update leads (timeline, stage), so refresh CRM data as progress arrives.
  const sentRef = useRef(campaign.sent);
  useEffect(() => {
    if (campaign.sent !== sentRef.current) {
      sentRef.current = campaign.sent;
      void invalidateData();
    }
  }, [campaign.sent, invalidateData]);

  async function run(action: () => Promise<unknown>, success: string) {
    setBusy(true);
    try {
      await action();
      toast.success(success);
      await qc.invalidateQueries({ queryKey: ["campaigns"] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  const queued = Math.max(0, campaign.total - campaign.sent - campaign.failed);
  const done = campaign.sent + campaign.failed;
  const visible =
    tab === "all"
      ? recipients
      : tab === "replied"
        ? recipients.filter((r) => r.repliedAt)
        : recipients.filter((r) => r.status === tab);
  const replyRate = campaign.sent ? Math.round((campaign.replied / campaign.sent) * 100) : 0;
  const steps = 1 + (campaign.followUps?.length ?? 0);
  const counts = {
    sent: campaign.sent,
    failed: campaign.failed,
    skipped: campaign.skipped,
    queued,
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <Link
            to="/campaigns"
            className="mb-2 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-primary"
          >
            <ArrowLeft className="h-3.5 w-3.5" /> All campaigns
          </Link>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="font-display text-xl font-bold">{campaign.name}</h2>
            <CampaignStatusBadge status={campaign.status} />
          </div>
          <p className="text-sm text-muted-foreground">
            {campaign.audience.label} · from{" "}
            {sender ? `${sender.fromName} <${sender.fromEmail}>` : "a removed sender"}
            {campaign.startedAt && ` · started ${relativeTime(campaign.startedAt)}`}
          </p>
        </div>
        <div className="flex gap-2">
          {campaign.status === "sending" && (
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => run(() => api.pauseCampaign(campaign.id), "Campaign paused.")}
            >
              <Pause className="h-4 w-4" /> Pause
            </Button>
          )}
          {campaign.status === "paused" && (
            <Button
              disabled={busy}
              onClick={() => run(() => api.resumeCampaign(campaign.id), "Sending resumed.")}
            >
              <Play className="h-4 w-4" /> Resume
            </Button>
          )}
          {(campaign.status === "sending" || campaign.status === "paused") && (
            <Button variant="ghost" disabled={busy} onClick={() => setConfirmCancel(true)}>
              <XCircle className="h-4 w-4" /> Cancel
            </Button>
          )}
        </div>
      </div>

      {campaign.status === "paused" && campaign.lastError && (
        <div className="flex items-start gap-3 rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            <p className="font-medium">Sending stopped: {campaign.lastError}</p>
            <p className="mt-0.5 text-xs">
              Fix the sender on the{" "}
              <Link to="/email-setup" className="underline">
                Email setup
              </Link>{" "}
              page, then press Resume.
            </p>
          </div>
        </div>
      )}

      <Card className="card-shadow rounded-xl">
        <CardContent className="space-y-4 p-5">
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            {(Object.keys(RECIPIENT_STATUS) as CampaignRecipient["status"][]).map((key) => {
              const meta = RECIPIENT_STATUS[key];
              return (
                <div key={key}>
                  <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <meta.icon className={`h-3.5 w-3.5 ${meta.className}`} /> {meta.label}
                  </p>
                  <p className="font-display text-2xl font-bold">{formatNumber(counts[key])}</p>
                </div>
              );
            })}
          </div>
          <div className="grid grid-cols-2 gap-4 border-t border-border pt-4 sm:grid-cols-4">
            {[
              {
                label: "Replied",
                value: campaign.replied ?? 0,
                note: `${replyRate}% reply rate`,
                icon: Reply,
                tone: "text-success",
              },
              {
                label: "Follow-ups sent",
                value: campaign.followUpsSent ?? 0,
                note: `${steps - 1} step${steps === 2 ? "" : "s"} in sequence`,
                icon: Repeat,
                tone: "text-primary",
              },
              {
                label: "Unsubscribed",
                value: campaign.unsubscribed ?? 0,
                note: "added to do-not-email",
                icon: Ban,
                tone: "text-muted-foreground",
              },
              {
                label: "Bounced",
                value: campaign.bounced ?? 0,
                note: "address doesn't exist",
                icon: XCircle,
                tone: "text-destructive",
              },
            ].map((s) => (
              <div key={s.label}>
                <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <s.icon className={`h-3.5 w-3.5 ${s.tone}`} /> {s.label}
                </p>
                <p className="font-display text-2xl font-bold">{formatNumber(s.value)}</p>
                <p className="text-[11px] text-muted-foreground">{s.note}</p>
              </div>
            ))}
          </div>
          {!sender?.imap?.enabled && (
            <p className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
              Reply tracking is off for this sender, so replies aren't detected automatically. Turn
              it on in{" "}
              <Link to="/email-setup" className="underline">
                Email setup
              </Link>
              , or use “Mark replied” below.
            </p>
          )}
          <Progress value={campaign.total ? (done / campaign.total) * 100 : 0} className="h-2" />
          <p className="text-xs text-muted-foreground">
            {campaign.statusText}
            {campaign.status === "sending" &&
              queued > 0 &&
              ` · ${formatNumber(queued)} left, ${formatEta(queued * campaign.options.delaySeconds)}`}
            {campaign.status === "sending" &&
              campaign.nextSendAt &&
              new Date(campaign.nextSendAt).getTime() - Date.now() > 3600000 &&
              ` · next email ${formatDateTime(campaign.nextSendAt)}`}
          </p>
        </CardContent>
      </Card>

      <Card className="card-shadow rounded-xl py-0">
        <div className="border-b border-border px-4 py-3">
          <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)}>
            <TabsList>
              <TabsTrigger value="all">All ({formatNumber(recipients.length)})</TabsTrigger>
              <TabsTrigger value="sent">Sent</TabsTrigger>
              <TabsTrigger value="replied">
                Replied ({formatNumber(campaign.replied ?? 0)})
              </TabsTrigger>
              <TabsTrigger value="queued">Queued</TabsTrigger>
              <TabsTrigger value="failed">Failed</TabsTrigger>
              <TabsTrigger value="skipped">Skipped</TabsTrigger>
            </TabsList>
          </Tabs>
        </div>
        <CardContent className="p-0">
          {visible.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted-foreground">Nothing here.</p>
          ) : (
            <div className="max-h-[36rem] overflow-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="pl-4">Business</TableHead>
                    <TableHead>Email</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="hidden md:table-cell">Details</TableHead>
                    <TableHead className="w-32" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {visible.slice(0, 1000).map((r) => {
                    const meta = RECIPIENT_STATUS[r.status];
                    return (
                      <TableRow key={r.id}>
                        <TableCell className="pl-4">
                          <Link
                            to="/leads/$id"
                            params={{ id: r.leadId }}
                            className="font-medium hover:text-primary"
                          >
                            {r.businessName}
                          </Link>
                        </TableCell>
                        <TableCell className="text-muted-foreground">{r.email}</TableCell>
                        <TableCell>
                          <span
                            className={`inline-flex items-center gap-1 text-sm ${meta.className}`}
                          >
                            <meta.icon className="h-3.5 w-3.5" /> {meta.label}
                          </span>
                          {r.repliedAt && (
                            <Badge
                              variant="outline"
                              className="ml-1 border-success/30 bg-success/10 text-success"
                            >
                              Replied
                            </Badge>
                          )}
                          {r.unsubscribedAt && (
                            <Badge variant="outline" className="ml-1">
                              Unsubscribed
                            </Badge>
                          )}
                          {r.bouncedAt && (
                            <Badge
                              variant="outline"
                              className="ml-1 border-destructive/30 text-destructive"
                            >
                              Bounced
                            </Badge>
                          )}
                        </TableCell>
                        <TableCell
                          className="hidden max-w-sm truncate text-xs text-muted-foreground md:table-cell"
                          title={r.reason ?? r.subject ?? ""}
                        >
                          {r.repliedAt
                            ? `“${r.replySnippet ?? ""}”`
                            : r.status === "sent" && r.sentAt
                              ? `${r.step > 0 ? `Follow-up ${r.step} of ${steps - 1} sent` : formatDateTime(r.sentAt)}${
                                  r.nextStepAt ? ` · next ${formatDateTime(r.nextStepAt)}` : ""
                                } · ${r.subject}`
                              : r.reason}
                        </TableCell>
                        <TableCell className="text-right">
                          {r.status === "sent" &&
                            !r.repliedAt &&
                            !r.unsubscribedAt &&
                            !r.bouncedAt && (
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-7 text-xs"
                                disabled={busy}
                                onClick={() =>
                                  run(
                                    () => api.markRecipientReplied(campaign.id, r.id),
                                    `${r.businessName} marked as replied — no more follow-ups.`,
                                  )
                                }
                              >
                                Mark replied
                              </Button>
                            )}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <ConfirmDialog
        open={confirmCancel}
        onOpenChange={setConfirmCancel}
        title="Cancel this campaign?"
        description={`The ${formatNumber(queued)} emails not sent yet will be skipped. Emails already sent can't be recalled.`}
        confirmLabel="Cancel campaign"
        onConfirm={() => {
          setConfirmCancel(false);
          void run(() => api.cancelCampaign(campaign.id), "Campaign cancelled.");
        }}
      />
    </div>
  );
}
