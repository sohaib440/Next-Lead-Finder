import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2, MessageCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { queryKeys, useTemplates } from "@/hooks/queries";
import { api } from "@/lib/api";
import type { Lead } from "@/types";

const CAMPAIGN = "__campaign__";
const NEW = "__new__";

/** Admin: give this one lead its own WhatsApp message, instead of its campaign's. */
export function LeadWhatsAppCard({ lead }: { lead: Lead }) {
  const qc = useQueryClient();
  const { data: templates = [] } = useTemplates();
  const waTemplates = templates.filter((t) => t.channel === "whatsapp");
  const [choice, setChoice] = useState(lead.whatsappTemplateId || CAMPAIGN);
  const [name, setName] = useState("");
  const [body, setBody] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setChoice(lead.whatsappTemplateId || CAMPAIGN);
    setName(`${lead.businessName} WhatsApp`);
    setBody("");
  }, [lead.id, lead.whatsappTemplateId, lead.businessName]);

  const current = waTemplates.find((t) => t.id === lead.whatsappTemplateId);

  async function save() {
    if (choice === NEW && !body.trim()) {
      toast.error("Write the message first.");
      return;
    }
    setSaving(true);
    try {
      let templateId: string | null = choice === CAMPAIGN ? null : choice === NEW ? null : choice;
      if (choice === NEW) {
        const created = await api.createTemplate({
          name: name.trim() || `${lead.businessName} WhatsApp`,
          channel: "whatsapp",
          subject: "",
          body: body.trim(),
        });
        templateId = created.id;
        void qc.invalidateQueries({ queryKey: queryKeys.templates });
      }
      await api.setLeadWhatsapp(lead.id, templateId);
      toast.success(
        templateId
          ? "This lead will get its own WhatsApp message."
          : "This lead will use its campaign's message.",
      );
      void qc.invalidateQueries({ queryKey: queryKeys.lead(lead.id) });
      void qc.invalidateQueries({ queryKey: ["whatsapp", "format", lead.id] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className="card-shadow rounded-xl">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 font-display text-base font-semibold">
          <MessageCircle className="h-4 w-4 text-success" /> WhatsApp message
        </CardTitle>
        <CardDescription>
          {current
            ? `This lead uses “${current.name}”.`
            : "This lead uses its campaign's message, or the workspace default."}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <Select value={choice} onValueChange={setChoice}>
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={CAMPAIGN}>Use the campaign message</SelectItem>
            <SelectItem value={NEW}>Create a message for this lead</SelectItem>
            {waTemplates.map((t) => (
              <SelectItem key={t.id} value={t.id}>
                {t.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {choice === NEW && (
          <div className="space-y-2">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Template name" />
            <Textarea
              rows={6}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder={"Hello {{firstName|there}}, I came across {{businessName}} in {{city}}."}
            />
          </div>
        )}
        <Button
          size="sm"
          onClick={() => void save()}
          disabled={saving || (choice !== NEW && choice === (lead.whatsappTemplateId || CAMPAIGN))}
        >
          {saving && <Loader2 className="h-4 w-4 animate-spin" />} Save for this lead
        </Button>
      </CardContent>
    </Card>
  );
}
