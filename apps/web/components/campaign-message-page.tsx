"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, CalendarClock, CheckCircle2, Clock3, FileText, LoaderCircle, Megaphone, Pencil, Send, Users } from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { useConfirmDialog } from "@/components/confirm-dialog";

const api = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
type Result<T> = { success: boolean; data?: T; error?: { message?: string } };
type Campaign = { id: string; mailboxId: string; name: string; subject: string; body: string; audienceMode: "all_opted_in" | "selected"; audienceContactIds: string[]; manualRecipients: Array<{ email: string; name: string }>; attachments: Array<{ filename: string; contentType: string }>; status: "draft" | "scheduled" | "sending" | "sent" | "partial" | "failed" | "canceled"; recipientCount: number; scheduledAt: string | null; fromAddress: string; createdAt: string; sentAt: string | null; recipientStats: Record<string, number>; recipientIssues: Array<{ email: string; status: string; error: string | null }> };
type CampaignRecipient = { id: string; email: string; recipientName: string | null; status: string; error: string | null; sentAt: string | null; deliveredAt: string | null; lastEventAt: string | null };

function statusLabel(status: string) { return status === "partial" ? "Partially sent" : status.charAt(0).toUpperCase() + status.slice(1).replaceAll("_", " "); }

export function CampaignMessagePage({ campaignId }: { campaignId: string }) {
  const { confirm, dialog: confirmDialog } = useConfirmDialog();
  const router = useRouter();
  const [campaign, setCampaign] = useState<Campaign | null>(null);
  const [recipients, setRecipients] = useState<CampaignRecipient[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const load = useCallback(async () => {
    const workspaceId = localStorage.getItem("widesip.workspace") ?? "";
    if (!workspaceId) throw new Error("Choose a workspace to view its campaigns.");
    const [campaignResponse, recipientResponse] = await Promise.all([
      fetch(`${api}/v1/campaigns?workspaceId=${encodeURIComponent(workspaceId)}`, { credentials: "include" }),
      fetch(`${api}/v1/campaigns/${encodeURIComponent(campaignId)}/recipients`, { credentials: "include" }),
    ]);
    const [campaignResult, recipientResult] = await Promise.all([campaignResponse.json(), recipientResponse.json()]) as [Result<Campaign[]>, Result<CampaignRecipient[]>];
    if (!campaignResponse.ok || !campaignResult.data) throw new Error(campaignResult.error?.message ?? "Could not load this campaign.");
    if (!recipientResponse.ok || !recipientResult.data) throw new Error(recipientResult.error?.message ?? "Could not load campaign recipients.");
    setCampaign(campaignResult.data.find(item => item.id === campaignId) ?? null);
    setRecipients(recipientResult.data);
  }, [campaignId]);

  useEffect(() => {
    let active = true;
    void load().catch(cause => { if (active) setError(cause instanceof Error ? cause.message : "Could not load this campaign."); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [load]);

  useEffect(() => {
    const workspaceId = localStorage.getItem("widesip.workspace") ?? "";
    if (!workspaceId) return;
    let active = true;
    let loadingUpdate = false;
    let debounce: number | undefined;
    let recovery: number | undefined;
    const update = () => {
      if (!active || loadingUpdate || document.visibilityState !== "visible") return;
      loadingUpdate = true;
      void load().catch(cause => { if (active) setError(cause instanceof Error ? cause.message : "Could not update campaign activity."); }).finally(() => { loadingUpdate = false; });
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
  }, [load]);

  async function runAction(action: "send" | "cancel-schedule") {
    if (!campaign || busy) return;
    const prompt = action === "send"
      ? `Send “${campaign.name}” to its eligible audience now? Each opted-in person receives a separate email.`
      : `Cancel the scheduled delivery for “${campaign.name}”? Messages already accepted by the provider cannot be recalled.`;
    if (!await confirm({ title: "Delete campaign?", message: prompt, confirmLabel: "Delete campaign", destructive: true })) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const response = await fetch(`${api}/v1/campaigns/${campaign.id}/${action}`, { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: "{}" });
      const result = await response.json() as Result<{ message?: string; accepted?: number; failed?: number }>;
      if (!response.ok || !result.data) throw new Error(result.error?.message ?? "Could not update the campaign.");
      setNotice(result.data.message ?? `${result.data.accepted ?? 0} accepted${result.data.failed ? `; ${result.data.failed} failed` : ""}.`);
      await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not update the campaign."); }
    finally { setBusy(false); }
  }

  const displayDate = campaign?.sentAt ?? campaign?.scheduledAt ?? campaign?.createdAt;
  const recipientDescription = campaign?.manualRecipients.length
    ? campaign.manualRecipients.map(item => item.name ? `${item.name} <${item.email}>` : item.email).join(", ")
    : campaign?.audienceMode === "all_opted_in" ? "All opted-in contacts in this workspace" : `${campaign?.audienceContactIds.length ?? 0} selected opted-in contacts`;

  return <AppShell>
    <div className="mail-reader-topbar"><Link className="mail-reader-back" href="/app/campaigns"><ArrowLeft size={16}/> Back to campaigns</Link><div className="mail-reader-actions">{campaign?.status === "draft" && <Link className="button secondary" href={`/app/campaigns?edit=${campaign.id}`}><Pencil size={14}/>Edit draft</Link>}{campaign?.status === "draft" && <button className="button" type="button" disabled={busy} onClick={() => void runAction("send")}><Send size={14}/>{busy ? "Working…" : campaign.scheduledAt ? "Schedule campaign" : "Send campaign"}</button>}{campaign?.status === "scheduled" && <button className="button secondary" type="button" disabled={busy} onClick={() => void runAction("cancel-schedule")}>{busy ? "Canceling…" : "Cancel schedule"}</button>}</div></div>
    {error && <p className="auth-error" role="alert">{error}</p>}{notice && <p className="dns-message" role="status">{notice}</p>}
    {loading ? <section className="app-card mail-reader-loading"><LoaderCircle size={17} className="mail-spinner"/>Loading campaign…</section> : !campaign ? <section className="app-card mail-reader-loading">This campaign could not be found. <Link href="/app/campaigns">Return to campaigns</Link></section> : <>
      <header className="mail-reader-heading"><h1>{campaign.subject || campaign.name}</h1><p className="campaign-reader-subtitle">{campaign.name}</p></header>
      <section className="app-card campaign-message-card"><div className="mail-thread-message-header"><span className="mail-thread-avatar campaign-message-avatar"><Megaphone size={16}/></span><div className="mail-thread-sender"><b>{campaign.name}</b><small>from {campaign.fromAddress}</small><small>to {recipientDescription}</small></div><time>{displayDate ? new Date(displayDate).toLocaleString() : "—"}</time></div><div className="mail-thread-subject">{campaign.subject}</div><div className="campaign-message-body">{campaign.body}</div>{campaign.attachments.length > 0 && <div className="campaign-message-attachments"><b><FileText size={14}/>Attachments</b>{campaign.attachments.map(file => <span key={file.filename}>{file.filename}</span>)}</div>}</section>
      <section className="campaign-delivery-section"><div className="campaign-delivery-heading"><div><h2>Campaign activity</h2></div><span className={`campaign-status-pill status-${campaign.status}`}>{statusLabel(campaign.status)}</span></div>
        <div className="campaign-delivery-stats-grid">{[{ label: "Recipients", value: campaign.recipientCount || recipients.length, icon: Users }, { label: "Delivered", value: campaign.recipientStats.delivered ?? 0, icon: CheckCircle2 }, { label: "Bounced", value: campaign.recipientStats.bounced ?? 0, icon: CalendarClock }, { label: "Complaints", value: campaign.recipientStats.complained ?? 0, icon: Clock3 }].map(item => <div className="app-card campaign-delivery-stat" key={item.label}><item.icon size={15}/><span>{item.label}</span><b>{item.value}</b></div>)}</div>
        <section className="app-card campaign-recipient-card"><div className="card-heading-row"><div><h2 className="card-title">Recipients</h2><p className="field-help">Individual delivery status for this campaign.</p></div><span className="inbox-result-count">{recipients.length} records</span></div>{recipients.length ? <div className="table-wrap"><table className="table"><thead><tr><th>Recipient</th><th>Status</th><th>Updated</th><th>Delivery note</th></tr></thead><tbody>{recipients.map(recipient => <tr key={recipient.id}><td><b>{recipient.recipientName || recipient.email}</b>{recipient.recipientName && <small style={{ display: "block" }}>{recipient.email}</small>}</td><td><span className={`campaign-status-pill status-${recipient.status}`}>{statusLabel(recipient.status)}</span></td><td>{(recipient.lastEventAt || recipient.sentAt || recipient.deliveredAt) ? new Date(recipient.lastEventAt || recipient.sentAt || recipient.deliveredAt!).toLocaleString() : "—"}</td><td>{recipient.error || "—"}</td></tr>)}</tbody></table></div> : <div className="inbox-empty"><span><Users size={18}/></span><b>No delivery records yet</b><p>{campaign.status === "draft" ? "Recipient records are created when the campaign is sent or scheduled." : "Recipient activity will appear here when available."}</p></div>}</section>
      </section>
    </>}
    {confirmDialog}
  </AppShell>;
}
