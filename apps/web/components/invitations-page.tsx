"use client";

import { useEffect, useState } from "react";
import { ArrowRight, Building2, Check, RefreshCw } from "lucide-react";
import { AppShell } from "@/components/app-shell";
import "@/app/app/team/team-controls.css";

const api = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
type Invitation = { id: string; email: string; role: string; status: string; expiresAt: string; createdAt: string; workspaceId: string; workspaceName: string };
type SentInvitation = { id: string; email: string; role: string; status: string; expiresAt: string; createdAt: string; mailboxIds: string[] };
type MailboxOption = { id: string; address: string; domainName: string };
type Result<T> = { data?: T; error?: { message?: string } };

export function InvitationsPage() {
  const [items, setItems] = useState<Invitation[]>([]);
  const [sent, setSent] = useState<SentInvitation[]>([]);
  const [availableMailboxes, setAvailableMailboxes] = useState<MailboxOption[]>([]);
  const [mailboxDrafts, setMailboxDrafts] = useState<Record<string, string[]>>({});
  const [busy, setBusy] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  async function load() {
    const workspaceId = localStorage.getItem("widesip.workspace") ?? "";
    const [response, teamResponse] = await Promise.all([
      fetch(`${api}/v1/my/invitations`, { credentials: "include" }),
      workspaceId ? fetch(`${api}/v1/team?workspaceId=${encodeURIComponent(workspaceId)}`, { credentials: "include" }) : Promise.resolve(null),
    ]);
    const result = await response.json() as Result<Invitation[]>;
    if (!response.ok) throw new Error(result.error?.message ?? "Could not load invitations.");
    setItems(result.data ?? []);
    if (teamResponse?.ok) {
      const sentResult = await teamResponse.json() as Result<{ currentRole: string; invitations: SentInvitation[]; availableMailboxes: MailboxOption[] }>;
      const pending = ["owner", "admin"].includes(sentResult.data?.currentRole ?? "") ? (sentResult.data?.invitations ?? []).filter(row => row.status === "pending") : [];
      setSent(pending);
      setAvailableMailboxes(sentResult.data?.availableMailboxes ?? []);
      setMailboxDrafts(Object.fromEntries(pending.map(row => [row.id, row.mailboxIds ?? []])));
    } else { setSent([]); setAvailableMailboxes([]); }
  }
  useEffect(() => { void load().catch(cause => setError(cause instanceof Error ? cause.message : "Could not load invitations.")).finally(() => setLoading(false)); }, []);
  async function accept(invitation: Invitation) {
    setBusy(invitation.id); setError(""); setNotice("");
    try {
      const response = await fetch(`${api}/v1/my/invitations/${invitation.id}/accept`, { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: "{}" });
      const result = await response.json() as Result<{ workspaceId: string }>;
      if (!response.ok || !result.data) throw new Error(result.error?.message ?? "Could not accept this invitation.");
      localStorage.setItem("widesip.workspace", result.data.workspaceId);
      setItems(current => current.filter(row => row.id !== invitation.id));
      setNotice(`You joined ${invitation.workspaceName}. Use the workspace switcher to open it.`);
      window.location.assign("/app");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not accept this invitation."); }
    finally { setBusy(""); }
  }
  async function manageSent(invitation: SentInvitation, action: "resend" | "revoke" | "save-access") {
    setBusy(invitation.id); setError(""); setNotice("");
    try {
      const path = action === "save-access" ? `/v1/team/invitations/${invitation.id}/mailboxes` : `/v1/team/invitations/${invitation.id}${action === "resend" ? "/resend" : ""}`;
      const response = await fetch(`${api}${path}`, { method: action === "resend" ? "POST" : action === "revoke" ? "DELETE" : "PUT", credentials: "include", ...(action === "save-access" ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mailboxIds: mailboxDrafts[invitation.id] ?? [] }) } : {}) });
      const result = await response.json() as Result<{ message?: string }>;
      if (!response.ok) throw new Error(result.error?.message ?? `Could not ${action} this invitation.`);
      setNotice(result.data?.message ?? (action === "resend" ? "Invitation email sent again." : action === "revoke" ? "Invitation revoked." : "Invitation access updated."));
      await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : `Could not ${action} this invitation.`); }
    finally { setBusy(""); }
  }
  return <AppShell><div className="page-heading"><div><h1>Invitations</h1><p>Review invitations from different organizations and join each one with this account.</p></div><button className="button secondary" disabled={loading} onClick={() => { setLoading(true); void load().catch(cause => setError(cause instanceof Error ? cause.message : "Could not refresh invitations.")).finally(() => setLoading(false)); }}><RefreshCw size={15}/> {loading ? "Loading…" : "Refresh"}</button></div>
    {error && <p className="team-notice team-error" role="alert">{error}</p>}{notice && <p className="team-notice" role="status">{notice}</p>}
    {loading ? <section className="app-card"><div className="app-loading"><span className="loading-orbit"/>Loading invitations…</div></section> : <>
    <section className="app-card team-list-card"><div className="card-heading-row"><div><h2 className="card-title">Invitations sent to your email</h2></div><span className="coming-badge">{items.length} pending</span></div>
      {!items.length ? <div className="empty">No pending invitations. New invitations sent to your account email will appear here.</div> : <div className="workspace-invitation-list">{items.map(invitation => <article className="workspace-invitation" key={invitation.id}><span className="onboard-icon"><Building2 size={18}/></span><div className="workspace-invitation-copy"><b>{invitation.workspaceName}</b><span>{invitation.email} · {invitation.role}</span><small>Expires {new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(invitation.expiresAt))}</small></div><button className="button" disabled={!!busy} onClick={() => void accept(invitation)}>{busy === invitation.id ? "Joining…" : "Accept invitation"}<ArrowRight size={15}/></button></article>)}</div>}
    </section>
    {!!sent.length && <section className="app-card team-list-card"><div className="card-heading-row"><div><h2 className="card-title">Pending invitations</h2></div><span className="coming-badge">{sent.length} pending</span></div><div className="team-table-wrap"><table className="team-table"><thead><tr><th>Email</th><th>Role</th><th>Mailbox access</th><th>Expires</th><th>Actions</th></tr></thead><tbody>{sent.map(invitation => <tr key={invitation.id}><td><b>{invitation.email}</b><small>Sent {new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(invitation.createdAt))}</small></td><td><span className={`team-role role-${invitation.role}`}>{invitation.role}</span></td><td>{invitation.role === "member" ? <div className="team-member-mailboxes invitation-mailbox-editor"><div className="team-mailbox-checklist">{availableMailboxes.map(box => { const checked = (mailboxDrafts[invitation.id] ?? []).includes(box.id); return <label className={`team-mailbox-option${checked ? " checked" : ""}`} key={box.id}><input type="checkbox" checked={checked} onChange={event => setMailboxDrafts(current => ({ ...current, [invitation.id]: event.target.checked ? [...(current[invitation.id] ?? []), box.id] : (current[invitation.id] ?? []).filter(id => id !== box.id) }))}/><span className="team-checkbox-mark" aria-hidden="true"><Check size={12}/></span><span className="team-mailbox-option-copy"><b>{box.address}@{box.domainName}</b></span></label>; })}</div></div> : <span className="team-muted">Workspace access</span>}</td><td>{new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(invitation.expiresAt))}</td><td><div className="team-actions invitation-actions">{invitation.role === "member" && <button className="button secondary team-small-button" disabled={!!busy || !(mailboxDrafts[invitation.id] ?? []).length} onClick={() => void manageSent(invitation, "save-access")}>{busy === invitation.id ? "Saving…" : "Save access"}</button>}<button className="button secondary team-small-button" disabled={!!busy} onClick={() => void manageSent(invitation, "resend")}>Resend</button><button className="icon-button danger" aria-label={`Revoke invitation for ${invitation.email}`} disabled={!!busy} onClick={() => void manageSent(invitation, "revoke")}><RefreshCw size={15}/></button></div></td></tr>)}</tbody></table></div></section>}
    </>}
  </AppShell>;
}
