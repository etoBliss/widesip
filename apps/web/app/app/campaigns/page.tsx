"use client";
import type { FormEvent } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Megaphone, Send, Users, Pencil, X, BookmarkPlus, Paperclip, FilePlus2, Sparkles, Search, Check, ArrowRight, Inbox, Plus, RefreshCw, CalendarClock } from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { useConfirmDialog } from "@/components/confirm-dialog";
import { StyledSelect } from "@/components/styled-select";
import { ScheduleCalendar } from "@/components/schedule-calendar";
const api = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
type Result<T> = { success: boolean; data?: T; error?: { message?: string } };
type Contact = { id: string; email: string; firstName: string | null; lastName: string | null; consentStatus: "unknown" | "subscribed" | "unsubscribed"; unsubscribedAt: string | null };
type Mailbox = { id: string; address: string; displayName: string; mailStatus: string };
type CampaignAttachment = { filename: string; contentType: string; content: string };
type ManualRecipient = { email: string; name: string };
type Campaign = { id: string; mailboxId: string; name: string; subject: string; body: string; audienceMode: "all_opted_in" | "selected"; audienceContactIds: string[]; manualRecipients: ManualRecipient[]; manualConsentConfirmed: boolean; attachments: Array<CampaignAttachment | Omit<CampaignAttachment, "content">>; status: "draft" | "scheduled" | "sending" | "sent" | "partial" | "failed" | "canceled"; recipientCount: number; scheduledAt: string | null; fromAddress: string; createdAt: string; sentAt: string | null; recipientStats: Record<string, number>; recipientIssues: Array<{ email: string; status: string; error: string | null }> };
type Template = { id: string; name: string; subject: string; body: string };
function localDateTime(value: string | null) {
  if (!value) return "";
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}
function parseManualRecipients(value: string): ManualRecipient[] {
  const unique = new Map<string, ManualRecipient>();
  for (const raw of value.split(/[\n,;]+/)) {
    const line = raw.trim(); if (!line) continue;
    const match = line.match(/^(.*?)\s*<([^<>]+)>$/);
    const email = (match?.[2] ?? line).trim().toLowerCase();
    const name = (match?.[1] ?? "").replace(/^['"]|['"]$/g, "").trim();
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) unique.set(email, { email, name });
  }
  return [...unique.values()];
}
export default function CampaignsPage() {
  const { confirm, dialog: confirmDialog } = useConfirmDialog();
  const [workspaceId, setWorkspaceId] = useState(""); const [contacts, setContacts] = useState<Contact[]>([]); const [mailboxes, setMailboxes] = useState<Mailbox[]>([]); const [campaignMailboxId, setCampaignMailboxId] = useState(""); const [campaigns, setCampaigns] = useState<Campaign[]>([]); const [templates, setTemplates] = useState<Template[]>([]);
  const [loading, setLoading] = useState(true); const [saving, setSaving] = useState(false); const [sendingId, setSendingId] = useState<string | null>(null); const [editingId, setEditingId] = useState<string | null>(null); const [templateName, setTemplateName] = useState(""); const [error, setError] = useState(""); const [notice, setNotice] = useState("");
  const [selectedTemplateId, setSelectedTemplateId] = useState("");
  const [composerOpen, setComposerOpen] = useState(false); const [campaignView, setCampaignView] = useState<"all" | "draft" | "scheduled" | "sent">("all"); const [campaignSearch, setCampaignSearch] = useState("");
  const [pendingDraft, setPendingDraft] = useState<Campaign | null>(null);
  const [scheduledAt, setScheduledAt] = useState("");
  const [audienceMode, setAudienceMode] = useState<"all_opted_in" | "selected" | "manual">("all_opted_in");
  const [selectedContactIds, setSelectedContactIds] = useState<string[]>([]); const [manualList, setManualList] = useState(""); const [manualConsentConfirmed, setManualConsentConfirmed] = useState(false);
  const [attachments, setAttachments] = useState<CampaignAttachment[]>([]); const [contactSearch, setContactSearch] = useState(""); const [fileBusy, setFileBusy] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  const optedInContacts = useMemo(() => contacts.filter(c => c.consentStatus === "subscribed" && !c.unsubscribedAt), [contacts]);
  const subscribedCount = optedInContacts.length;
  const eligibleCount = audienceMode === "manual" ? parseManualRecipients(manualList).length : audienceMode === "selected" ? optedInContacts.filter(c => selectedContactIds.includes(c.id)).length : optedInContacts.length;
  const shownContacts = optedInContacts.filter(contact => `${contact.email} ${contact.firstName ?? ""} ${contact.lastName ?? ""}`.toLowerCase().includes(contactSearch.toLowerCase()));
  function campaignAudienceCount(campaign: Campaign) { return campaign.manualRecipients?.length ? campaign.manualRecipients.length : campaign.audienceMode === "selected" ? campaign.audienceContactIds?.length ?? 0 : subscribedCount; }
  const readyMailboxes = mailboxes.filter(m => m.mailStatus === "active");
  function setFormValue(name: string, value: string) {
    const element = formRef.current?.elements.namedItem(name);
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) element.value = value;
  }
  useEffect(() => {
    if (!composerOpen || !pendingDraft) return;
    setFormValue("name", pendingDraft.name); setCampaignMailboxId(pendingDraft.mailboxId); setFormValue("subject", pendingDraft.subject); setFormValue("body", pendingDraft.body); setScheduledAt(localDateTime(pendingDraft.scheduledAt));
    setPendingDraft(null);
  }, [composerOpen, pendingDraft]);
  async function load(id = workspaceId) {
    if (!id) return;
    const responses = await Promise.all([
      fetch(`${api}/v1/contacts?workspaceId=${encodeURIComponent(id)}`, { credentials: "include" }),
      fetch(`${api}/v1/mailboxes?workspaceId=${encodeURIComponent(id)}`, { credentials: "include" }),
      fetch(`${api}/v1/campaigns?workspaceId=${encodeURIComponent(id)}`, { credentials: "include" }),
      fetch(`${api}/v1/campaign-templates?workspaceId=${encodeURIComponent(id)}`, { credentials: "include" }),
    ]);
    const [cd, md, ad, td] = await Promise.all(responses.map(r => r.json())) as [Result<Contact[]>, Result<Mailbox[]>, Result<Campaign[]>, Result<Template[]>];
    const failed = responses.findIndex(r => !r.ok);
    if (failed >= 0) throw new Error([cd, md, ad, td][failed].error?.message ?? "Could not load campaign data.");
    setContacts(cd.data ?? []); setMailboxes(md.data ?? []); setCampaignMailboxId(current => current && (md.data ?? []).some(mailbox => mailbox.id === current) ? current : (md.data ?? []).find(mailbox => mailbox.mailStatus === "active")?.id ?? ""); setCampaigns(ad.data ?? []); setTemplates(td.data ?? []);
  }
  useEffect(() => { const id = localStorage.getItem("widesip.workspace") ?? ""; setWorkspaceId(id); if (!id) { setLoading(false); return; } void load(id).catch(e => setError(e instanceof Error ? e.message : "Could not load campaigns.")).finally(() => setLoading(false)); }, []);
  useEffect(() => {
    if (!workspaceId) return;
    let active = true;
    let loadingUpdate = false;
    let debounce: number | undefined;
    let recovery: number | undefined;
    const update = () => {
      if (!active || loadingUpdate || document.visibilityState !== "visible") return;
      loadingUpdate = true;
      void load(workspaceId).catch(e => { if (active) setError(e instanceof Error ? e.message : "Could not update campaigns."); }).finally(() => { loadingUpdate = false; });
    };
    const scheduleUpdate = () => {
      if (debounce !== undefined) window.clearTimeout(debounce);
      debounce = window.setTimeout(update, 250);
    };
    const stream = new EventSource(`${api}/v1/events/inbox?workspaceId=${encodeURIComponent(workspaceId)}`, { withCredentials: true });
    stream.addEventListener("campaign-update", scheduleUpdate);
    stream.addEventListener("ready", scheduleUpdate);
    stream.onopen = () => { if (recovery !== undefined) window.clearInterval(recovery); recovery = undefined; };
    stream.onerror = () => { if (recovery === undefined) recovery = window.setInterval(update, 60_000); };
    window.addEventListener("focus", update);
    document.addEventListener("visibilitychange", update);
    return () => {
      active = false;
      stream.close();
      if (debounce !== undefined) window.clearTimeout(debounce);
      if (recovery !== undefined) window.clearInterval(recovery);
      window.removeEventListener("focus", update);
      document.removeEventListener("visibilitychange", update);
    };
  }, [workspaceId]);
  async function saveDraft(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setSaving(true); setError(""); setNotice(""); const form = event.currentTarget; const v = new FormData(form);
    const localSchedule = scheduledAt;
    const directRecipients = audienceMode === "manual" ? parseManualRecipients(manualList) : [];
    if (audienceMode === "selected" && selectedContactIds.length === 0) { setError("Choose at least one opted-in contact."); setSaving(false); return; }
    if (audienceMode === "manual" && !directRecipients.length) { setError("Enter at least one valid recipient email address."); setSaving(false); return; }
    if (audienceMode === "manual" && !manualConsentConfirmed) { setError("Confirm that each manually added recipient agreed to receive this campaign."); setSaving(false); return; }
    const payload = { workspaceId, mailboxId: v.get("mailboxId"), name: v.get("name"), subject: v.get("subject"), body: v.get("body"), audienceMode: audienceMode === "manual" ? "selected" : audienceMode, audienceContactIds: audienceMode === "selected" ? selectedContactIds : [], manualRecipients: directRecipients, manualConsentConfirmed, attachments, scheduledAt: localSchedule ? new Date(localSchedule).toISOString() : null };
    try {
      const url = editingId ? `${api}/v1/campaigns/${editingId}` : `${api}/v1/campaigns`;
      const response = await fetch(url, { method: editingId ? "PATCH" : "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const result = await response.json() as Result<Campaign>;
      if (!response.ok || !result.data) throw new Error(result.error?.message ?? "Could not save this draft.");
      form.reset(); setEditingId(null); setTemplateName(""); setSelectedTemplateId(""); setAudienceMode("all_opted_in"); setSelectedContactIds([]); setManualList(""); setManualConsentConfirmed(false); setAttachments([]); setComposerOpen(false); setNotice("Draft saved. Review the message before sending or scheduling it."); await load();
    } catch (e) { setError(e instanceof Error ? e.message : "Could not save this draft."); }
    finally { setSaving(false); }
  }
  async function saveTemplate() {
    const form = formRef.current; if (!form) return;
    const v = new FormData(form); const name = templateName.trim();
    if (!name || !String(v.get("subject") ?? "").trim() || !String(v.get("body") ?? "").trim()) { setError("Enter a template name, subject, and message first."); return; }
    setSaving(true); setError(""); setNotice("");
    try {
      const response = await fetch(`${api}/v1/campaign-templates`, { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ workspaceId, name, subject: v.get("subject"), body: v.get("body") }) });
      const result = await response.json() as Result<Template>;
      if (!response.ok || !result.data) throw new Error(result.error?.message ?? "Could not save the template.");
      setTemplateName(""); setNotice(`Template "${name}" saved for this workspace.`); await load();
    } catch (e) { setError(e instanceof Error ? e.message : "Could not save the template."); }
    finally { setSaving(false); }
  }
  function applyTemplate(templateId: string) {
    const template = templates.find(t => t.id === templateId); if (!template) return;
    setFormValue("subject", template.subject); setFormValue("body", template.body);
  }
  async function addCampaignFiles(files: FileList | null) {
    if (!files?.length) return;
    setError("");
    const picked = [...files];
    const existingBytes = attachments.reduce((sum, item) => sum + Math.floor(item.content.length * 3 / 4), 0);
    if (attachments.length + picked.length > 8) { setError("Attach up to eight files to a campaign."); return; }
    if (existingBytes + picked.reduce((sum, item) => sum + item.size, 0) > 6 * 1024 * 1024) { setError("Campaign attachments must total 6 MB or less."); return; }
    if (picked.some(file => /\.(exe|dll|bat|cmd|com|scr|js|jse|vbs|ps1|msi|jar|sh)$/i.test(file.name))) { setError("Executable and script files can’t be attached."); return; }
    setFileBusy(true);
    try {
      const additions = await Promise.all(picked.map(file => new Promise<CampaignAttachment>((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error(`Could not read ${file.name}.`));
        reader.onload = () => { const dataUrl = typeof reader.result === "string" ? reader.result : ""; const content = dataUrl.split(",", 2)[1] ?? ""; content ? resolve({ filename: file.name.slice(0, 180), contentType: file.type || "application/octet-stream", content }) : reject(new Error(`Could not read ${file.name}.`)); };
        reader.readAsDataURL(file);
      })));
      setAttachments(current => [...current, ...additions]);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not read selected files."); }
    finally { setFileBusy(false); }
  }
  async function editDraft(campaign: Campaign) {
    setError(""); setNotice("");
    try {
      const response = await fetch(`${api}/v1/campaigns/${campaign.id}`, { credentials: "include" });
      const result = await response.json() as Result<Campaign>;
      if (!response.ok || !result.data) throw new Error(result.error?.message ?? "Could not load this draft.");
      const full = result.data;
      setEditingId(full.id); setPendingDraft(full);
      setAudienceMode(full.manualRecipients.length ? "manual" : full.audienceMode); setSelectedContactIds(full.audienceContactIds); setManualList(full.manualRecipients.map(r => r.name ? `${r.name} <${r.email}>` : r.email).join("\n")); setManualConsentConfirmed(full.manualConsentConfirmed); setAttachments(full.attachments.filter((file): file is CampaignAttachment => "content" in file));
      setNotice(""); setComposerOpen(true);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not load this draft."); }
  }
  useEffect(() => {
    if (loading) return;
    const editId = new URLSearchParams(window.location.search).get("edit");
    if (!editId) return;
    window.history.replaceState(null, "", window.location.pathname);
    const campaign = campaigns.find(item => item.id === editId);
    if (campaign?.status === "draft") void editDraft(campaign);
  }, [loading, campaigns]);
  function startNewDraft() {
    formRef.current?.reset(); setEditingId(null); setPendingDraft(null); setTemplateName(""); setAudienceMode("all_opted_in"); setSelectedContactIds([]); setManualList(""); setManualConsentConfirmed(false); setAttachments([]); setError(""); setNotice(""); setComposerOpen(true);
  }
  function cancelEdit() { formRef.current?.reset(); setEditingId(null); setTemplateName(""); setAudienceMode("all_opted_in"); setSelectedContactIds([]); setManualList(""); setManualConsentConfirmed(false); setAttachments([]); setError(""); setNotice("Draft editing canceled."); setComposerOpen(false); }
  async function send(campaign: Campaign) {
    const when = campaign.scheduledAt ? ` at ${new Date(campaign.scheduledAt).toLocaleString()}` : " now";
    const count = campaign.recipientCount || campaignAudienceCount(campaign);
    if (!await confirm({ title: campaign.scheduledAt ? "Schedule campaign?" : "Send campaign?", message: `“${campaign.name}” will go to ${count} recipient${count === 1 ? "" : "s"}${when}. Only opted-in contacts and recipients with confirmed permission are included.`, confirmLabel: campaign.scheduledAt ? "Schedule campaign" : "Send campaign" })) return;
    setSendingId(campaign.id); setError(""); setNotice("");
    try {
      const response = await fetch(`${api}/v1/campaigns/${campaign.id}/send`, { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: "{}" });
      const result = await response.json() as Result<{ accepted: number; failed: number; status: string; message: string }>;
      if (!response.ok || !result.data) throw new Error(result.error?.message ?? "Could not process this campaign.");
      setNotice(`${result.data.message}${result.data.failed ? ` ${result.data.failed} failed.` : ""}`); await load();
    } catch (e) { setError(e instanceof Error ? e.message : "Could not process this campaign."); }
    finally { setSendingId(null); }
  }
  async function cancelSchedule(campaign: Campaign) {
    if (!await confirm({ title: "Cancel scheduled campaign?", message: `Cancel the scheduled emails for “${campaign.name}”? Messages already sent by the provider cannot be recalled.`, confirmLabel: "Cancel campaign", destructive: true })) return;
    setSendingId(campaign.id); setError(""); setNotice("");
    try {
      const response = await fetch(`${api}/v1/campaigns/${campaign.id}/cancel-schedule`, { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: "{}" });
      const result = await response.json() as Result<{ message: string }>;
      if (!response.ok || !result.data) throw new Error(result.error?.message ?? "Could not cancel the schedule.");
      setNotice(result.data.message); await load();
    } catch (e) { setError(e instanceof Error ? e.message : "Could not cancel the schedule."); await load().catch(() => undefined); }
    finally { setSendingId(null); }
  }
  const draftCount = campaigns.filter(c => c.status === "draft").length;
  const scheduledCount = campaigns.filter(c => c.status === "scheduled").length;
  const sentCount = campaigns.filter(c => ["sent", "partial", "failed", "canceled"].includes(c.status)).length;
  const matchingCampaigns = campaigns.filter(c => {
    const matchesView = campaignView === "all" || campaignView === "draft" && c.status === "draft" || campaignView === "scheduled" && c.status === "scheduled" || campaignView === "sent" && ["sent", "partial", "failed", "canceled"].includes(c.status);
    const query = campaignSearch.toLowerCase().trim();
    return matchesView && (!query || `${c.name} ${c.subject} ${c.fromAddress}`.toLowerCase().includes(query));
  });
  const viewTabs = [{ id: "all", label: "All campaigns", count: campaigns.length }, { id: "draft", label: "Drafts", count: draftCount }, { id: "scheduled", label: "Scheduled", count: scheduledCount }, { id: "sent", label: "Completed", count: sentCount }] as const;
  const statusLabel = (status: Campaign["status"]) => status === "partial" ? "Partially sent" : status[0].toUpperCase() + status.slice(1);
  return <AppShell>
    <div className="page-heading campaign-page-heading"><div><h1>Campaigns</h1><p>Every draft, scheduled send, and campaign result in one place.</p></div><div className="campaign-heading-actions"><span className="campaign-local-badge"><i/>Local testing · up to 25 recipients</span><button className="button" type="button" onClick={startNewDraft}><Plus size={15}/>New campaign</button></div></div>
    {error && !composerOpen && <p className="auth-error" role="alert">{error}</p>}{notice && !composerOpen && <p className="dns-message" role="status">{notice}</p>}
    <section className="app-card inbox-workspace campaign-inbox"><div className="inbox-toolbar"><div className="inbox-title"><span className="onboard-icon"><Inbox size={18}/></span><div><h2>Campaign inbox</h2><p>Open a campaign to review its message and delivery details.</p></div></div><button className="button secondary campaign-refresh" type="button" disabled={loading} onClick={() => { setLoading(true); void load().catch(e => setError(e instanceof Error ? e.message : "Could not refresh campaigns.")).finally(() => setLoading(false)); }}><RefreshCw size={14} className={loading ? "mail-spinner" : undefined}/>{loading ? "Loading…" : "Refresh"}</button></div>
      <div className="inbox-search-row"><label className="inbox-search"><Search size={15}/><input type="search" aria-label="Search campaigns" value={campaignSearch} onChange={event => setCampaignSearch(event.target.value)} placeholder="Search campaign, subject, or sender"/></label><span className="inbox-result-count">{matchingCampaigns.length} campaign{matchingCampaigns.length === 1 ? "" : "s"}</span></div>
      <div className="inbox-tabs campaign-inbox-tabs" role="tablist" aria-label="Campaign status">{viewTabs.map(tab => <button key={tab.id} type="button" role="tab" aria-selected={campaignView === tab.id} className={campaignView === tab.id ? "active" : ""} onClick={() => setCampaignView(tab.id)}><span>{tab.label}</span><small>{tab.count}</small></button>)}</div>
      {error && <p className="auth-error" role="alert">{error}</p>}
      {loading ? <div className="inbox-empty"><RefreshCw size={17} className="mail-spinner"/>Loading campaigns…</div> : matchingCampaigns.length ? <div className="inbox-message-list">{matchingCampaigns.map(c => <article className="inbox-message-row campaign-inbox-row" key={c.id}><a className="inbox-message-open" href={`/app/campaigns/${c.id}`}><span className="inbox-sender-avatar campaign-row-avatar"><Megaphone size={16}/></span><span className="inbox-message-main"><span className="inbox-message-sender">{c.name}<small>{c.fromAddress}</small></span><b>{c.subject}<span className={`campaign-status-pill status-${c.status}`}>{statusLabel(c.status)}</span></b><small className="inbox-message-preview">{c.body.replace(/\s+/g, " ").slice(0, 150) || "No message preview."} · Delivered {c.recipientStats.delivered ?? 0}, bounced {c.recipientStats.bounced ?? 0}, complaints {c.recipientStats.complained ?? 0}</small></span><time>{c.scheduledAt ? new Date(c.scheduledAt).toLocaleString() : c.sentAt ? new Date(c.sentAt).toLocaleString() : new Date(c.createdAt).toLocaleDateString()}</time></a><details className="message-actions campaign-row-menu"><summary aria-label={`Actions for ${c.name}`}><span>•••</span></summary><div className="message-actions-menu" role="menu">{c.status === "draft" && <><button role="menuitem" type="button" onClick={() => void editDraft(c)}><Pencil size={14}/>Edit draft</button><button role="menuitem" type="button" disabled={sendingId === c.id || campaignAudienceCount(c) === 0} onClick={() => void send(c)}><Send size={14}/>{sendingId === c.id ? "Working…" : c.scheduledAt ? "Schedule campaign" : "Send campaign"}</button></>}{(c.status === "scheduled" || c.status === "partial" && Boolean(c.scheduledAt)) && <button role="menuitem" type="button" disabled={sendingId === c.id} onClick={() => void cancelSchedule(c)}><X size={14}/>{sendingId === c.id ? "Canceling…" : "Cancel schedule"}</button>}<a role="menuitem" href={`/app/campaigns/${c.id}`}><ArrowRight size={14}/>Open campaign</a></div></details></article>)}</div> : <div className="inbox-empty"><span><Megaphone size={20}/></span><b>{campaignSearch ? "No campaigns match your search" : campaignView === "draft" ? "No drafts yet" : campaignView === "scheduled" ? "Nothing scheduled" : campaignView === "sent" ? "No completed campaigns" : "No campaigns yet"}</b><p>{campaignSearch ? "Try a different campaign name, subject, or sender." : "Create a campaign draft to see it in this inbox."}</p>{!campaignSearch && <button className="button" type="button" onClick={startNewDraft}><Plus size={14}/>New campaign</button>}</div>}
    </section>
    {composerOpen && <div className="compose-floating-layer campaign-floating-layer"><section className="compose-floating-modal campaign-compose-modal" role="dialog" aria-modal="false" aria-labelledby="campaign-compose-title"><header className="compose-floating-header"><div><b id="campaign-compose-title">{editingId ? "Edit campaign draft" : "New campaign"}</b><small>Choose the audience, then write and save your message.</small></div><button className="icon-button" type="button" aria-label="Close campaign composer" onClick={() => { setComposerOpen(false); setError(""); }} disabled={saving}><X size={16}/></button></header>
      <div className="campaign-compose-notices">{error && <p className="auth-error" role="alert">{error}</p>}{notice && <p className="dns-message" role="status">{notice}</p>}</div>
      {!readyMailboxes.length ? <div className="empty campaign-compose-empty">Finish sending setup and activate a mailbox under <a className="app-text-link" href="/app/mailboxes">Mailboxes</a> before creating campaigns.</div> : <form ref={formRef} className="campaign-compose-form" onSubmit={saveDraft}>
        <div className="field"><label>Start from a saved template</label><StyledSelect ariaLabel="Start from a saved template" className="campaign-template-select" name="templatePicker" placeholder="Write from scratch" value={selectedTemplateId} onValueChange={value => { setSelectedTemplateId(value); applyTemplate(value); }} options={[{ value: "", label: "Write from scratch" }, ...templates.map(template => ({ value: template.id, label: template.name }))]}/></div>
        <div className="field"><label htmlFor="campaign-name">Internal campaign name</label><input id="campaign-name" name="name" required maxLength={120} placeholder="Monthly product update"/></div>
        <div className="field"><label>Send from</label><StyledSelect ariaLabel="Send from address" className="campaign-sender-select" name="mailboxId" value={campaignMailboxId} onValueChange={setCampaignMailboxId} options={readyMailboxes.map(mailbox => ({ value: mailbox.id, label: `${mailbox.displayName} — ${mailbox.address}`, description: mailbox.address }))} required/></div>
        <section className="campaign-audience-picker"><div className="campaign-subsection-heading"><span className="onboard-icon"><Users size={16}/></span><div><h3>Choose recipients</h3><p>Each person receives a separate message.</p></div></div><div className="campaign-audience-options"><button type="button" className={audienceMode === "all_opted_in" ? "selected" : ""} onClick={() => setAudienceMode("all_opted_in")}><Check size={14}/>All opted-in</button><button type="button" className={audienceMode === "selected" ? "selected" : ""} onClick={() => setAudienceMode("selected")}><Check size={14}/>Choose contacts</button><button type="button" className={audienceMode === "manual" ? "selected" : ""} onClick={() => setAudienceMode("manual")}><Check size={14}/>Add recipients</button></div>
          {audienceMode === "all_opted_in" && <p className="campaign-audience-help">Only opted-in contacts are included. Unsubscribed, bounced, complained, and suppressed recipients are excluded.</p>}
          {audienceMode === "selected" && <div className="campaign-contact-picker"><label className="inbox-search"><Search size={14}/><input aria-label="Search opted-in contacts" value={contactSearch} onChange={event => setContactSearch(event.target.value)} placeholder="Find opted-in contacts"/></label><div className="campaign-contact-list">{shownContacts.map(contact => <label key={contact.id}><input type="checkbox" checked={selectedContactIds.includes(contact.id)} onChange={event => setSelectedContactIds(current => event.target.checked ? [...current, contact.id] : current.filter(id => id !== contact.id))}/><span><b>{[contact.firstName, contact.lastName].filter(Boolean).join(" ") || contact.email}</b><small>{contact.email}</small></span></label>)}{!shownContacts.length && <p>{optedInContacts.length ? "No opted-in contacts match." : "No opted-in contacts yet. Add people in Contacts or use Add recipients."}</p>}</div><small className="field-help">Only contacts recorded as opted in can be selected.</small></div>}
          {audienceMode === "manual" && <div className="campaign-manual-recipients"><label htmlFor="campaign-manual-list">Email addresses (one per line, comma, or semicolon)</label><textarea id="campaign-manual-list" rows={4} value={manualList} onChange={event => setManualList(event.target.value)} placeholder={'Alex Morgan <alex@example.com>\npat@example.com'} /><small>Used for this campaign only; not added to Contacts. Limit: 25 recipients per local send.</small><label className="campaign-consent-check"><input type="checkbox" checked={manualConsentConfirmed} onChange={event => setManualConsentConfirmed(event.target.checked)}/><span>I confirm each person agreed to receive this campaign.</span></label></div>}
        </section>
        <div className="field"><label htmlFor="campaign-subject">Email subject</label><input id="campaign-subject" name="subject" required maxLength={200} placeholder="What's new this month"/></div>
        <div className="field"><label htmlFor="campaign-body">Message</label><textarea id="campaign-body" name="body" required maxLength={100000} rows={8} placeholder={'Hi {{firstName}},\n\nWrite your email here. A Widesip unsubscribe link will be added automatically.'}/><div className="campaign-personalization-help"><Sparkles size={14}/><span>Personalize with <code>{"{{name}}"}</code>, <code>{"{{firstName}}"}</code>, <code>{"{{lastName}}"}</code>, or <code>{"{{email}}"}</code>. Missing first names use “there”.</span></div></div>
        <div className="campaign-attachments"><input id="campaign-attachments" type="file" multiple onChange={event => { void addCampaignFiles(event.target.files); event.currentTarget.value = ""; }}/><label htmlFor="campaign-attachments" className="button secondary"><Paperclip size={14}/>{fileBusy ? "Adding files…" : "Attach files"}</label><span>Up to 8 files, 6 MB total.</span>{attachments.length > 0 && <ul>{attachments.map((file, index) => <li key={`${file.filename}-${index}`}><FilePlus2 size={14}/><span>{file.filename}</span><small>{(Math.floor(file.content.length * 3 / 4) / 1024).toFixed(0)} KB</small><button type="button" aria-label={`Remove ${file.filename}`} onClick={() => setAttachments(current => current.filter((_, itemIndex) => index !== itemIndex))}>×</button></li>)}</ul>}</div>
        <div className="field"><label>Schedule send (optional)</label><ScheduleCalendar value={scheduledAt} onChange={setScheduledAt}/><input type="hidden" name="scheduledAt" value={scheduledAt}/><span className="field-help">Leave blank to send now. Scheduled time must be at least five minutes ahead and within 30 days.</span></div>
        <div className="template-save-row"><div className="field"><label htmlFor="template-name">Save message as a reusable template (optional)</label><input id="template-name" name="templateName" value={templateName} onChange={event => setTemplateName(event.target.value)} maxLength={120} placeholder="Welcome note"/></div><button type="button" className="button secondary" onClick={() => void saveTemplate()} disabled={saving}><BookmarkPlus size={15}/>Save template</button></div>
        <div className="campaign-compose-footer"><span>{eligibleCount} recipient{eligibleCount === 1 ? "" : "s"} · separate delivery</span><button className="button" disabled={saving || !workspaceId}><Megaphone size={15}/>{saving ? "Saving…" : editingId ? "Update draft" : "Save draft"}</button>{editingId && <button type="button" className="button secondary" onClick={cancelEdit}>Cancel edit</button>}</div>
      </form>}
    </section></div>}
    {confirmDialog}
  </AppShell>;
}
