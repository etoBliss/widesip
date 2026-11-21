"use client";

import type { FormEvent } from "react";
import { useEffect, useState } from "react";
import { ArrowRight, AtSign, Plus, Trash2 } from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { useConfirmDialog } from "@/components/confirm-dialog";
import { StyledSelect } from "@/components/styled-select";

const api = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
type Domain = { id: string; domainName: string; verificationStatus: string };
type Mailbox = { id: string; domainId: string; address: string; displayName: string };
type EmailAlias = { id: string; address: string; mailboxId: string; mailboxAddress: string; status: string; createdAt: string };
type Result<T> = { success: boolean; data?: T; error?: { message?: string } };

export default function AliasesPage() {
  const { confirm, dialog: confirmDialog } = useConfirmDialog();
  const [workspaceId, setWorkspaceId] = useState("");
  const [domains, setDomains] = useState<Domain[]>([]);
  const [mailboxes, setMailboxes] = useState<Mailbox[]>([]);
  const [aliases, setAliases] = useState<EmailAlias[]>([]);
  const [domainId, setDomainId] = useState("");
  const [mailboxId, setMailboxId] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  async function load(workspace = workspaceId) {
    if (!workspace) return;
    const [domainResponse, mailboxResponse, aliasResponse] = await Promise.all([
      fetch(`${api}/v1/domains?workspaceId=${encodeURIComponent(workspace)}`, { credentials: "include" }),
      fetch(`${api}/v1/mailboxes?workspaceId=${encodeURIComponent(workspace)}`, { credentials: "include" }),
      fetch(`${api}/v1/aliases?workspaceId=${encodeURIComponent(workspace)}`, { credentials: "include" }),
    ]);
    const [domainResult, mailboxResult, aliasResult] = await Promise.all([
      domainResponse.json() as Promise<Result<Domain[]>>,
      mailboxResponse.json() as Promise<Result<Mailbox[]>>,
      aliasResponse.json() as Promise<Result<EmailAlias[]>>,
    ]);
    if (!domainResponse.ok) throw new Error(domainResult.error?.message ?? "Could not load domains.");
    if (!mailboxResponse.ok) throw new Error(mailboxResult.error?.message ?? "Could not load mailboxes.");
    if (!aliasResponse.ok) throw new Error(aliasResult.error?.message ?? "Could not load aliases.");
    setDomains(domainResult.data ?? []);
    setMailboxes(mailboxResult.data ?? []);
    setAliases(aliasResult.data ?? []);
    const verified = (domainResult.data ?? []).filter((domain) => domain.verificationStatus === "verified");
    setDomainId((current) => verified.some((domain) => domain.id === current) ? current : verified[0]?.id ?? "");
  }

  useEffect(() => {
    const workspace = localStorage.getItem("widesip.workspace") ?? "";
    setWorkspaceId(workspace);
    if (!workspace) { setLoading(false); return; }
    void load(workspace).catch((cause) => setError(cause instanceof Error ? cause.message : "Could not load aliases."))
      .finally(() => setLoading(false));
  }, []);

  const verifiedDomains = domains.filter((domain) => domain.verificationStatus === "verified");
  const domainMailboxes = mailboxes.filter((mailbox) => mailbox.domainId === domainId);

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError(""); setNotice("");
    const form = event.currentTarget;
    const localPart = String(new FormData(form).get("localPart") ?? "");
    try {
      const response = await fetch(`${api}/v1/aliases`, {
        method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceId, domainId, mailboxId, localPart }),
      });
      const result = await response.json() as Result<EmailAlias>;
      if (!response.ok || !result.data) throw new Error(result.error?.message ?? "Could not create this alias.");
      form.reset();
      setNotice(`${result.data.address} will deliver into ${result.data.mailboxAddress}.`);
      await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not create this alias."); }
    finally { setBusy(false); }
  }

  async function remove(alias: EmailAlias) {
    if (!await confirm({ title: "Remove this alias?", message: `New messages to ${alias.address} will no longer be routed to its mailbox.`, confirmLabel: "Remove alias", destructive: true })) return;
    setDeleting(alias.id); setError(""); setNotice("");
    try {
      const response = await fetch(`${api}/v1/aliases/${alias.id}`, { method: "DELETE", credentials: "include" });
      const result = await response.json() as Result<unknown>;
      if (!response.ok) throw new Error(result.error?.message ?? "Could not remove this alias.");
      setAliases((current) => current.filter((item) => item.id !== alias.id));
      setNotice(`${alias.address} was removed.`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not remove this alias."); }
    finally { setDeleting(null); }
  }

  return <AppShell>
    <div className="page-heading"><div><h1>Aliases</h1><p>Give one mailbox more ways to be reached.</p></div></div>
    <div className="mailbox-layout">
      <section className="app-card mailbox-create-card">
        <div className="mailbox-title"><span className="onboard-icon"><AtSign size={18}/></span><div><h2>Create an alias</h2><p>For example, support@yourdomain.com can deliver into your existing inbox.</p></div></div>
        {verifiedDomains.length > 0 && domainMailboxes.length > 0 ? <form onSubmit={create}>
          <div className="field"><label htmlFor="alias-local-part">Alias address</label><div className="mailbox-address-input"><input id="alias-local-part" name="localPart" placeholder="support" required maxLength={64} pattern="[A-Za-z0-9](?:[A-Za-z0-9._+-]*[A-Za-z0-9])?"/><span>@</span><StyledSelect className="mailbox-inline-select" ariaLabel="Alias domain" value={domainId} onValueChange={nextDomainId => { setDomainId(nextDomainId); setMailboxId(""); }} options={verifiedDomains.map(domain => ({ value: domain.id, label: domain.domainName }))} required/></div></div>
          <div className="field"><label>Deliver into mailbox</label><StyledSelect id="alias-target" ariaLabel="Deliver into mailbox" value={mailboxId} onValueChange={setMailboxId} options={domainMailboxes.map(mailbox => ({ value: mailbox.id, label: `${mailbox.displayName} — ${mailbox.address}` }))} placeholder="Choose a mailbox" required/><span className="field-help">Aliases share the destination mailbox’s inbox. They don’t create another separate inbox.</span></div>
          {error && <p className="auth-error" role="alert">{error}</p>}{notice && <p className="dns-message" role="status">{notice}</p>}
          <button className="button" disabled={busy || !mailboxId}><Plus size={15}/>{busy ? "Creating..." : "Create alias"}</button>
        </form> : <div className="empty">{domains.length === 0 ? <>Add a domain first. <a href="/app/domains/new">Add a domain <ArrowRight size={13}/></a></> : mailboxes.length === 0 ? <>Create a mailbox to receive alias messages. <a href="/app/mailboxes">Go to mailboxes <ArrowRight size={13}/></a></> : <>Verify a domain and create a mailbox on it before adding aliases. <a href="/app/domains">Review domains <ArrowRight size={13}/></a></>}</div>}
      </section>
      <aside className="app-card mailbox-guide"><span className="onboard-icon"><AtSign size={18}/></span><h2>One inbox, many addresses</h2><p>Create as many routing addresses as your current account allows, for example:</p><ul><li><code>support@yourdomain.com</code></li><li><code>billing@yourdomain.com</code></li><li><code>hello@yourdomain.com</code></li></ul><p>Each alias delivers to the mailbox you choose. Incoming routing works after the domain’s receiving DNS and Widesip webhook are connected.</p></aside>
    </div>
    <section className="app-card mailbox-list-card"><div className="card-heading-row"><div><h2 className="card-title">Aliases</h2></div><span className="coming-badge">{aliases.length} {aliases.length === 1 ? "alias" : "aliases"}</span></div>
      {error && !verifiedDomains.length ? <p className="empty" role="alert">{error}</p> : loading ? <div className="empty">Loading aliases...</div> : aliases.length ? <div className="table-wrap"><table className="table"><thead><tr><th>Alias</th><th>Delivers into</th><th>Status</th><th>Created</th><th></th></tr></thead><tbody>{aliases.map((alias) => <tr key={alias.id}><td>{alias.address}</td><td>{alias.mailboxAddress}</td><td><span className={alias.status === "active" ? "badge verified" : "badge"}>{alias.status}</span></td><td>{new Date(alias.createdAt).toLocaleDateString()}</td><td><button className="button secondary" onClick={() => void remove(alias)} disabled={deleting === alias.id} aria-label={`Remove ${alias.address}`}><Trash2 size={14}/>{deleting === alias.id ? "Removing..." : "Remove"}</button></td></tr>)}</tbody></table></div> : <div className="empty">No aliases yet. Create one above to route another address into a mailbox.</div>}
    </section>
    {confirmDialog}
  </AppShell>;
}
