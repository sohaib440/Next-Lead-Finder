import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Check, Loader2, MessageCircle, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { EmailEditor } from "@/components/EmailEditor";
import { queryKeys, useTemplates } from "@/hooks/queries";
import { ApiError, api } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { EmailTemplate, SearchRecord } from "@/types";

/** Admin: name WhatsApp templates, edit them, and assign one to this campaign. */
export function SearchWhatsAppDialog({
  search,
  onClose,
}: {
  search: SearchRecord | null;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const { data: templates = [] } = useTemplates();
  const waTemplates = templates.filter((t) => t.channel === "whatsapp");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [body, setBody] = useState("");
  const [preview, setPreview] = useState<{ text: string; lead: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [assigning, setAssigning] = useState(false);

  useEffect(() => {
    if (!search) return;
    const current = search.whatsappTemplateId ?? null;
    setSelectedId(current);
    setCreating(!current);
    setName("");
    setBody("");
    setPreview(null);
  }, [search]);

  const selected = waTemplates.find((t) => t.id === selectedId) ?? null;

  // Fill the editor when the chosen template loads or is saved. Typing does not change these fields.
  useEffect(() => {
    if (creating || !selected) return;
    setName(selected.name);
    setBody(selected.body);
  }, [creating, selected]);

  function show(template: EmailTemplate | null) {
    setCreating(false);
    setSelectedId(template?.id ?? null);
    setName(template?.name ?? "");
    setBody(template?.body ?? "");
  }

  function startNew() {
    setCreating(true);
    setSelectedId(null);
    setName("");
    setBody("");
    setPreview(null);
  }

  useEffect(() => {
    if (!search || !body.trim()) {
      setPreview(null);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void api.listLeads({ searchId: search.id, limit: 1, page: 1 }).then(async ({ items }) => {
        const lead = items[0];
        if (!lead || cancelled) {
          if (!cancelled) setPreview(null);
          return;
        }
        const r = await api.renderWhatsApp(lead.id, body, true);
        if (!cancelled) setPreview({ text: r.text, lead: lead.businessName });
      });
    }, 300);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [search, body]);

  async function persist(): Promise<EmailTemplate | null> {
    const trimmed = name.trim();
    if (!trimmed) {
      toast.error("Give this template a name.");
      return null;
    }
    if (!body.trim()) {
      toast.error("Write the WhatsApp message.");
      return null;
    }
    if (creating || !selected) {
      const created = await api.createTemplate({
        name: trimmed,
        channel: "whatsapp",
        subject: "",
        body: body.trim(),
      });
      setCreating(false);
      setSelectedId(created.id);
      setName(created.name);
      setBody(created.body);
      return created;
    }
    if (selected.name !== trimmed || selected.body !== body) {
      const updated = await api.updateTemplate(selected.id, {
        name: trimmed,
        subject: "",
        body: body.trim(),
      });
      setName(updated.name);
      setBody(updated.body);
      return updated;
    }
    return selected;
  }

  async function saveTemplate() {
    setSaving(true);
    try {
      const saved = await persist();
      if (!saved) return;
      toast.success(`Saved “${saved.name}”.`);
      void qc.invalidateQueries({ queryKey: queryKeys.templates });
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not save the template.");
    } finally {
      setSaving(false);
    }
  }

  async function assign() {
    if (!search) return;
    setAssigning(true);
    try {
      const saved = await persist();
      if (!saved) return;
      const result = await api.setSearchWhatsapp(search.id, saved.id);
      const count = result.leadsAssigned ?? 0;
      toast.success(
        `“${saved.name}” is assigned to “${search.name}” and ${count} lead${count === 1 ? "" : "s"}.`,
      );
      void qc.invalidateQueries({ queryKey: queryKeys.templates });
      void qc.invalidateQueries({ queryKey: queryKeys.searches });
      void qc.invalidateQueries({ queryKey: ["leads"] });
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not assign the template.");
    } finally {
      setAssigning(false);
    }
  }

  const busy = saving || assigning;

  return (
    <Dialog open={!!search} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[92vh] w-[calc(100vw-2rem)] max-w-none overflow-y-auto sm:max-w-[calc(100vw-4rem)]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 font-display">
            <MessageCircle className="h-5 w-5 text-success" /> WhatsApp templates
          </DialogTitle>
          <DialogDescription>
            Create as many named messages as you need, then assign one to “{search?.name}”. Editing
            a template updates it everywhere that name is used.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="campaign-template-name">Template name</Label>
              <Input
                id="campaign-template-name"
                className="w-full"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Dentists — no website"
              />
            </div>
            <EmailEditor
              subject=""
              body={body}
              hideSubject
              showSignatureField={false}
              rows={7}
              idPrefix="campaign-wa"
              onChange={(patch) => {
                if (patch.body != null) setBody(patch.body);
              }}
            />
            <div className="rounded-lg bg-success/5 p-3 text-sm">
              <p className="mb-1 text-xs text-muted-foreground">
                {preview ? `How it reads for ${preview.lead}` : "Message"}
              </p>
              <p className="whitespace-pre-wrap">{preview?.text || body || "The message will show here."}</p>
            </div>
          </div>

          <div className="space-y-2 border-t border-border pt-4">
            <div className="flex items-center justify-between gap-2">
              <p className="text-sm font-medium">Created templates</p>
              <Button type="button" size="sm" variant="ghost" className="h-7 px-2" onClick={startNew}>
                <Plus className="h-3.5 w-3.5" /> New
              </Button>
            </div>
            {waTemplates.length === 0 ? (
              <p className="rounded-lg border border-dashed border-border p-3 text-xs text-muted-foreground">
                Saved templates show up here. Give this one a name and click Save template.
              </p>
            ) : (
              <ul className="max-h-64 divide-y divide-border overflow-auto rounded-lg border border-border">
                {waTemplates.map((t) => {
                  const active = !creating && t.id === selectedId;
                  const assigned = t.id === search?.whatsappTemplateId;
                  return (
                    <li key={t.id}>
                      <button
                        type="button"
                        onClick={() => show(t)}
                        className={cn(
                          "w-full px-3 py-2.5 text-left transition-colors",
                          active ? "bg-primary/5" : "hover:bg-muted/60",
                        )}
                      >
                        <p className="flex items-center gap-1.5 text-sm font-medium">
                          {assigned && <Check className="h-3.5 w-3.5 shrink-0 text-success" />}
                          {t.name}
                          {assigned && <span className="text-xs font-normal text-success">· this campaign</span>}
                        </p>
                        <p className="line-clamp-2 whitespace-pre-line text-xs text-muted-foreground">{t.body}</p>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>

        <DialogFooter className="gap-2 sm:justify-between">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="outline" onClick={() => void saveTemplate()} disabled={busy || !name.trim() || !body.trim()}>
              {saving && <Loader2 className="h-4 w-4 animate-spin" />} Save template
            </Button>
            <Button onClick={() => void assign()} disabled={busy || !name.trim() || !body.trim()}>
              {assigning && <Loader2 className="h-4 w-4 animate-spin" />} Assign to this campaign
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
