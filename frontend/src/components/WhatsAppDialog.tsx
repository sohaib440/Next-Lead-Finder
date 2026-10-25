import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  Lock,
  MessageCircle,
  Undo2,
  XCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { MERGE_FIELDS } from "@/components/EmailEditor";
import { useInvalidateData, useTemplates } from "@/hooks/queries";
import { ApiError, api } from "@/lib/api";
import { relativeTime } from "@/utils/format";
import type { Lead, WhatsAppMessage, WhatsAppResult } from "@/types";

export const DEFAULT_WHATSAPP_MESSAGE = `Hello {{firstName|there}}! I'm {{senderName}}. I came across {{businessName}} on Google Maps — great reviews!

We help businesses in {{city}} get more customers online with a professional website and Google listing. Would you be interested in a free quick consultation?`;

/** Opens a prefilled WhatsApp chat (wa.me link). */
export function openWhatsApp(url: string) {
  window.open(url, "_blank", "noopener,noreferrer");
}

/**
 * Shows the exact message before it opens in WhatsApp. When the admin requires their message
 * for this lead's campaign, it's shown read-only; otherwise it can be edited.
 */
export function WhatsAppDialog({
  lead,
  open,
  onOpenChange,
}: {
  lead: Lead;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const invalidateData = useInvalidateData();
  const { data: templates = [] } = useTemplates();
  const whatsappTemplates = templates.filter((t) => t.channel === "whatsapp");
  const format = useQuery({
    queryKey: ["whatsapp", "format", lead.id],
    queryFn: () => api.whatsappFormat(lead.id),
    enabled: open,
  });
  const locked = !!format.data?.mustUse;
  const [body, setBody] = useState(DEFAULT_WHATSAPP_MESSAGE);
  const [preview, setPreview] = useState<WhatsAppMessage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Start from the admin's message for this campaign when there is one.
  useEffect(() => {
    if (open && format.data) setBody(format.data.template?.body ?? DEFAULT_WHATSAPP_MESSAGE);
  }, [open, format.data]);

  useEffect(() => {
    if (!open || !format.data) return;
    if (locked) {
      setPreview(format.data.preview);
      setError(
        format.data.template
          ? null
          : "Your admin hasn't set a WhatsApp message for this lead's campaign yet.",
      );
      return;
    }
    const t = window.setTimeout(() => {
      setLoading(true);
      api
        .renderWhatsApp(lead.id, body)
        .then((p) => {
          setPreview(p);
          setError(null);
        })
        .catch((err) =>
          setError(err instanceof ApiError ? err.message : "Could not prepare the message."),
        )
        .finally(() => setLoading(false));
    }, 300);
    return () => window.clearTimeout(t);
  }, [open, body, lead.id, locked, format.data]);

  // After WhatsApp opens, staff say what happened; nothing is logged until they do.
  const [opened, setOpened] = useState(false);
  const [recording, setRecording] = useState(false);
  useEffect(() => {
    if (open) setOpened(false);
  }, [open]);

  function send() {
    if (!preview?.url) return;
    openWhatsApp(preview.url);
    setOpened(true);
  }

  async function record(result: WhatsAppResult) {
    setRecording(true);
    try {
      await api.whatsappResult(lead.id, { result, text: preview?.text ?? "" });
      if (result === "sent") toast.success("WhatsApp message logged.");
      else if (result === "not_on_whatsapp")
        toast.success("Marked as not on WhatsApp — try a call or email instead.");
      void invalidateData();
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't save that.");
    } finally {
      setRecording(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Closing after opening WhatsApp without answering counts as "didn't send".
        if (!next && opened && !recording) void record("not_sent");
        else onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-lg">
        {opened ? (
          <WhatsAppResultStep
            busy={recording}
            onPick={(r) => void record(r)}
            onBack={() => setOpened(false)}
          />
        ) : (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 font-display">
                <MessageCircle className="h-5 w-5 text-success" /> WhatsApp {lead.businessName}
              </DialogTitle>
              <DialogDescription>
                Check the message below. WhatsApp opens with it ready — you press send there, then
                come back and say whether it went through.
              </DialogDescription>
            </DialogHeader>
            {lead.whatsappStatus === "no" && (
              <p className="flex items-center gap-1.5 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
                <XCircle className="h-4 w-4 shrink-0" /> Marked as not on WhatsApp
                {lead.whatsappCheckedBy ? ` by ${lead.whatsappCheckedBy}` : ""}
                {lead.whatsappCheckedAt ? ` ${relativeTime(lead.whatsappCheckedAt)}` : ""}.
              </p>
            )}

            {format.isPending ? (
              <div className="flex justify-center py-8 text-muted-foreground">
                <Loader2 className="h-5 w-5 animate-spin" />
              </div>
            ) : (
              <div className="space-y-3">
                {format.data?.template && (
                  <p className="flex items-center gap-1.5 rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
                    {locked && <Lock className="h-3.5 w-3.5 shrink-0" />}
                    Message “{format.data.template.name}”{" "}
                    {format.data.source === "This lead"
                      ? "assigned to this lead"
                      : format.data.source === "Default message"
                        ? "set as the default for leads without their own"
                        : `set for “${format.data.source}”`}
                    {locked && " — it can't be changed here."}
                  </p>
                )}

                {!locked && (
                  <>
                    {whatsappTemplates.length > 0 && (
                      <Select
                        value=""
                        onValueChange={(id) => {
                          const t = whatsappTemplates.find((x) => x.id === id);
                          if (t) setBody(t.body);
                        }}
                      >
                        <SelectTrigger className="w-full">
                          <SelectValue placeholder="Use a WhatsApp template" />
                        </SelectTrigger>
                        <SelectContent>
                          {whatsappTemplates.map((t) => (
                            <SelectItem key={t.id} value={t.id}>
                              {t.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                    <div className="space-y-1.5">
                      <Label htmlFor="wa-body">Message</Label>
                      <Textarea
                        id="wa-body"
                        rows={7}
                        value={body}
                        onChange={(e) => setBody(e.target.value)}
                      />
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
                    </div>
                  </>
                )}

                {error ? (
                  <p className="flex items-center gap-1.5 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm">
                    <AlertTriangle className="h-4 w-4 shrink-0" /> {error}
                  </p>
                ) : (
                  <div className="rounded-lg bg-success/5 p-3 text-sm">
                    <p className="mb-1 text-xs text-muted-foreground">
                      To {preview?.number ? `+${preview.number}` : lead.phone}
                      {loading && <Loader2 className="ml-1 inline h-3 w-3 animate-spin" />}
                    </p>
                    <p className="whitespace-pre-wrap">{preview?.text}</p>
                  </div>
                )}
                {preview && !preview.number && !error && (
                  <p className="flex items-center gap-1.5 text-xs text-destructive">
                    <AlertTriangle className="h-3.5 w-3.5" /> Couldn't work out the international
                    number. Add the country code to the phone (e.g. +92…).
                  </p>
                )}
                {preview?.likelyMobile === false && preview.number && (
                  <p className="flex items-center gap-1.5 text-xs text-warning-foreground">
                    <AlertTriangle className="h-3.5 w-3.5" /> This looks like a landline — it may
                    not have WhatsApp.
                  </p>
                )}
              </div>
            )}
            <DialogFooter>
              <Button variant="ghost" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button
                onClick={send}
                disabled={!preview?.url || !!error}
                className="bg-success text-success-foreground hover:bg-success/90"
              >
                <MessageCircle className="h-4 w-4" /> Open WhatsApp
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** "What happened?" after WhatsApp opened — the only way the app learns if the number has it. */
export function WhatsAppResultStep({
  busy,
  onPick,
  onBack,
}: {
  busy: boolean;
  onPick: (result: WhatsAppResult) => void;
  onBack?: () => void;
}) {
  return (
    <>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2 font-display">
          <MessageCircle className="h-5 w-5 text-success" /> Did the message go through?
        </DialogTitle>
        <DialogDescription>
          If WhatsApp said the phone number isn't on WhatsApp, choose “Not on WhatsApp” so nobody
          tries this number again.
        </DialogDescription>
      </DialogHeader>
      <div className="grid gap-2">
        <Button
          disabled={busy}
          onClick={() => onPick("sent")}
          className="h-auto justify-start bg-success py-3 text-success-foreground hover:bg-success/90"
        >
          <CheckCircle2 className="h-5 w-5" />
          <span className="text-left">
            <span className="block font-semibold">Sent</span>
            <span className="block text-xs font-normal opacity-90">
              Logged on the timeline; lead moves to Contacted
            </span>
          </span>
        </Button>
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => onPick("not_on_whatsapp")}
          className="h-auto justify-start border-destructive/40 py-3 text-destructive hover:bg-destructive/5 hover:text-destructive"
        >
          <XCircle className="h-5 w-5" />
          <span className="text-left">
            <span className="block font-semibold">Not on WhatsApp</span>
            <span className="block text-xs font-normal text-muted-foreground">
              The number is marked, and skipped in WhatsApp lists
            </span>
          </span>
        </Button>
        <Button
          variant="ghost"
          disabled={busy}
          onClick={() => onPick("not_sent")}
          className="justify-start"
        >
          I didn't send it
        </Button>
      </div>
      {onBack && (
        <DialogFooter>
          <Button variant="link" size="sm" onClick={onBack} disabled={busy} className="px-0">
            <Undo2 className="h-4 w-4" /> Back to the message
          </Button>
        </DialogFooter>
      )}
    </>
  );
}
