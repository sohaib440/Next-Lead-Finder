import { useMemo, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  AlertTriangle,
  Lock,
  CheckCircle2,
  ListChecks,
  Loader2,
  MessageCircle,
  Save,
  SkipForward,
  XCircle,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { STAGES } from "@/components/CrmBadges";
import { MERGE_FIELDS } from "@/components/EmailEditor";
import { OpportunityBadge } from "@/components/LeadInsights";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import {
  DEFAULT_WHATSAPP_MESSAGE,
  WhatsAppResultStep,
  openWhatsApp,
} from "@/components/WhatsAppDialog";
import {
  queryKeys,
  useAuth,
  useInvalidateData,
  useLeadFacets,
  useSearches,
  useSettings,
  useTemplates,
} from "@/hooks/queries";
import { api } from "@/lib/api";
import { formatDateTime, formatNumber } from "@/utils/format";
import type { CampaignAudience, WhatsAppQueueItem, WhatsAppResult } from "@/types";

export const Route = createFileRoute("/whatsapp")({
  validateSearch: (params: Record<string, unknown>): { leadIds?: string | undefined } => ({
    leadIds:
      typeof params["leadIds"] === "string" && params["leadIds"] ? params["leadIds"] : undefined,
  }),
  head: () => ({
    meta: [
      { title: "WhatsApp outreach — LeadFinder Pro" },
      {
        name: "description",
        content: "Send personalised WhatsApp messages to your leads, one click each.",
      },
    ],
  }),
  component: WhatsAppPage,
});

const ALL = "__all__";
const OPEN_STAGES = "new,contacted,qualified,proposal";

function WhatsAppPage() {
  const { leadIds } = Route.useSearch();
  const selectedIds = useMemo(() => leadIds?.split(",").filter(Boolean) ?? [], [leadIds]);
  const qc = useQueryClient();
  const invalidateData = useInvalidateData();
  const { data: searches = [] } = useSearches();
  const { data: facets } = useLeadFacets();
  const { data: templates = [] } = useTemplates();
  const waTemplates = templates.filter((t) => t.channel === "whatsapp");

  const [mode, setMode] = useState<"selected" | "search" | "filter">(
    selectedIds.length ? "selected" : "filter",
  );
  const [query, setQuery] = useState<NonNullable<CampaignAudience["query"]>>({
    stage: OPEN_STAGES,
  });
  const [body, setBody] = useState(DEFAULT_WHATSAPP_MESSAGE);
  const [queue, setQueue] = useState<WhatsAppQueueItem[] | null>(null);
  // What happened to each opened chat, and the chat waiting for an answer.
  const [outcomes, setOutcomes] = useState<Map<string, WhatsAppResult>>(new Map());
  const [awaiting, setAwaiting] = useState<WhatsAppQueueItem | null>(null);
  const [recording, setRecording] = useState(false);
  const [skipLandlines, setSkipLandlines] = useState(true);
  const [skipped, setSkipped] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const { isAdmin } = useAuth();
  const { settings } = useSettings();
  // Staff send the message the admin set for each lead's campaign; admins may choose to.
  const mustUse = !isAdmin && settings.whatsappStaffMustUseFormat;
  const [campaignFormats, setCampaignFormats] = useState(true);
  const usingFormats = mustUse || campaignFormats;

  async function build() {
    setLoading(true);
    try {
      const res = await api.whatsappQueue({
        ...(mode === "selected" ? { leadIds: selectedIds } : { query }),
        body,
        skipLandlines,
        useFormats: usingFormats,
      });
      setQueue(res.items);
      setOutcomes(new Map());
      setSkipped(new Set());
      if (!res.items.length)
        toast.info("No leads with a phone number match — or they've all been messaged already.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not build the list.");
    } finally {
      setLoading(false);
    }
  }

  function send(item: WhatsAppQueueItem) {
    if (!item.url) return;
    openWhatsApp(item.url);
    setAwaiting(item);
  }

  async function record(result: WhatsAppResult) {
    if (!awaiting) return;
    setRecording(true);
    try {
      await api.whatsappResult(awaiting.leadId, { result, text: awaiting.text });
      setOutcomes((m) => new Map(m).set(awaiting.leadId, result));
      setAwaiting(null);
    } catch (err) {
      toast.error(
        err instanceof Error
          ? err.message
          : `Couldn't save the result for ${awaiting.businessName}.`,
      );
    } finally {
      setRecording(false);
    }
  }

  const sendable = queue?.filter((i) => i.url) ?? [];
  const next = sendable.find((i) => !outcomes.has(i.leadId) && !skipped.has(i.leadId));
  const finished = outcomes.size + skipped.size;
  const count = (r: WhatsAppResult) => [...outcomes.values()].filter((v) => v === r).length;

  async function saveTemplate() {
    const name = `WhatsApp message ${new Date().toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;
    try {
      await api.createTemplate({ name, channel: "whatsapp", subject: "", body });
      toast.success(`Saved as “${name}”. Rename it on the Templates page.`);
      void qc.invalidateQueries({ queryKey: queryKeys.templates });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save the template.");
    }
  }

  return (
    <div className="w-full space-y-5">
      <div>
        <h2 className="font-display text-xl font-bold">WhatsApp outreach</h2>
        <p className="text-sm text-muted-foreground">
          Each chat opens in WhatsApp with a personal message ready — you press send. Free, no API
          needed, and every message is logged on the lead.
        </p>
      </div>

      {!queue ? (
        <div className="grid grid-cols-1 items-stretch gap-5 lg:grid-cols-2">
          <Card className="card-shadow rounded-xl">
            <CardHeader>
              <CardTitle className="font-display text-base font-semibold">1. Who</CardTitle>
              <CardDescription>
                Only leads with a phone number are included. Won and lost leads are left out.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <Tabs value={mode} onValueChange={(v) => setMode(v as typeof mode)}>
                <TabsList>
                  {selectedIds.length > 0 && (
                    <TabsTrigger value="selected">Selected ({selectedIds.length})</TabsTrigger>
                  )}
                  <TabsTrigger value="search">From a search</TabsTrigger>
                  <TabsTrigger value="filter">By stage / tag</TabsTrigger>
                </TabsList>
              </Tabs>
              {mode === "selected" && (
                <p className="text-sm text-muted-foreground">
                  {selectedIds.length} leads picked on the All Leads page.
                </p>
              )}
              {mode === "search" && (
                <Select
                  value={query.searchId ?? ""}
                  onValueChange={(id) => setQuery({ searchId: id })}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Choose a search" />
                  </SelectTrigger>
                  <SelectContent>
                    {searches
                      .filter((s) => s.leadsFound > 0)
                      .map((s) => (
                        <SelectItem key={s.id} value={s.id}>
                          {s.name} · {formatNumber(s.leadsFound)} leads
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              )}
              {mode === "filter" && (
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <Select
                    value={query.stage ?? ALL}
                    onValueChange={(v) =>
                      setQuery({ ...query, searchId: undefined, stage: v === ALL ? undefined : v })
                    }
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={ALL}>All stages</SelectItem>
                      <SelectItem value={OPEN_STAGES}>Open (not closed)</SelectItem>
                      {STAGES.map((s) => (
                        <SelectItem key={s.value} value={s.value}>
                          {s.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Select
                    value={query.tag ?? ALL}
                    onValueChange={(v) =>
                      setQuery({ ...query, searchId: undefined, tag: v === ALL ? undefined : v })
                    }
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={ALL}>Any tag</SelectItem>
                      {facets?.tags.map((t) => (
                        <SelectItem key={t} value={t}>
                          {t}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Label className="flex items-center gap-2 font-normal sm:col-span-2">
                    <Checkbox
                      checked={query.missing === "website"}
                      onCheckedChange={(v) =>
                        setQuery({
                          ...query,
                          searchId: undefined,
                          missing: v === true ? "website" : undefined,
                        })
                      }
                    />
                    Only businesses without a website (best for web design offers)
                  </Label>
                </div>
              )}
              <Label className="flex items-center gap-2 border-t border-border pt-4 font-normal">
                <Checkbox
                  checked={skipLandlines}
                  onCheckedChange={(v) => setSkipLandlines(v === true)}
                />
                Skip landline numbers (they almost never have WhatsApp)
              </Label>
              <p className="text-xs text-muted-foreground">
                Numbers already messaged (by anyone) and numbers marked “Not on WhatsApp” are always
                left out — each number gets one message.
              </p>
            </CardContent>
          </Card>

          <Card className="card-shadow rounded-xl">
            <CardHeader className="flex flex-row items-start justify-between gap-3">
              <div>
                <CardTitle className="font-display text-base font-semibold">2. Message</CardTitle>
                <CardDescription>Personal details are filled in for each business.</CardDescription>
              </div>
              {isAdmin && !usingFormats && (
                <Button size="sm" variant="ghost" onClick={saveTemplate} disabled={!body.trim()}>
                  <Save className="h-4 w-4" /> Save
                </Button>
              )}
            </CardHeader>
            <CardContent className="space-y-3">
              {isAdmin && (
                <Label className="flex items-start gap-2.5 rounded-lg border border-border p-3 font-normal">
                  <Checkbox
                    className="mt-0.5"
                    checked={campaignFormats}
                    onCheckedChange={(v) => setCampaignFormats(v === true)}
                  />
                  <span>
                    <span className="block text-sm font-medium">Use each lead's message</span>
                    <span className="block text-xs text-muted-foreground">
                      The message assigned to that lead, or the one you set for its campaign
                      (Search History → WhatsApp message).
                    </span>
                  </span>
                </Label>
              )}
              {usingFormats ? (
                <p className="flex items-start gap-2 rounded-lg bg-muted px-3 py-2.5 text-sm text-muted-foreground">
                  <Lock className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>
                    Each business gets the message assigned to it, personalised with its details.
                    {isAdmin
                      ? ""
                      : " You'll see every message in the list before opening WhatsApp."}
                  </span>
                </p>
              ) : (
                <>
                  {waTemplates.length > 0 && (
                    <Select
                      value=""
                      onValueChange={(id) => {
                        const t = waTemplates.find((x) => x.id === id);
                        if (t) setBody(t.body);
                      }}
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue placeholder="Use a WhatsApp template" />
                      </SelectTrigger>
                      <SelectContent>
                        {waTemplates.map((t) => (
                          <SelectItem key={t.id} value={t.id}>
                            {t.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                  <Textarea rows={9} value={body} onChange={(e) => setBody(e.target.value)} />
                  <div className="flex flex-wrap gap-1">
                    {MERGE_FIELDS.filter((f) => f.key !== "signature").map((f) => (
                      <button
                        key={f.key}
                        type="button"
                        onClick={() =>
                          setBody((b) => `${b}${b.endsWith(" ") || !b ? "" : " "}${f.example}`)
                        }
                        className="rounded-md border border-border bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground hover:border-primary hover:text-primary"
                      >
                        {f.label}
                      </button>
                    ))}
                  </div>
                  <p className="text-[11px] text-muted-foreground">
                    Use *bold* and _italic_ as in WhatsApp. Keep it short and personal.
                  </p>
                </>
              )}
            </CardContent>
          </Card>

          <div className="flex justify-end lg:col-span-2">
            <Button
              size="lg"
              onClick={build}
              disabled={
                loading || (!usingFormats && !body.trim()) || (mode === "search" && !query.searchId)
              }
            >
              {loading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <ListChecks className="h-4 w-4" />
              )}{" "}
              Build send list
            </Button>
          </div>
        </div>
      ) : (
        <>
          <Card className="card-shadow rounded-xl">
            <CardContent className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center">
              <div className="min-w-0 flex-1 space-y-2">
                <p className="text-sm">
                  <span className="font-display text-2xl font-bold">
                    {formatNumber(count("sent"))}
                  </span>
                  <span className="text-muted-foreground">
                    {" "}
                    of {formatNumber(sendable.length)} sent
                  </span>
                  {count("not_on_whatsapp") > 0 && (
                    <span className="text-destructive">
                      {" "}
                      · {count("not_on_whatsapp")} not on WhatsApp
                    </span>
                  )}
                  {count("not_sent") > 0 && (
                    <span className="text-muted-foreground"> · {count("not_sent")} not sent</span>
                  )}
                  {skipped.size > 0 && (
                    <span className="text-muted-foreground"> · {skipped.size} skipped</span>
                  )}
                </p>
                <Progress
                  value={sendable.length ? (finished / sendable.length) * 100 : 0}
                  className="h-2"
                />
                <p className="text-xs text-muted-foreground">
                  Tip: with the WhatsApp desktop app installed, chats open there instead of a new
                  browser tab. Pace yourself — sending hundreds of messages quickly can get a number
                  restricted.
                </p>
              </div>
              <div className="flex shrink-0 gap-2">
                <Button variant="ghost" onClick={() => setQueue(null)}>
                  Back
                </Button>
                {next ? (
                  <Button
                    size="lg"
                    className="bg-success text-success-foreground hover:bg-success/90"
                    disabled={!!awaiting}
                    onClick={() => send(next)}
                  >
                    <MessageCircle className="h-4 w-4" /> Open next:{" "}
                    {next.businessName.slice(0, 24)}
                  </Button>
                ) : (
                  <Button
                    size="lg"
                    onClick={() => {
                      void invalidateData();
                      setQueue(null);
                    }}
                  >
                    <CheckCircle2 className="h-4 w-4" /> All done
                  </Button>
                )}
              </div>
            </CardContent>
          </Card>

          <Card className="card-shadow rounded-xl py-0">
            <CardContent className="p-0">
              <div className="max-h-[36rem] overflow-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="pl-4">Business</TableHead>
                      <TableHead>Number</TableHead>
                      <TableHead className="hidden md:table-cell">Opportunity</TableHead>
                      <TableHead className="w-48" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {queue.map((item) => {
                      const outcome = outcomes.get(item.leadId);
                      const isDone = !!outcome;
                      const isSkipped = skipped.has(item.leadId);
                      return (
                        <TableRow
                          key={item.leadId}
                          className={isDone || isSkipped ? "opacity-50" : undefined}
                        >
                          <TableCell className="pl-4">
                            <Link
                              to="/leads/$id"
                              params={{ id: item.leadId }}
                              className="font-medium hover:text-primary"
                              target="_blank"
                            >
                              {item.businessName}
                            </Link>
                            <p className="text-xs text-muted-foreground">
                              {item.city}
                              {item.lastMessagedAt &&
                                ` · last messaged ${formatDateTime(item.lastMessagedAt)}`}
                            </p>
                            {item.text && (
                              <details className="mt-1 text-xs">
                                <summary className="cursor-pointer text-primary">
                                  {item.templateName ? `Message: ${item.templateName}` : "Message"}
                                </summary>
                                <p className="mt-1 max-w-md whitespace-pre-wrap rounded-md bg-success/5 p-2 text-foreground">
                                  {item.text}
                                </p>
                              </details>
                            )}
                            {item.reason && (
                              <p className="mt-1 text-xs text-destructive">
                                {item.reason} — ask your admin.
                              </p>
                            )}
                          </TableCell>
                          <TableCell className="text-sm">
                            {item.number ? `+${item.number}` : item.phone}
                            {!item.number && !item.reason && (
                              <p className="flex items-center gap-1 text-xs text-destructive">
                                <AlertTriangle className="h-3 w-3" /> No country code
                              </p>
                            )}
                            {item.number && item.likelyMobile === false && (
                              <Badge
                                variant="outline"
                                className="ml-1 border-warning/40 text-[10px] text-warning-foreground"
                              >
                                landline?
                              </Badge>
                            )}
                          </TableCell>
                          <TableCell className="hidden md:table-cell">
                            <OpportunityBadge lead={item} />
                          </TableCell>
                          <TableCell className="text-right">
                            {outcome === "sent" ? (
                              <span className="inline-flex items-center gap-1 text-sm text-success">
                                <CheckCircle2 className="h-4 w-4" /> Sent
                              </span>
                            ) : outcome === "not_on_whatsapp" ? (
                              <span className="inline-flex items-center gap-1 text-sm text-destructive">
                                <XCircle className="h-4 w-4" /> Not on WhatsApp
                              </span>
                            ) : outcome === "not_sent" ? (
                              <span className="text-sm text-muted-foreground">Not sent</span>
                            ) : isSkipped ? (
                              <span className="text-sm text-muted-foreground">Skipped</span>
                            ) : (
                              <div className="flex justify-end gap-1">
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  onClick={() => setSkipped((s) => new Set(s).add(item.leadId))}
                                  aria-label="Skip"
                                >
                                  <SkipForward className="h-4 w-4" />
                                </Button>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  disabled={!item.url || !!awaiting}
                                  onClick={() => send(item)}
                                >
                                  <MessageCircle className="h-4 w-4 text-success" /> Open chat
                                </Button>
                              </div>
                            )}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>
        </>
      )}
      <Dialog
        open={!!awaiting}
        onOpenChange={(open) => {
          if (!open && !recording) void record("not_sent");
        }}
      >
        <DialogContent className="sm:max-w-md">
          {awaiting && (
            <>
              <p className="-mb-2 text-sm font-medium">{awaiting.businessName}</p>
              <WhatsAppResultStep busy={recording} onPick={(r) => void record(r)} />
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
