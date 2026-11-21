"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Check, Copy, MailPlus, RefreshCw, ShieldCheck, Trash2, UserRoundPlus, X } from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { useConfirmDialog } from "@/components/confirm-dialog";
import { StyledSelect } from "@/components/styled-select";
import "./team-controls.css";

const api = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
type Member = { userId: string; name: string; email: string; emailVerified: boolean; role: "owner" | "admin" | "member"; joinedAt: string; mailboxIds: string[] };
type Invite = { id: string; email: string; role: "admin" | "member"; mailboxIds: string[]; status: string; expiresAt: string; createdAt: string };
type TeamData = { members: Member[]; invitations: Invite[]; availableMailboxes: { id: string; address: string; domainName: string }[]; currentRole: Member["role"]; currentUserId: string };
type Result<T> = { success?: boolean; data?: T; error?: { message?: string } };
type MailboxOption = TeamData["availableMailboxes"][number];

function MailboxCheckboxes({ boxes, selected, onChange, label }: { boxes: MailboxOption[]; selected: string[]; onChange: (ids: string[]) => void; label: string }) {
  return <fieldset className="team-mailbox-checklist"><legend className="sr-only">{label}</legend>
    {boxes.length ? boxes.map(box => {
      const checked = selected.includes(box.id);
      return <label className={`team-mailbox-option${checked ? " checked" : ""}`} key={box.id}>
        <input type="checkbox" checked={checked} onChange={event => onChange(event.target.checked ? [...selected, box.id] : selected.filter(id => id !== box.id))}/>
        <span className="team-checkbox-mark" aria-hidden="true"><Check size={12}/></span>
        <span className="team-mailbox-option-copy"><b>{box.address}@{box.domainName}</b><small>Team email address</small></span>
      </label>;
    }) : <span className="team-mailbox-empty">Add a verified mailbox before inviting a member.</span>}
  </fieldset>;
}

async function read<T>(response: Response): Promise<Result<T>> {
  const text = await response.text();
  if (!text) throw new Error(`The API returned an empty response (HTTP ${response.status}). Check the API terminal.`);
  try { return JSON.parse(text) as Result<T>; } catch { throw new Error("The API returned an unreadable response. Check the API terminal."); }
}
function date(value: string) { return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(value)); }

export default function TeamPage() {
  const { confirm, dialog: confirmDialog } = useConfirmDialog();
  const [workspaceId, setWorkspaceId] = useState("");
  const [team, setTeam] = useState<TeamData | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [inviteUrl, setInviteUrl] = useState("");
  const [mailboxDrafts, setMailboxDrafts] = useState<Record<string, string[]>>({});
  const [newOwnerId, setNewOwnerId] = useState("");
  const [inviteMailboxIds, setInviteMailboxIds] = useState<string[]>([]);
  const [inviteRole, setInviteRole] = useState<"member" | "admin">("member");

  const load = useCallback(async (workspace: string) => {
    const response = await fetch(`${api}/v1/team?workspaceId=${encodeURIComponent(workspace)}`, { credentials: "include" });
    const result = await read<TeamData>(response);
    if (!response.ok || !result.data) throw new Error(result.error?.message ?? "Could not load your team.");
    setTeam(result.data);
    setMailboxDrafts(Object.fromEntries(result.data.members.map(member => [member.userId, member.mailboxIds ?? []])));
  }, []);

  useEffect(() => {
    const workspace = localStorage.getItem("widesip.workspace") ?? "";
    setWorkspaceId(workspace);
    if (!workspace) { setError("Choose a workspace before managing teammates."); setLoading(false); return; }
    void load(workspace).catch((cause) => setError(cause instanceof Error ? cause.message : "Could not load your team.")).finally(() => setLoading(false));
  }, [load]);

  async function act(key: string, path: string, init?: RequestInit): Promise<boolean> {
    setBusy(key); setError(""); setNotice("");
    try {
      const response = await fetch(`${api}${path}`, { credentials: "include", ...init });
      const result = await read<{ inviteUrl?: string; message?: string }>(response);
      if (!response.ok) throw new Error(result.error?.message ?? "That action could not be completed.");
      if (result.data?.inviteUrl) setInviteUrl(result.data.inviteUrl);
      setNotice(result.data?.message ?? "Changes saved.");
      await load(workspaceId);
      return true;
    } catch (cause) { setError(cause instanceof Error ? cause.message : "That action could not be completed."); return false; }
    finally { setBusy(""); }
  }

  async function invite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const role = inviteRole;
    const mailboxIds = role === "member" ? inviteMailboxIds : [];
    if (role === "member" && mailboxIds.length === 0) { setError("Select at least one mailbox for this member."); return; }
    const created = await act("invite", "/v1/team/invitations", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ workspaceId, email: form.get("email"), role, mailboxIds }) });
    if (created) { formElement.reset(); setInviteMailboxIds([]); setInviteRole("member"); }
  }

  async function copyLink() {
    try { await navigator.clipboard.writeText(inviteUrl); setNotice("Invitation link copied. Share it with the invited person."); }
    catch { setError("Could not access the clipboard. Select and copy the invitation link below."); }
  }

  async function transferOwnership() {
    const target = team?.members.find(member => member.userId === newOwnerId);
    if (!target || !await confirm({ title: "Transfer workspace ownership?", message: `Ownership will move to ${target.name}. Your role will become admin.`, confirmLabel: "Transfer ownership", destructive: true })) return;
    const transferred = await act("transfer-owner", "/v1/team/transfer-ownership", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ workspaceId, userId: target.userId }) });
    if (transferred) setNewOwnerId("");
  }

  async function removeMember(member: Member) {
    if (!await confirm({ title: "Remove this teammate?", message: `${member.name} will lose access to this workspace and its assigned mailboxes.`, confirmLabel: "Remove teammate", destructive: true })) return;
    await act(`remove-${member.userId}`, `/v1/team/members/${member.userId}?workspaceId=${encodeURIComponent(workspaceId)}`, { method: "DELETE" });
  }

  const canManage = team?.currentRole === "owner" || team?.currentRole === "admin";
  return <AppShell>
    <div className="page-heading"><div><h1>Team</h1><p>Invite people to share this workspace and decide what they can manage.</p></div></div>
    {inviteUrl && <section className="app-card team-link-card"><div><b>Your invitation link is ready</b><p>If the email does not arrive, share this link directly. It expires after 7 days.</p><code>{inviteUrl}</code></div><button className="button secondary" onClick={() => void copyLink()}><Copy size={15}/> Copy link</button></section>}
    {canManage && <section className="app-card team-invite-card"><div className="team-card-heading"><span className="onboard-icon"><UserRoundPlus size={18}/></span><div><h2 className="card-title">Invite a teammate</h2><p>They must create or use an account with the invited email address.</p></div></div>
      <form className="team-invite-form" onSubmit={invite}><div className="field"><label htmlFor="team-email">Email address</label><input id="team-email" name="email" type="email" placeholder="teammate@example.com" required/></div><div className="field"><label>Workspace role</label><StyledSelect ariaLabel="Workspace role" value={inviteRole} onValueChange={value => setInviteRole(value as "member" | "admin")} options={[{ value: "member", label: "Member", description: "Access assigned email addresses" }, ...(team?.currentRole === "owner" ? [{ value: "admin", label: "Admin", description: "Manage the full workspace" }] : [])]}/></div>{inviteRole === "member" && <div className="field team-mailbox-picker"><label>Mailboxes this member can use</label><MailboxCheckboxes label="Mailboxes this member can use" boxes={team?.availableMailboxes ?? []} selected={inviteMailboxIds} onChange={setInviteMailboxIds}/><small>Select each address they need. Members can switch between assigned mailboxes.</small></div>}<button className="button" disabled={!!busy || (inviteRole === "member" && !team?.availableMailboxes.length)}><MailPlus size={15}/>{busy === "invite" ? "Sending invite…" : "Send invitation"}</button></form>
      <p className="team-footnote"><ShieldCheck size={14}/> Invitation links expire after 7 days. Admins can manage members; only the owner can appoint admins.</p></section>}
    <section className="app-card team-list-card"><div className="card-heading-row"><div><h2 className="card-title">Workspace members</h2></div><span className="coming-badge">{team?.members.length ?? 0} {team?.members.length === 1 ? "person" : "people"}</span></div>
      {loading ? <div className="empty">Loading team…</div> : !team?.members.length ? <div className="empty">No members found for this workspace.</div> : <div className="team-table-wrap"><table className="team-table"><thead><tr><th>Person</th><th>Role</th><th>Joined</th><th>Mailbox access</th><th>Actions</th></tr></thead><tbody>{team.members.map((member) => <tr key={member.userId}><td><b>{member.name}</b><small>{member.email}{!member.emailVerified && " · email not verified"}</small></td><td><span className={`team-role role-${member.role}`}>{member.role}</span></td><td>{date(member.joinedAt)}</td><td>{member.role === "member" ? <div className="team-member-mailboxes"><MailboxCheckboxes label={`Mailboxes for ${member.name}`} boxes={team.availableMailboxes} selected={mailboxDrafts[member.userId] ?? []} onChange={ids => setMailboxDrafts(current => ({ ...current, [member.userId]: ids }))}/></div> : <span className="team-muted">All workspace mailboxes</span>}</td><td>{canManage && member.role !== "owner" && member.userId !== team.currentUserId ? <div className="team-actions">{member.role === "member" && <button className="button secondary team-small-button" disabled={!!busy} onClick={() => void act(`mailboxes-${member.userId}`, `/v1/team/members/${member.userId}/mailboxes?workspaceId=${encodeURIComponent(workspaceId)}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mailboxIds: mailboxDrafts[member.userId] ?? [] }) })}>Save access</button>}{team.currentRole === "owner" && <StyledSelect className="team-member-role-select" density="compact" ariaLabel={`Role for ${member.name}`} value={member.role} disabled={!!busy} onValueChange={role => void act(`role-${member.userId}`, `/v1/team/members/${member.userId}?workspaceId=${encodeURIComponent(workspaceId)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ role }) })} options={[{ value: "member", label: "Member" }, { value: "admin", label: "Admin" }]}/>}<button className="icon-button danger" aria-label={`Remove ${member.name}`} disabled={!!busy} onClick={() => void removeMember(member)}><Trash2 size={15}/></button></div> : <span className="team-muted">—</span>}</td></tr>)}</tbody></table></div>}
    </section>
    {team?.currentRole === "owner" && <section className="app-card team-list-card team-transfer-card"><div><h2 className="card-title">Transfer workspace ownership</h2><p>Choose an existing teammate. You will become an admin.</p></div><div className="team-transfer-controls"><StyledSelect ariaLabel="New workspace owner" value={newOwnerId} placeholder="Choose a teammate" onValueChange={setNewOwnerId} options={team.members.filter(member => member.userId !== team.currentUserId).map(member => ({ value: member.userId, label: member.name, description: member.role }))}/><button className="button secondary" disabled={!newOwnerId || !!busy} onClick={() => void transferOwnership()}>Transfer ownership</button></div></section>}
    {(error || notice) && <div className="team-feedback-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) { setError(""); setNotice(""); } }}><section className={`team-feedback-modal${error ? " is-error" : ""}`} role="alertdialog" aria-modal="true" aria-labelledby="team-feedback-title"><button className="icon-button team-feedback-close" type="button" aria-label="Close message" onClick={() => { setError(""); setNotice(""); }}><X size={16}/></button><span className="team-feedback-icon">{error ? <X size={18}/> : <Check size={18}/>}</span><h2 id="team-feedback-title">{error ? "Action needs attention" : "All set"}</h2><p>{error || notice}</p><button className="button" type="button" onClick={() => { setError(""); setNotice(""); }}>Continue</button></section></div>}
    {confirmDialog}
  </AppShell>;
}
