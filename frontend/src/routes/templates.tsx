import { useEffect, useState, type ReactNode } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { FileText, Loader2, MoreHorizontal, Pencil, Plus, Sparkles, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import {
  EmailEditor,
  MERGE_FIELDS,
  STARTER_TEMPLATES,
  WHATSAPP_STARTER_TEMPLATES,
} from "@/components/EmailEditor";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { EmptyState } from "@/components/EmptyState";
import { queryKeys, useAuth, useSearches, useTemplates } from "@/hooks/queries";
import { ApiError, api } from "@/lib/api";
import { relativeTime } from "@/utils/format";
import type { EmailTemplate, SearchRecord } from "@/types";

const FIELD_LABEL = Object.fromEntries(MERGE_FIELDS.map((f) => [f.key, f.label]));
const mergePattern = () => /\{\{\s*(\w+)\s*(?:\|\s*([^}]*?)\s*)?\}\}/g;

/** Renders {{businessName}} as a small label instead of raw braces. */
function MessagePreview({ body }: { body: string }) {
  const parts: ReactNode[] = [];
  let last = 0;
  let key = 0;
  for (const match of body.matchAll(mergePattern())) {
    const index = match.index ?? 0;
    if (index > last) parts.push(body.slice(last, index));
    parts.push(
      <span
        key={key++}
        className="mx-0.5 inline-flex items-center rounded-md bg-background/80 px-1.5 py-0.5 text-[11px] font-medium text-primary"
      >
        {FIELD_LABEL[match[1]] ?? match[1]}
      </span>,
    );
    last = index + match[0].length;
  }
  if (last < body.length) parts.push(body.slice(last));
  return <p className="whitespace-pre-wrap text-sm leading-relaxed">{parts}</p>;
}

export const Route = createFileRoute("/templates")({
  head: () => ({
    meta: [
      { title: "Templates — LeadFinder Pro" },
      {
        name: "description",
        content: "Reusable email and WhatsApp messages with personal merge fields.",
      },
    ],
  }),
  component: TemplatesPage,
});

type Channel = "email" | "whatsapp";
type Draft = Pick<EmailTemplate, "name" | "subject" | "body"> & { channel: Channel };

function TemplatesPage() {
  const qc = useQueryClient();
  const { data: templates, isPending } = useTemplates();
  const { data: searches = [] } = useSearches();
  const [editing, setEditing] = useState<{ template: EmailTemplate | null; draft: Draft } | null>(
    null,
  );
  const [toDelete, setToDelete] = useState<EmailTemplate | null>(null);
  const [channel, setChannel] = useState<Channel>("email");
  const { isAdmin } = useAuth();
  // Only admins write WhatsApp messages; staff can read them.
  const readOnly = channel === "whatsapp" && !isAdmin;
  const visible = (templates ?? []).filter((t) => (t.channel ?? "email") === channel);
  const starters =
    channel === "email"
      ? STARTER_TEMPLATES
      : WHATSAPP_STARTER_TEMPLATES.map((t) => ({ ...t, subject: "" }));
  const asDraft = (t: EmailTemplate): Draft => ({ ...t, channel: t.channel ?? "email" });

  const startNew = (draft: Omit<Draft, "channel"> = { name: "", subject: "", body: "" }) =>
    setEditing({ template: null, draft: { ...draft, channel } });

  async function remove() {
    if (!toDelete) return;
    try {
      await api.deleteTemplate(toDelete.id);
      toast.success("Template deleted.");
      void qc.invalidateQueries({ queryKey: queryKeys.templates });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Delete failed.");
    } finally {
      setToDelete(null);
    }
  }

  return (
    <div className="w-full space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="font-display text-xl font-bold">Templates</h2>
          <p className="text-sm text-muted-foreground">
            Write a message once and reuse it in email campaigns and WhatsApp outreach. Merge fields
            personalise it for every business.
          </p>
        </div>
        <Button
          onClick={() => startNew()}
          disabled={readOnly}
          title={readOnly ? "Only an admin can create WhatsApp messages" : undefined}
        >
          <Plus className="h-4 w-4" /> New template
        </Button>
      </div>

      <Tabs value={channel} onValueChange={(v) => setChannel(v as Channel)}>
        <TabsList>
          <TabsTrigger value="email">Email</TabsTrigger>
          <TabsTrigger value="whatsapp">WhatsApp</TabsTrigger>
        </TabsList>
      </Tabs>

      {isPending ? (
        <div className="flex justify-center py-12 text-muted-foreground">
          <Loader2 className="h-6 w-6 animate-spin" />
        </div>
      ) : !visible.length ? (
        <EmptyState
          icon={FileText}
          title="No templates yet"
          description="Start from a ready-made template below, or write your own."
        />
      ) : channel === "whatsapp" ? (
        <Card className="card-shadow overflow-hidden rounded-xl py-0">
          <ul className="divide-y divide-border">
            {visible.map((t) => (
              <WhatsAppTemplateRow
                key={t.id}
                template={t}
                searches={searches}
                readOnly={readOnly}
                onEdit={() => setEditing({ template: t, draft: asDraft(t) })}
                onDuplicate={() => startNew({ ...t, name: `${t.name} (copy)` })}
                onDelete={() => setToDelete(t)}
              />
            ))}
          </ul>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {visible.map((t) => (
            <Card
              key={t.id}
              className="card-shadow cursor-pointer rounded-xl transition-colors hover:border-primary/40"
              onClick={() => !readOnly && setEditing({ template: t, draft: asDraft(t) })}
            >
              <CardHeader className="flex flex-row items-start justify-between gap-3">
                <div className="min-w-0">
                  <CardTitle className="truncate font-display text-base font-semibold">
                    {t.name}
                  </CardTitle>
                  <CardDescription className="truncate">{t.subject}</CardDescription>
                </div>
                <div
                  onClick={(e) => e.stopPropagation()}
                  className={readOnly ? "hidden" : undefined}
                >
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        aria-label="Template actions"
                      >
                        <MoreHorizontal className="h-4 w-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem
                        onClick={() => setEditing({ template: t, draft: asDraft(t) })}
                      >
                        <Pencil className="h-4 w-4" /> Edit
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onClick={() => startNew({ ...t, name: `${t.name} (copy)` })}
                      >
                        <Plus className="h-4 w-4" /> Duplicate
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        className="text-destructive focus:text-destructive"
                        onClick={() => setToDelete(t)}
                      >
                        <Trash2 className="h-4 w-4" /> Delete
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </CardHeader>
              <CardContent>
                <p className="line-clamp-6 whitespace-pre-wrap text-sm text-foreground/80">
                  {t.body}
                </p>
                <p className="mt-3 text-xs text-muted-foreground">
                  Edited {relativeTime(t.updatedAt)}
                </p>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {!readOnly && (
        <Card className="card-shadow rounded-xl">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 font-display text-base font-semibold">
              <Sparkles className="h-4 w-4 text-primary" /> Ready-made templates
            </CardTitle>
            <CardDescription>Click one to customise it and save it as your own.</CardDescription>
          </CardHeader>
          <CardContent className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {starters.map((t) => (
              <button
                key={t.name}
                onClick={() => startNew(t)}
                className="h-full rounded-lg border border-border p-4 text-left transition-colors hover:border-primary hover:bg-primary/5"
              >
                <p className="text-sm font-medium">{t.name}</p>
                <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                  {t.subject || t.body.replace(mergePattern(), (_, key: string) => FIELD_LABEL[key] ?? key)}
                </p>
              </button>
            ))}
          </CardContent>
        </Card>
      )}

      <TemplateDialog editing={editing} onClose={() => setEditing(null)} />
      <ConfirmDialog
        open={!!toDelete}
        onOpenChange={(open) => !open && setToDelete(null)}
        title="Delete this template?"
        description={
          toDelete?.channel === "whatsapp"
            ? "Campaigns and leads using this message will no longer have it. Other templates are kept."
            : "Campaigns that already used it keep their own copy of the email."
        }
        confirmLabel="Delete"
        onConfirm={remove}
      />
    </div>
  );
}

function WhatsAppTemplateRow({
  template,
  searches,
  readOnly,
  onEdit,
  onDuplicate,
  onDelete,
}: {
  template: EmailTemplate;
  searches: SearchRecord[];
  readOnly: boolean;
  onEdit: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
}) {
  const qc = useQueryClient();
  const assigned = searches.filter((s) => s.whatsappTemplateId === template.id);
  const [searchId, setSearchId] = useState("");
  const [saving, setSaving] = useState(false);
  const already = assigned.some((s) => s.id === searchId);

  async function assign() {
    if (!searchId || already) return;
    const campaign = searches.find((s) => s.id === searchId);
    setSaving(true);
    try {
      const result = await api.setSearchWhatsapp(searchId, template.id);
      const count = result.leadsAssigned ?? 0;
      toast.success(
        `“${template.name}” is assigned to “${campaign?.name ?? "this campaign"}” and ${count} lead${count === 1 ? "" : "s"}.`,
      );
      void qc.invalidateQueries({ queryKey: queryKeys.searches });
      void qc.invalidateQueries({ queryKey: ["leads"] });
      setSearchId("");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not assign the template.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <li className="grid gap-0 lg:grid-cols-[minmax(0,1fr)_22rem]">
      <div className="min-w-0 space-y-3 p-5 lg:p-6">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="font-display text-base font-semibold">{template.name}</h3>
          <span className="text-xs text-muted-foreground">Edited {relativeTime(template.updatedAt)}</span>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {assigned.length === 0 ? (
            <span className="text-xs text-muted-foreground">Not assigned to a campaign</span>
          ) : (
            assigned.map((s) => (
              <Badge key={s.id} variant="secondary" className="font-normal">
                {s.name}
              </Badge>
            ))
          )}
        </div>
        <div className="rounded-2xl rounded-tl-md bg-success/10 px-4 py-3.5 text-foreground">
          <MessagePreview body={template.body} />
        </div>
      </div>

      {!readOnly && (
        <div className="flex flex-col gap-4 border-t border-border bg-muted/30 p-5 lg:border-l lg:border-t-0 lg:p-6">
          <div className="space-y-2">
            <Label>Assign to campaign</Label>
            {searches.length === 0 ? (
              <p className="text-xs text-muted-foreground">Create a campaign in Search History first.</p>
            ) : (
              <>
                <Select value={searchId || undefined} onValueChange={setSearchId}>
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Choose a campaign" />
                  </SelectTrigger>
                  <SelectContent>
                    {searches.map((s) => (
                      <SelectItem key={s.id} value={s.id}>
                        {s.name}
                        {s.whatsappTemplateId === template.id ? " · assigned" : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button className="w-full" onClick={() => void assign()} disabled={!searchId || already || saving}>
                  {saving && <Loader2 className="h-4 w-4 animate-spin" />}
                  {already ? "Already assigned" : "Assign"}
                </Button>
              </>
            )}
          </div>
          <div className="mt-auto flex gap-1">
            <Button variant="outline" size="sm" onClick={onEdit}>
              <Pencil className="h-3.5 w-3.5" /> Edit
            </Button>
            <Button variant="outline" size="sm" onClick={onDuplicate}>
              <Plus className="h-3.5 w-3.5" /> Copy
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="text-destructive hover:text-destructive"
              onClick={onDelete}
            >
              <Trash2 className="h-3.5 w-3.5" /> Delete
            </Button>
          </div>
        </div>
      )}
    </li>
  );
}

function TemplateDialog({
  editing,
  onClose,
}: {
  editing: { template: EmailTemplate | null; draft: Draft } | null;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [draft, setDraft] = useState<Draft>({ name: "", subject: "", body: "", channel: "email" });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (editing) {
      setDraft(editing.draft);
      setErrors({});
    }
  }, [editing]);

  async function save() {
    setSaving(true);
    try {
      if (editing?.template) await api.updateTemplate(editing.template.id, draft);
      else await api.createTemplate(draft);
      toast.success("Template saved.");
      void qc.invalidateQueries({ queryKey: queryKeys.templates });
      onClose();
    } catch (err) {
      if (err instanceof ApiError && err.errors) setErrors(err.errors);
      toast.error(err instanceof Error ? err.message : "Could not save the template.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={!!editing} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[92vh] w-[calc(100vw-2rem)] max-w-none overflow-y-auto sm:max-w-[calc(100vw-4rem)]">
        <DialogHeader>
          <DialogTitle className="font-display">
            {editing?.template ? "Edit template" : "New template"}
          </DialogTitle>
          <DialogDescription>
            {draft.channel === "whatsapp"
              ? "A WhatsApp message opens prefilled for each lead — keep it short and friendly."
              : "Your sender signature is added automatically at the end."}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="template-name">Template name</Label>
            <Input
              id="template-name"
              className="w-full"
              value={draft.name}
              onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
              placeholder="e.g. Web design intro"
              aria-invalid={!!errors["name"]}
            />
            {errors["name"] && <p className="text-xs text-destructive">{errors["name"]}</p>}
          </div>
          <EmailEditor
            subject={draft.subject}
            body={draft.body}
            errors={errors}
            hideSubject={draft.channel === "whatsapp"}
            showSignatureField={draft.channel !== "whatsapp"}
            rows={draft.channel === "whatsapp" ? 8 : 14}
            onChange={(patch) => setDraft((d) => ({ ...d, ...patch }))}
          />
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} disabled={saving}>
            {saving && <Loader2 className="h-4 w-4 animate-spin" />} Save template
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
