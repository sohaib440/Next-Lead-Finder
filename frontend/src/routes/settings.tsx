import { useEffect, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Globe, KeyRound, Loader2, MapPinned, Save, Sparkles, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { CountryCombobox } from "@/components/CountryCombobox";
import { AdminOnly } from "@/components/AdminOnly";
import { BackupsCard } from "@/components/BackupsCard";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { SourceBadge } from "@/components/SourceBadge";
import { queryKeys, useInvalidateData, useSettings, useStats, useTemplates, useUpdateSettings } from "@/hooks/queries";
import { api } from "@/lib/api";
import { formatNumber } from "@/utils/format";
import type { AppSettings, LeadSource, WebsiteFilter } from "@/types";

export const Route = createFileRoute("/settings")({
  head: () => ({
    meta: [
      { title: "Settings — LeadFinder Pro" },
      { name: "description", content: "Workspace profile, search defaults, and lead source configuration." },
    ],
  }),
  component: () => (
    <AdminOnly>
      <SettingsPage />
    </AdminOnly>
  ),
});

const SOURCE_OPTIONS: { value: LeadSource; label: string; description: string; icon: typeof Globe }[] = [
  { value: "auto", label: "Automatic", description: "Use the Places API when a key is saved, otherwise scrape Google Maps.", icon: Sparkles },
  { value: "google_maps", label: "Google Maps scraper", description: "Free, no key needed. Slower (2–3 s per business) and may be rate-limited by Google.", icon: MapPinned },
  { value: "google_places", label: "Google Places API", description: "Official and fast. Billed by Google per request; max 60 results per search.", icon: Globe },
];

type Draft = Omit<AppSettings, "hasPlacesApiKey" | "placesApiKeyHint">;

const CURRENCIES = ["USD", "EUR", "GBP", "PKR", "INR", "AED", "SAR", "CAD", "AUD"];

function SettingsPage() {
  const { settings, isSuccess } = useSettings();
  const update = useUpdateSettings();
  const qc = useQueryClient();
  const invalidateData = useInvalidateData();
  const { data: stats } = useStats();
  const { data: templates = [] } = useTemplates();
  const whatsappTemplates = templates.filter((t) => t.channel === "whatsapp");

  const [draft, setDraft] = useState<Draft>(settings);
  const [apiKey, setApiKey] = useState("");
  const [confirmWipe, setConfirmWipe] = useState(false);

  useEffect(() => {
    if (isSuccess) setDraft(settings);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSuccess]);

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((d) => ({ ...d, [key]: value }));
  const dirty = (Object.keys(draft) as (keyof Draft)[]).some((k) => draft[k] !== settings[k]);

  async function save() {
    try {
      const saved = await update.mutateAsync(draft);
      setDraft(saved);
      toast.success("Settings saved.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save settings.");
    }
  }

  async function saveKey(value: string | null) {
    try {
      await update.mutateAsync({ googlePlacesApiKey: value });
      setApiKey("");
      toast.success(value ? "API key saved." : "API key removed.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not update the API key.");
    }
  }

  async function wipeLeads() {
    try {
      const { deleted } = await api.deleteAllLeads();
      toast.success(`${formatNumber(deleted)} leads deleted.`);
      void invalidateData();
      void qc.invalidateQueries({ queryKey: queryKeys.leadFacets });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Delete failed.");
    } finally {
      setConfirmWipe(false);
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6 pb-20">
      <div>
        <h2 className="font-display text-xl font-bold">Settings</h2>
        <p className="text-sm text-muted-foreground">Saved to the database and shared by every browser using this backend.</p>
      </div>

      {/* Lead source */}
      <Card className="card-shadow rounded-xl">
        <CardHeader className="flex flex-row items-start justify-between gap-3">
          <div>
            <CardTitle className="font-display text-base font-semibold">Lead source</CardTitle>
            <CardDescription>Where new searches collect businesses from.</CardDescription>
          </div>
          <SourceBadge />
        </CardHeader>
        <CardContent className="space-y-5">
          <RadioGroup value={draft.leadSource} onValueChange={(v) => set("leadSource", v as LeadSource)} className="gap-3">
            {SOURCE_OPTIONS.map((o) => (
              <Label
                key={o.value}
                className="flex cursor-pointer items-start gap-3 rounded-lg border border-border p-3 font-normal has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:bg-primary/5"
              >
                <RadioGroupItem value={o.value} className="mt-0.5" />
                <o.icon className="mt-0.5 h-4 w-4 text-muted-foreground" />
                <span>
                  <span className="block text-sm font-medium">{o.label}</span>
                  <span className="block text-xs text-muted-foreground">{o.description}</span>
                </span>
              </Label>
            ))}
          </RadioGroup>

          <div className="space-y-2 rounded-lg border border-border bg-muted/40 p-4">
            <Label htmlFor="places-key" className="flex items-center gap-2 text-sm font-semibold">
              <KeyRound className="h-4 w-4" /> Google Places API key
            </Label>
            <p className="text-xs text-muted-foreground">
              {settings.hasPlacesApiKey
                ? `A key ending in ${settings.placesApiKeyHint?.slice(-4)} is saved. Enter a new one to replace it.`
                : "No key saved. Create one in Google Cloud Console with the Places API (New) enabled."}
            </p>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input
                id="places-key"
                type="password"
                autoComplete="off"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={settings.placesApiKeyHint ?? "AIza…"}
              />
              <Button variant="outline" disabled={!apiKey.trim() || update.isPending} onClick={() => saveKey(apiKey.trim())}>
                Save key
              </Button>
              {settings.hasPlacesApiKey && (
                <Button variant="ghost" disabled={update.isPending} onClick={() => saveKey(null)}>
                  Remove
                </Button>
              )}
            </div>
            {draft.leadSource === "google_places" && !settings.hasPlacesApiKey && (
              <p className="text-xs text-destructive">Searches will fail until a key is saved (unless one is set in backend/.env).</p>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Search defaults */}
      <Card className="card-shadow rounded-xl">
        <CardHeader>
          <CardTitle className="font-display text-base font-semibold">Search defaults</CardTitle>
          <CardDescription>Pre-filled values on the Find Leads form.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label>Default country</Label>
              <CountryCombobox value={draft.defaultCountry} onChange={(v) => set("defaultCountry", v)} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="limit">Default maximum results</Label>
              <Input
                id="limit"
                type="number"
                min={1}
                max={5000}
                value={draft.defaultResultLimit}
                onChange={(e) => set("defaultResultLimit", Math.min(5000, Math.max(1, Number(e.target.value) || 1)))}
              />
            </div>
          </div>
          <div className="flex flex-wrap gap-5">
            {([
              ["defaultPhone", "Collect phone numbers"],
              ["defaultEmail", "Collect emails"],
            ] as const).map(([key, label]) => (
              <Label key={key} className="flex items-center gap-2 text-sm font-normal">
                <Checkbox checked={draft[key]} onCheckedChange={(v) => set(key, v === true)} />
                {label}
              </Label>
            ))}
          </div>
          <div className="flex items-center justify-between gap-3 border-t border-border pt-4">
            <div>
              <p className="text-sm font-medium">Website filter</p>
              <p className="text-xs text-muted-foreground">Which businesses new searches collect by default.</p>
            </div>
            <Select value={draft.defaultWebsiteFilter} onValueChange={(v) => set("defaultWebsiteFilter", v as WebsiteFilter)}>
              <SelectTrigger className="w-48"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="any">All businesses</SelectItem>
                <SelectItem value="with">Has a website</SelectItem>
                <SelectItem value="without">No website</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      {/* Display + profile */}
      <Card className="card-shadow rounded-xl">
        <CardHeader>
          <CardTitle className="font-display text-base font-semibold">Workspace & display</CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="name">Workspace name</Label>
              <Input id="name" value={draft.profileName} onChange={(e) => set("profileName", e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="email">Contact email</Label>
              <Input id="email" type="email" value={draft.profileEmail} onChange={(e) => set("profileEmail", e.target.value)} />
            </div>
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label>Rows per page</Label>
              <Select value={String(draft.rowsPerPage)} onValueChange={(v) => set("rowsPerPage", Number(v))}>
                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {[10, 25, 50, 100].map((n) => <SelectItem key={n} value={String(n)}>{n}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2 sm:mt-7">
              <Label htmlFor="compact" className="font-normal">Compact tables</Label>
              <Switch id="compact" checked={draft.compactTable} onCheckedChange={(v) => set("compactTable", v)} />
            </div>
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label>Deal currency</Label>
              <Select value={draft.currency} onValueChange={(v) => set("currency", v)}>
                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {CURRENCIES.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card className="card-shadow rounded-xl">
        <CardHeader>
          <CardTitle className="font-display text-base font-semibold">WhatsApp messages</CardTitle>
          <CardDescription>
            Create a message per campaign in Search History → WhatsApp message. It is assigned to that campaign's leads. A lead can also have its own message. Leads without either get the default below.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="space-y-2">
            <Label>Default message</Label>
            <Select
              value={draft.defaultWhatsappTemplateId ?? "__none__"}
              onValueChange={(v) => set("defaultWhatsappTemplateId", v === "__none__" ? null : v)}
            >
              <SelectTrigger className="w-full sm:w-96">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">No default</SelectItem>
                {whatsappTemplates.map((t) => (
                  <SelectItem key={t.id} value={t.id}>
                    {t.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {whatsappTemplates.length === 0 && (
              <p className="text-xs text-muted-foreground">Create WhatsApp messages on the Templates page (WhatsApp tab) first.</p>
            )}
          </div>
          <div className="flex items-center justify-between gap-3 border-t border-border pt-4">
            <div>
              <p className="text-sm font-medium">Staff must send the admin's message</p>
              <p className="text-xs text-muted-foreground">
                Staff see the exact message before sending but can't change it. Turn off to let them write their own.
              </p>
            </div>
            <Switch checked={draft.whatsappStaffMustUseFormat} onCheckedChange={(v) => set("whatsappStaffMustUseFormat", v)} />
          </div>
        </CardContent>
      </Card>

      <BackupsCard />

      {/* Danger zone */}
      <Card className="rounded-xl border-destructive/30">
        <CardHeader>
          <CardTitle className="font-display text-base font-semibold text-destructive">Danger zone</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-sm font-medium">Delete all leads</p>
            <p className="text-xs text-muted-foreground">
              Permanently removes {stats ? formatNumber(stats.totalLeads) : "every"} lead with its activity and tasks. Search history is kept.
            </p>
          </div>
          <Button variant="destructive" disabled={!stats?.totalLeads} onClick={() => setConfirmWipe(true)}>
            <Trash2 className="h-4 w-4" /> Delete all leads
          </Button>
        </CardContent>
      </Card>

      {dirty && (
        <div className="fixed inset-x-0 bottom-0 z-30 border-t border-border bg-card/95 px-4 py-3 backdrop-blur lg:left-64">
          <div className="mx-auto flex max-w-3xl items-center justify-end gap-3">
            <span className="mr-auto text-sm text-muted-foreground">You have unsaved changes.</span>
            <Button variant="ghost" onClick={() => setDraft(settings)}>Discard</Button>
            <Button onClick={save} disabled={update.isPending}>
              {update.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              Save changes
            </Button>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={confirmWipe}
        onOpenChange={setConfirmWipe}
        title="Delete every lead?"
        description={`This permanently deletes ${formatNumber(stats?.totalLeads ?? 0)} leads. It cannot be undone.`}
        confirmLabel="Delete all leads"
        onConfirm={wipeLeads}
      />
    </div>
  );
}
