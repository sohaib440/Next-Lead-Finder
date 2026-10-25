import { useMemo, useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import { Eye, History, Loader2, MoreHorizontal, RotateCcw, Search, Send, Share2, Shuffle, Trash2, Users, MessageCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState } from "@/components/EmptyState";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { createCampaignDraft } from "@/components/CampaignStatusBadge";
import { SearchStatusBadge } from "@/components/StatusBadge";
import { useAuth, useInvalidateData, useSearches, useTemplates } from "@/hooks/queries";
import { ShareSearchDialog } from "@/components/ShareSearchDialog";
import { SearchWhatsAppDialog } from "@/components/SearchWhatsAppDialog";
import { DistributeDialog, type DistributeTarget } from "@/components/DistributeDialog";
import { api } from "@/lib/api";
import { formatDateTime, formatDuration, formatNumber } from "@/utils/format";
import type { SearchRecord, SearchStatus } from "@/types";

export const Route = createFileRoute("/search-history")({
  head: () => ({
    meta: [
      { title: "Search History — LeadFinder Pro" },
      { name: "description", content: "Every lead search you have run, with live progress for running ones." },
    ],
  }),
  component: SearchHistoryPage,
});

type StatusFilter = "all" | "active" | Exclude<SearchStatus, "running" | "paused">;

const FILTERS: { value: StatusFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "active", label: "Running" },
  { value: "completed", label: "Completed" },
  { value: "cancelled", label: "Cancelled" },
  { value: "failed", label: "Failed" },
];

const isActive = (s: SearchRecord) => s.status === "running" || s.status === "paused";

/** Search params for "Run again" — pre-fills the Find Leads form. */
function rerunParams(s: SearchRecord) {
  return {
    niche: s.niche,
    country: s.country,
    city: s.city ?? undefined,
    keyword: s.keyword ?? undefined,
    maxResults: s.maxResults,
    contactTypes: s.contactTypes.join(","),
    websiteFilter: s.websiteFilter && s.websiteFilter !== "any" ? s.websiteFilter : undefined,
  };
}

function SearchHistoryPage() {
  const { data: searches, isPending, isError, error } = useSearches();
  const navigate = useNavigate();

  async function emailSearch(s: SearchRecord) {
    try {
      const campaign = await createCampaignDraft({ query: { searchId: s.id }, label: s.name }, `Outreach — ${s.name}`);
      void navigate({ to: "/campaigns/$id", params: { id: campaign.id } });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not create the campaign.");
    }
  }
  const invalidateData = useInvalidateData();
  const [filter, setFilter] = useState<StatusFilter>("all");
  const [text, setText] = useState("");
  const [toDelete, setToDelete] = useState<SearchRecord | null>(null);
  const [sharing, setSharing] = useState<SearchRecord | null>(null);
  const [whatsappFor, setWhatsappFor] = useState<SearchRecord | null>(null);
  const [distributing, setDistributing] = useState<DistributeTarget | null>(null);
  const { data: templates = [] } = useTemplates();
  const templateFor = (id: string | null | undefined) => (id ? templates.find((t) => t.id === id) : undefined);
  const { isAdmin, can } = useAuth();
  const [deleteLeads, setDeleteLeads] = useState(false);

  const counts = useMemo(() => {
    const c: Record<StatusFilter, number> = { all: 0, active: 0, completed: 0, cancelled: 0, failed: 0 };
    for (const s of searches ?? []) {
      c.all += 1;
      if (isActive(s)) c.active += 1;
      else c[s.status as Exclude<StatusFilter, "all" | "active">] += 1;
    }
    return c;
  }, [searches]);

  const visible = (searches ?? []).filter((s) => {
    if (filter === "active" ? !isActive(s) : filter !== "all" && s.status !== filter) return false;
    const t = text.trim().toLowerCase();
    return !t || [s.name, s.niche, s.city, s.country, s.keyword].some((v) => v?.toLowerCase().includes(t));
  });

  const totalLeads = (searches ?? []).reduce((n, s) => n + s.leadsFound, 0);

  async function confirmDelete() {
    if (!toDelete) return;
    try {
      const { deletedLeads } = await api.deleteSearch(toDelete.id, deleteLeads);
      toast.success(deletedLeads ? `Search and ${deletedLeads} leads deleted.` : "Search deleted.");
      void invalidateData();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Delete failed.");
    } finally {
      setToDelete(null);
      setDeleteLeads(false);
    }
  }

  async function cancel(s: SearchRecord) {
    try {
      await api.cancelSearch(s.id);
      toast.info("Cancelling search…");
      void invalidateData();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not cancel the search.");
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="font-display text-xl font-bold">Search history</h2>
          <p className="text-sm text-muted-foreground">
            {formatNumber(counts.all)} searches · {formatNumber(totalLeads)} leads collected
          </p>
        </div>
        {isAdmin && (
          <Button asChild>
            <Link to="/find-leads"><Search className="h-4 w-4" /> New search</Link>
          </Button>
        )}
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <Tabs value={filter} onValueChange={(v) => setFilter(v as StatusFilter)}>
          <TabsList className="h-auto flex-wrap">
            {FILTERS.map((f) => (
              <TabsTrigger key={f.value} value={f.value}>
                {f.label}
                <span className="ml-1.5 text-xs text-muted-foreground">{counts[f.value]}</span>
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <Input value={text} onChange={(e) => setText(e.target.value)} placeholder="Filter by niche or place…" className="sm:w-64" />
      </div>

      <Card className="card-shadow rounded-xl py-0">
        <CardContent className="p-0">
          {isError ? (
            <EmptyState title="Could not load searches" description={error.message} />
          ) : isPending ? (
            <div className="flex justify-center py-16 text-muted-foreground"><Loader2 className="h-6 w-6 animate-spin" /></div>
          ) : visible.length === 0 ? (
            <EmptyState
              icon={History}
              title={counts.all ? "No searches match" : "No searches yet"}
              description={counts.all ? "Try a different filter." : "Run your first search to start collecting leads."}
              action={
                !counts.all && isAdmin && (
                  <Button asChild><Link to="/find-leads"><Search className="h-4 w-4" /> Find leads</Link></Button>
                )
              }
            />
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="pl-4">Search</TableHead>
                    <TableHead className="hidden md:table-cell">Contacts</TableHead>
                    <TableHead>Leads</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="hidden lg:table-cell">Duration</TableHead>
                    <TableHead className="hidden sm:table-cell">Started</TableHead>
                    <TableHead className="w-10" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {visible.map((s) => (
                    <TableRow key={s.id}>
                      <TableCell className="pl-4">
                        <p className="font-medium text-foreground">{s.name}</p>
                        {!!s.autoDistribute?.userIds.length && (
                          <p className="text-xs text-primary">
                            <Shuffle className="mr-1 inline h-3 w-3" />
                            New leads auto-assigned to {s.autoDistribute.userIds.length} staff
                          </p>
                        )}
                        {templateFor(s.whatsappTemplateId) && (
                          <div className="mt-0.5 text-xs text-success">
                            <p>
                              <MessageCircle className="mr-1 inline h-3 w-3" />
                              WhatsApp: {templateFor(s.whatsappTemplateId)?.name}
                            </p>
                            <p className="line-clamp-2 whitespace-pre-line pl-4 text-muted-foreground">
                              {templateFor(s.whatsappTemplateId)?.body}
                            </p>
                          </div>
                        )}
                        <p className="text-xs text-muted-foreground">
                          {[s.keyword && `“${s.keyword}”`, `max ${formatNumber(s.maxResults)}`, s.websiteFilter === "with" && "websites only",
                            s.websiteFilter === "without" && "no website only", s.source]
                            .filter(Boolean)
                            .join(" · ")}
                        </p>
                        {isActive(s) && (
                          <div className="mt-1.5 flex max-w-xs items-center gap-2">
                            <Progress value={s.progress ?? 0} className="h-1.5" />
                            <span className="text-xs text-muted-foreground">{Math.floor(s.progress ?? 0)}%</span>
                          </div>
                        )}
                        {s.status === "failed" && s.error && <p className="mt-1 max-w-md truncate text-xs text-destructive" title={s.error}>{s.error}</p>}
                      </TableCell>
                      <TableCell className="hidden text-muted-foreground md:table-cell">
                        <p className="text-xs">{s.phonesFound ?? 0} phones · {s.emailsFound ?? 0} emails</p>
                        {!!s.duplicatesSkipped && <p className="text-xs">{s.duplicatesSkipped} duplicates skipped</p>}
                      </TableCell>
                      <TableCell className="font-medium">
                        {s.leadsFound > 0 ? (
                          <Link to="/leads" search={{ searchId: s.id }} className="hover:text-primary">{formatNumber(s.leadsFound)}</Link>
                        ) : (
                          0
                        )}
                      </TableCell>
                      <TableCell><SearchStatusBadge status={s.status} /></TableCell>
                      <TableCell className="hidden text-muted-foreground lg:table-cell">{formatDuration(s.durationSeconds ?? undefined)}</TableCell>
                      <TableCell className="hidden whitespace-nowrap text-muted-foreground sm:table-cell">{formatDateTime(s.date)}</TableCell>
                      <TableCell>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon" className="h-8 w-8" aria-label="Search actions">
                              <MoreHorizontal className="h-4 w-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            {isAdmin && (
                              <DropdownMenuItem asChild>
                                <Link to="/find-leads" search={{ searchId: s.id }}><Eye className="h-4 w-4" /> {isActive(s) ? "Watch progress" : "View run"}</Link>
                              </DropdownMenuItem>
                            )}
                            {s.leadsFound > 0 && (
                              <DropdownMenuItem asChild>
                                <Link to="/leads" search={{ searchId: s.id }}><Users className="h-4 w-4" /> View leads</Link>
                              </DropdownMenuItem>
                            )}
                            {isAdmin && (
                              <DropdownMenuItem asChild>
                                <Link to="/find-leads" search={rerunParams(s)}><RotateCcw className="h-4 w-4" /> Run again</Link>
                              </DropdownMenuItem>
                            )}
                            {s.leadsFound > 0 && can("campaigns") && (
                              <DropdownMenuItem onClick={() => emailSearch(s)}>
                                <Send className="h-4 w-4" /> Email these leads
                              </DropdownMenuItem>
                            )}
                            {isAdmin && (
                              <DropdownMenuItem onClick={() => setWhatsappFor(s)}>
                                <MessageCircle className="h-4 w-4" /> WhatsApp message…
                              </DropdownMenuItem>
                            )}
                            {isAdmin && s.leadsFound > 0 && (
                              <DropdownMenuItem onClick={() => setDistributing({ searchId: s.id, label: s.name })}>
                                <Shuffle className="h-4 w-4" /> Distribute leads to staff…
                              </DropdownMenuItem>
                            )}
                            {isAdmin && s.leadsFound > 0 && (
                              <DropdownMenuItem onClick={() => setSharing(s)}>
                                <Share2 className="h-4 w-4" /> Share with staff…
                              </DropdownMenuItem>
                            )}
                            {isAdmin && <DropdownMenuSeparator />}
                            {!isAdmin ? null : isActive(s) ? (
                              <DropdownMenuItem className="text-destructive focus:text-destructive" onClick={() => cancel(s)}>
                                <Trash2 className="h-4 w-4" /> Cancel search
                              </DropdownMenuItem>
                            ) : (
                              <DropdownMenuItem className="text-destructive focus:text-destructive" onClick={() => setToDelete(s)}>
                                <Trash2 className="h-4 w-4" /> Delete
                              </DropdownMenuItem>
                            )}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {isAdmin && (
        <Card className="card-shadow rounded-xl">
          <CardHeader>
            <CardTitle className="font-display text-base font-semibold">Created WhatsApp templates</CardTitle>
            <CardDescription>
              Every saved message. A check on a campaign row shows which one that campaign uses.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {templates.filter((t) => t.channel === "whatsapp").length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No WhatsApp templates yet. Open a campaign’s menu and choose WhatsApp message… to create one.
              </p>
            ) : (
              <ul className="divide-y divide-border">
                {templates
                  .filter((t) => t.channel === "whatsapp")
                  .map((t) => {
                    const assigned = (searches ?? []).filter((s) => s.whatsappTemplateId === t.id);
                    return (
                      <li key={t.id} className="py-3 first:pt-0 last:pb-0">
                        <p className="font-medium">{t.name}</p>
                        <p className="text-xs text-muted-foreground">
                          {assigned.length
                            ? `Assigned to ${assigned.map((s) => s.name).join(", ")}`
                            : "Not assigned to a campaign yet"}
                        </p>
                        <p className="mt-1 line-clamp-3 whitespace-pre-wrap text-sm text-foreground/80">{t.body}</p>
                      </li>
                    );
                  })}
              </ul>
            )}
          </CardContent>
        </Card>
      )}

      <ShareSearchDialog search={sharing} onClose={() => setSharing(null)} />
      <SearchWhatsAppDialog search={whatsappFor} onClose={() => setWhatsappFor(null)} />
      <DistributeDialog target={distributing} onClose={() => setDistributing(null)} />
      <ConfirmDialog
        open={!!toDelete}
        onOpenChange={(open) => {
          if (!open) {
            setToDelete(null);
            setDeleteLeads(false);
          }
        }}
        title="Delete this search?"
        description={`“${toDelete?.name}” will be removed from your history.`}
        confirmLabel="Delete"
        onConfirm={confirmDelete}
      >
        {!!toDelete?.leadsFound && (
          <Label className="flex items-center gap-2 text-sm font-normal">
            <Checkbox checked={deleteLeads} onCheckedChange={(v) => setDeleteLeads(v === true)} />
            Also delete the {formatNumber(toDelete.leadsFound)} leads it collected
          </Label>
        )}
      </ConfirmDialog>
    </div>
  );
}
