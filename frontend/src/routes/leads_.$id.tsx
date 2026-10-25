import { useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import {
  ArrowLeft,
  ArrowRightLeft,
  Building2,
  Check,
  CircleDollarSign,
  Globe,
  Loader2,
  Mail,
  MapPin,
  MessageCircle,
  MessageSquare,
  MoreHorizontal,
  Pencil,
  Phone,
  Plus,
  Reply,
  Sparkles,
  Trash2,
  User,
  Users,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { STAGES, ScoreBadge, StageBadge, stageMeta } from "@/components/CrmBadges";
import {
  PinButton,
  PinnedMark,
  PriorityMenu,
  WhatsAppStatusMenu,
} from "@/components/LeadQuickActions";
import { DetailRow } from "@/components/DetailRow";
import { EmptyState } from "@/components/EmptyState";
import { LeadFormDialog } from "@/components/LeadFormDialog";
import { InsightsCard, OpportunityBadge, RatingBadge } from "@/components/LeadInsights";
import { WhatsAppDialog } from "@/components/WhatsAppDialog";
import { TagInput } from "@/components/TagInput";
import { TaskDialog, TaskRow } from "@/components/Tasks";
import { useAuth, useInvalidateData, useLead, useSettings } from "@/hooks/queries";
import { LeadOwnerCard } from "@/components/LeadOwnerCard";
import { LeadWhatsAppCard } from "@/components/LeadWhatsAppCard";
import { api } from "@/lib/api";
import { formatDate, formatDateTime, formatMoney, relativeTime } from "@/utils/format";
import type { Activity, ActivityType, Lead, LeadInput, LeadStage } from "@/types";

export const Route = createFileRoute("/leads_/$id")({
  head: () => ({
    meta: [{ title: "Lead — LeadFinder Pro" }],
  }),
  component: LeadPage,
});

type LoggableType = Exclude<ActivityType, "stage_change" | "email_reply" | "whatsapp">;

const ACTIVITY_META: Record<ActivityType, { label: string; icon: LucideIcon; className: string }> =
  {
    note: { label: "Note", icon: MessageSquare, className: "bg-muted text-muted-foreground" },
    call: { label: "Call", icon: Phone, className: "bg-success/10 text-success" },
    email: { label: "Email", icon: Mail, className: "bg-primary/10 text-primary" },
    meeting: { label: "Meeting", icon: Users, className: "bg-chart-4/10 text-chart-4" },
    whatsapp: { label: "WhatsApp", icon: MessageCircle, className: "bg-success/10 text-success" },
    whatsapp_unavailable: {
      label: "Not on WhatsApp",
      icon: MessageCircle,
      className: "bg-destructive/10 text-destructive",
    },
    email_reply: { label: "Email reply", icon: Reply, className: "bg-primary/15 text-primary" },
    stage_change: {
      label: "Stage",
      icon: ArrowRightLeft,
      className: "bg-warning/15 text-warning-foreground",
    },
  };

function LeadPage() {
  const { id } = Route.useParams();
  const navigate = useNavigate();
  const { data, isPending, isError, error } = useLead(id);
  const invalidateData = useInvalidateData();
  const [editing, setEditing] = useState(false);
  const [addingTask, setAddingTask] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [whatsapp, setWhatsapp] = useState(false);
  const { can, isAdmin } = useAuth();

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
        icon={Users}
        title="Lead not found"
        description={error.message}
        action={
          <Button asChild variant="outline">
            <Link to="/leads">
              <ArrowLeft className="h-4 w-4" /> All leads
            </Link>
          </Button>
        }
      />
    );
  }

  const { lead, activities, tasks } = data;

  async function update(patch: LeadInput, success?: string) {
    try {
      await api.updateLead(lead.id, patch);
      if (success) toast.success(success);
      await invalidateData();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not update the lead.");
    }
  }

  async function remove() {
    try {
      await api.deleteLead(lead.id);
      toast.success("Lead deleted.");
      void invalidateData();
      void navigate({ to: "/leads" });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Delete failed.");
    }
  }

  const openTasks = tasks.filter((t) => !t.done);
  const doneTasks = tasks.filter((t) => t.done);

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <Link
            to="/leads"
            className="mb-2 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-primary"
          >
            <ArrowLeft className="h-3.5 w-3.5" /> All leads
          </Link>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="font-display text-xl font-bold">
              <PinnedMark pinned={lead.pinned} /> {lead.businessName}
            </h2>
            <StageBadge stage={lead.stage} />
            <PriorityMenu
              priority={lead.priority}
              onChange={(priority) => update({ priority }, `Priority set to ${priority}.`)}
            />
            {lead.phone && (
              <WhatsAppStatusMenu
                lead={lead}
                onChange={(whatsappStatus) => update({ whatsappStatus }, "WhatsApp status saved.")}
              />
            )}
            <OpportunityBadge lead={lead} />
            <RatingBadge rating={lead.rating} reviews={lead.reviewCount} />
          </div>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {[lead.category, [lead.city, lead.country].filter(Boolean).join(", ")]
              .filter(Boolean)
              .join(" · ")}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          {lead.phone && (
            <Button asChild variant="outline">
              <a href={`tel:${lead.phone}`}>
                <Phone className="h-4 w-4" /> Call
              </a>
            </Button>
          )}
          {lead.phone && (
            <Button variant="outline" onClick={() => setWhatsapp(true)}>
              <MessageCircle className="h-4 w-4 text-success" /> WhatsApp
            </Button>
          )}
          {lead.email && (
            <Button asChild variant="outline">
              <a href={`mailto:${lead.email}`}>
                <Mail className="h-4 w-4" /> Email
              </a>
            </Button>
          )}
          <PinButton
            pinned={!!lead.pinned}
            onToggle={() =>
              update(
                { pinned: !lead.pinned },
                lead.pinned ? "Unpinned." : "Pinned — it now stays at the top of your lists.",
              )
            }
          />
          <Button variant="outline" onClick={() => setEditing(true)}>
            <Pencil className="h-4 w-4" /> Edit
          </Button>
          {isAdmin && (
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setConfirmDelete(true)}
              aria-label="Delete lead"
            >
              <Trash2 className="h-4 w-4 text-destructive" />
            </Button>
          )}
        </div>
      </div>

      <StagePath
        stage={lead.stage}
        onChange={(stage) => update({ stage }, `Moved to ${stageMeta(stage).label}.`)}
      />

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1fr)_22rem]">
        {/* Timeline */}
        <div className="space-y-5">
          <ActivityComposer leadId={lead.id} />
          <Card className="card-shadow rounded-xl">
            <CardHeader>
              <CardTitle className="font-display text-base font-semibold">Activity</CardTitle>
            </CardHeader>
            <CardContent>
              <Timeline lead={lead} activities={activities} />
            </CardContent>
          </Card>
        </div>

        {/* Sidebar */}
        <div className="space-y-5">
          <Card className="card-shadow rounded-xl">
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle className="font-display text-base font-semibold">Follow-ups</CardTitle>
              <Button size="sm" variant="outline" onClick={() => setAddingTask(true)}>
                <Plus className="h-4 w-4" /> Task
              </Button>
            </CardHeader>
            <CardContent>
              {openTasks.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No open follow-ups. Schedule the next step so this lead doesn't go cold.
                </p>
              ) : (
                <ul className="-my-3 divide-y divide-border">
                  {openTasks.map((t) => (
                    <TaskRow key={t.id} task={t} showLead={false} />
                  ))}
                </ul>
              )}
              {doneTasks.length > 0 && (
                <details className="mt-3 text-sm">
                  <summary className="cursor-pointer text-xs text-muted-foreground">
                    {doneTasks.length} completed
                  </summary>
                  <ul className="divide-y divide-border">
                    {doneTasks.map((t) => (
                      <TaskRow key={t.id} task={t} showLead={false} />
                    ))}
                  </ul>
                </details>
              )}
            </CardContent>
          </Card>

          <LeadOwnerCard lead={lead} activities={activities} tasks={tasks} />

          {isAdmin && <LeadWhatsAppCard lead={lead} />}

          <DealCard lead={lead} onUpdate={update} />

          <InsightsCard lead={lead} />

          <Card className="card-shadow rounded-xl">
            <CardHeader>
              <CardTitle className="font-display text-base font-semibold">Contact</CardTitle>
            </CardHeader>
            <CardContent className="divide-y divide-border">
              <DetailRow
                icon={User}
                label={lead.contactRole ? `Contact · ${lead.contactRole}` : "Contact person"}
                value={lead.contactName}
              />
              <DetailRow
                icon={Phone}
                label="Phone"
                value={lead.phone}
                href={lead.phone ? `tel:${lead.phone}` : undefined}
              />
              <DetailRow
                icon={Mail}
                label="Email"
                value={lead.email}
                href={lead.email ? `mailto:${lead.email}` : undefined}
              />
              <DetailRow
                icon={Globe}
                label="Website"
                value={lead.website}
                href={lead.website ?? undefined}
              />
              <DetailRow
                icon={MapPin}
                label="Address"
                value={lead.address ?? [lead.city, lead.country].filter(Boolean).join(", ")}
              />
              <DetailRow
                icon={Building2}
                label="Google Business Profile"
                value={lead.sourceUrl}
                href={lead.sourceUrl ?? undefined}
              />
            </CardContent>
          </Card>

          <div className="space-y-1 px-1 text-xs text-muted-foreground">
            <p>
              Source: {lead.source || "Unknown"}
              {lead.searchId && (
                <>
                  {" "}
                  ·{" "}
                  <Link
                    to="/leads"
                    search={{ searchId: lead.searchId }}
                    className="hover:text-primary"
                  >
                    same search
                  </Link>
                </>
              )}
            </p>
            <p>Added {formatDate(lead.dateAdded)}</p>
          </div>
        </div>
      </div>

      <LeadFormDialog open={editing} onOpenChange={setEditing} lead={lead} />
      {lead.phone && <WhatsAppDialog lead={lead} open={whatsapp} onOpenChange={setWhatsapp} />}
      <TaskDialog
        open={addingTask}
        onOpenChange={setAddingTask}
        leadId={lead.id}
        leadName={lead.businessName}
        defaultAssigneeId={
          typeof lead.assignedTo === "object" ? lead.assignedTo?.id : lead.assignedTo
        }
      />
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title="Delete this lead?"
        description="The lead, its activity history and its tasks are removed. A future search may collect the business again."
        confirmLabel="Delete"
        onConfirm={remove}
      />
    </div>
  );
}

/** Clickable stage path, Salesforce-style. Won and Lost are both end states. */
function StagePath({
  stage,
  onChange,
}: {
  stage: LeadStage;
  onChange: (stage: LeadStage) => void;
}) {
  const index = STAGES.findIndex((s) => s.value === stage);
  return (
    <div className="grid grid-cols-3 gap-1 sm:grid-cols-6">
      {STAGES.map((s, i) => {
        const current = s.value === stage;
        const passed = stage !== "lost" && i < index;
        return (
          <button
            key={s.value}
            onClick={() => !current && onChange(s.value)}
            className={`flex items-center justify-center gap-1.5 rounded-md border px-2 py-2 text-xs font-semibold transition-colors ${
              current
                ? `${s.className} ring-1 ring-current`
                : passed
                  ? "border-primary/20 bg-primary/5 text-primary hover:bg-primary/10"
                  : "border-border bg-card text-muted-foreground hover:bg-muted"
            }`}
            aria-current={current ? "step" : undefined}
          >
            {passed && <Check className="h-3.5 w-3.5" />}
            {s.label}
          </button>
        );
      })}
    </div>
  );
}

function DealCard({
  lead,
  onUpdate,
}: {
  lead: Lead;
  onUpdate: (patch: LeadInput, success?: string) => Promise<void>;
}) {
  const { settings } = useSettings();
  return (
    <Card className="card-shadow rounded-xl">
      <CardHeader>
        <CardTitle className="font-display text-base font-semibold">Deal</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-3 text-sm">
          <div>
            <p className="text-xs text-muted-foreground">Value</p>
            <p className="flex items-center gap-1 font-display text-lg font-bold">
              <CircleDollarSign className="h-4 w-4 text-muted-foreground" />
              {lead.dealValue != null ? formatMoney(lead.dealValue, settings.currency) : "—"}
            </p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Lead score</p>
            <p className="mt-1 flex items-center gap-1.5">
              <ScoreBadge score={lead.score} />{" "}
              <Sparkles className="h-3.5 w-3.5 text-muted-foreground" />
            </p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Last contacted</p>
            <p className="font-medium">
              {lead.lastContactedAt ? relativeTime(lead.lastContactedAt) : "Never"}
            </p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">In stage since</p>
            <p className="font-medium">{relativeTime(lead.stageChangedAt ?? lead.dateAdded)}</p>
          </div>
        </div>
        <div className="space-y-1.5">
          <p className="text-xs text-muted-foreground">Tags</p>
          <TagInput value={lead.tags} onChange={(tags) => void onUpdate({ tags })} />
        </div>
      </CardContent>
    </Card>
  );
}

const COMPOSER_TYPES: { value: LoggableType; label: string; placeholder: string }[] = [
  { value: "note", label: "Note", placeholder: "Write a note about this business…" },
  { value: "call", label: "Log call", placeholder: "What was discussed on the call? (optional)" },
  { value: "email", label: "Log email", placeholder: "What did you send or receive? (optional)" },
  { value: "meeting", label: "Log meeting", placeholder: "Meeting notes (optional)" },
];

function ActivityComposer({ leadId }: { leadId: string }) {
  const invalidateData = useInvalidateData();
  const [type, setType] = useState<LoggableType>("note");
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);
  const meta = COMPOSER_TYPES.find((t) => t.value === type)!;

  async function submit() {
    setSaving(true);
    try {
      await api.addActivity(leadId, { type, text });
      setText("");
      toast.success(type === "note" ? "Note added." : `${ACTIVITY_META[type].label} logged.`);
      await invalidateData();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className="card-shadow rounded-xl py-0">
      <CardContent className="space-y-3 p-4">
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          value={type}
          onValueChange={(v: string) => v && setType(v as LoggableType)}
          className="grid w-full grid-cols-2 sm:flex sm:w-auto sm:justify-start"
        >
          {COMPOSER_TYPES.map((t) => {
            const Icon = ACTIVITY_META[t.value].icon;
            return (
              <ToggleGroupItem key={t.value} value={t.value} className="gap-1.5 px-3 sm:flex-none">
                <Icon className="h-3.5 w-3.5" /> {t.label}
              </ToggleGroupItem>
            );
          })}
        </ToggleGroup>
        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={meta.placeholder}
          rows={3}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) void submit();
          }}
        />
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs text-muted-foreground">
            {type === "note"
              ? "Ctrl + Enter to save."
              : "Logging contact updates “last contacted” and moves new leads to Contacted."}
          </p>
          <Button size="sm" onClick={submit} disabled={saving || (type === "note" && !text.trim())}>
            {saving && <Loader2 className="h-4 w-4 animate-spin" />}
            {type === "note" ? "Add note" : "Log"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function Timeline({ lead, activities }: { lead: Lead; activities: Activity[] }) {
  const invalidateData = useInvalidateData();

  async function remove(id: string) {
    try {
      await api.deleteActivity(id);
      await invalidateData();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Delete failed.");
    }
  }

  return (
    <ol className="relative space-y-5 before:absolute before:inset-y-1 before:left-4 before:w-px before:bg-border">
      {activities.map((a) => {
        const meta = ACTIVITY_META[a.type];
        return (
          <li key={a.id} className="group relative flex gap-3">
            <span
              className={`z-10 flex h-8 w-8 shrink-0 items-center justify-center rounded-full ring-4 ring-card ${meta.className}`}
            >
              <meta.icon className="h-4 w-4" />
            </span>
            <div className="min-w-0 flex-1 pt-1">
              <div className="flex items-center gap-2">
                <p className="text-sm font-medium">
                  {a.type === "stage_change" && a.meta ? (
                    <>
                      Moved from <StageBadge stage={a.meta.from} className="mx-0.5" /> to{" "}
                      <StageBadge stage={a.meta.to} className="mx-0.5" />
                    </>
                  ) : (
                    meta.label
                  )}
                </p>
                <span className="text-xs text-muted-foreground" title={formatDateTime(a.date)}>
                  {relativeTime(a.date)}
                </span>
                {a.by && <span className="truncate text-xs text-muted-foreground">· {a.by}</span>}
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="ml-auto h-6 w-6 opacity-0 group-hover:opacity-100 data-[state=open]:opacity-100"
                      aria-label="Activity actions"
                    >
                      <MoreHorizontal className="h-3.5 w-3.5" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem
                      className="text-destructive focus:text-destructive"
                      onClick={() => remove(a.id)}
                    >
                      <Trash2 className="h-4 w-4" /> Delete
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
              {a.text && (
                <p className="mt-1 whitespace-pre-wrap break-words text-sm text-muted-foreground">
                  {a.text}
                </p>
              )}
            </div>
          </li>
        );
      })}
      <li className="relative flex gap-3">
        <span className="z-10 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground ring-4 ring-card">
          <Plus className="h-4 w-4" />
        </span>
        <div className="pt-1">
          <p className="text-sm font-medium">Lead added</p>
          <p className="text-xs text-muted-foreground">
            {lead.source === "Manual" ? "Added by hand" : `Found via ${lead.source || "a search"}`}{" "}
            · {formatDateTime(lead.dateAdded)}
          </p>
        </div>
      </li>
    </ol>
  );
}
