"use client";

import type { FormEvent } from "react";
import { useEffect, useState } from "react";
import { ArrowRight, Mail, Plus, ShieldCheck } from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { StyledSelect } from "@/components/styled-select";

const api = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
type Domain = { id: string; domainName: string; verificationStatus: string };
type Mailbox = { id: string; address: string; displayName: string; profileImage: string | null; domainProfileImage: string | null; forwardingAddress: string | null; status: string; mailStatus: string; createdAt: string };
type Result<T> = { success: boolean; data?: T; error?: { message?: string } };

export default function MailboxesPage() {
  const [domains, setDomains] = useState<Domain[]>([]);
  const [mailboxes, setMailboxes] = useState<Mailbox[]>([]);
  const [workspaceId, setWorkspaceId] = useState("");
  const [canManage, setCanManage] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [testBusyId, setTestBusyId] = useState<string | null>(null);
  const [photoBusyId, setPhotoBusyId] = useState<string | null>(null);
  const [testMessages, setTestMessages] = useState<Record<string, string>>({});

  async function load() {
    const workspace = localStorage.getItem("widesip.workspace") ?? "";
    setWorkspaceId(workspace);
    if (!workspace) return;
    const workspacesResponse = await fetch(`${api}/v1/workspaces`, { credentials: "include" });
    const workspaceResult = await workspacesResponse.json() as Result<{ id: string; role: string }[]>;
    const role = workspaceResult.data?.find(row => row.id === workspace)?.role;
    const manageable = role === "owner" || role === "admin";
    setCanManage(manageable);
    const requests = [fetch(`${api}/v1/mailboxes?workspaceId=${encodeURIComponent(workspace)}`, { credentials: "include" })];
    if (manageable) requests.unshift(fetch(`${api}/v1/domains?workspaceId=${encodeURIComponent(workspace)}`, { credentials: "include" }));
    const responses = await Promise.all(requests);
    const domainResponse = manageable ? responses[0] : null;
    const mailboxResponse = responses[manageable ? 1 : 0];
    const domainResult = domainResponse ? await domainResponse.json() as Result<Domain[]> : { success: true, data: [] };
    const mailboxResult = await mailboxResponse.json() as Result<Mailbox[]>;
    if (domainResponse && !domainResponse.ok) throw new Error(domainResult.error?.message ?? "Could not load domains.");
    if (!mailboxResponse.ok) throw new Error(mailboxResult.error?.message ?? "Could not load mailboxes.");
    setDomains(domainResult.data ?? []);
    setMailboxes(mailboxResult.data ?? []);
  }

  useEffect(() => { void load().catch((cause) => setError(cause instanceof Error ? cause.message : "Could not load mailboxes.")).finally(() => setLoading(false)); }, []);

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError(""); setNotice("");
    const form = event.currentTarget;
    const data = new FormData(form);
    try {
      const response = await fetch(`${api}/v1/mailboxes`, {
        method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceId, domainId: data.get("domainId"), localPart: data.get("localPart"), displayName: data.get("displayName"), forwardingAddress: data.get("forwardingAddress") }),
      });
      const result = await response.json() as Result<Mailbox>;
      if (!response.ok || !result.data) throw new Error(result.error?.message ?? "Could not create this address.");
      form.reset();
      setNotice(`${result.data.address} has been added. Incoming mail appears in Widesip when this domain's receiving DNS and webhook are connected; outbound sending needs domain setup.`);
      await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not create this address."); }
    finally { setBusy(false); }
  }

  async function sendTest(mailbox: Mailbox, event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setTestBusyId(mailbox.id);
    const form = event.currentTarget;
    const recipient = String(new FormData(form).get("recipient") ?? "");
    setTestMessages((current) => ({ ...current, [mailbox.id]: "Sending test…" }));
    try {
      const response = await fetch(`${api}/v1/mailboxes/${mailbox.id}/send-test`, {
        method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ recipient }),
      });
      const result = await response.json() as Result<{ message: string }>;
      if (!response.ok) throw new Error(result.error?.message ?? "The test email could not be sent.");
      setTestMessages((current) => ({ ...current, [mailbox.id]: result.data?.message ?? "Widesip accepted the test message." }));
    } catch (cause) {
      setTestMessages((current) => ({ ...current, [mailbox.id]: cause instanceof Error ? cause.message : "The test email could not be sent." }));
    } finally { setTestBusyId(null); }
  }

  async function updateMailboxPhoto(mailbox: Mailbox, file?: File, resetToDomain = false) {
    if (!file && !resetToDomain) return;
    if (file && (!/^image\/(png|jpeg|webp)$/.test(file.type) || file.size > 1_000_000)) { setError("Choose a PNG, JPG, or WebP image smaller than 1 MB."); return; }
    setPhotoBusyId(mailbox.id); setError(""); setNotice("");
    try {
      const image = resetToDomain ? null : await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onerror = () => reject(new Error("Could not read that image.")); reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("Could not read that image.")); reader.readAsDataURL(file!); });
      const response = await fetch(`${api}/v1/mailboxes/${mailbox.id}/profile`, { method: "PATCH", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ profileImage: image }) });
      const result = await response.json() as Result<{ profileImage: string | null; message: string }>;
      if (!response.ok || !result.data) throw new Error(result.error?.message ?? "Could not update this address photo.");
      setMailboxes(current => current.map(row => row.id === mailbox.id ? { ...row, profileImage: result.data!.profileImage } : row)); setNotice(result.data.message);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not update this address photo."); }
    finally { setPhotoBusyId(null); }
  }

  const verifiedDomains = domains.filter((domain) => domain.verificationStatus === "verified");
  return <AppShell>
    <div className="page-heading"><div><h1>Mailboxes</h1><p>Create a custom email address on a verified domain.</p><p className="mailbox-photo-note">Set a photo for each address here. It appears in Widesip and its Sent items. Gmail chooses sender avatars independently; a brand logo there requires domain-wide BIMI setup.</p></div></div>
    {loading ? <section className="app-card"><div className="app-loading"><span className="loading-orbit"/>Loading addresses and domain access…</div></section> : <>
    {canManage && <div className="mailbox-layout">
      <section className="app-card mailbox-create-card">
        <div className="mailbox-title"><span className="onboard-icon"><Mail size={18}/></span><div><h2>Create an address</h2><p>For example, hello@yourdomain.com</p></div></div>
        {verifiedDomains.length ? <form onSubmit={create}>
          <div className="field"><label htmlFor="mailbox-name">Display name</label><input id="mailbox-name" name="displayName" placeholder="Customer care" required maxLength={80}/></div>
          <div className="field"><label htmlFor="mailbox-local">Email address</label><div className="mailbox-address-input"><input id="mailbox-local" name="localPart" placeholder="hello" required maxLength={64} pattern="[A-Za-z0-9](?:[A-Za-z0-9._+-]*[A-Za-z0-9])?"/><span>@</span><StyledSelect name="domainId" ariaLabel="Domain" className="mailbox-inline-select" options={verifiedDomains.map(domain => ({ value: domain.id, label: domain.domainName }))} required/></div></div>
          <div className="field"><label htmlFor="mailbox-forward">Forward incoming mail to Gmail (optional)</label><input id="mailbox-forward" type="email" name="forwardingAddress" placeholder="you@gmail.com"/><span className="field-help">This will be applied after Cloudflare routing is connected. Existing forwarding rules stay as they are.</span></div>
          {error && <p className="auth-error" role="alert">{error}</p>}{notice && <p className="dns-message" role="status">{notice}</p>}
          <button className="button" disabled={busy}><Plus size={15}/>{busy ? "Creating…" : "Create address"}</button>
        </form> : <div className="empty mailbox-empty">{domains.length ? <>Verify a domain before creating an address. <a href="/app/domains">Go to domains <ArrowRight size={13}/></a></> : <>Add a domain to this workspace first. <a href="/app/domains/new">Add a domain <ArrowRight size={13}/></a></>}</div>}
      </section>
      <aside className="app-card mailbox-guide"><span className="onboard-icon"><ShieldCheck size={18}/></span><h2>Connect mail delivery</h2><p>Widesip manages its mail delivery service for you. You will not need a separate Resend account. Cloudflare connection will only be needed if you want Widesip to apply DNS records automatically.</p><ol><li>Verify the domain belongs to you.</li><li>Set up outbound sending from the Domains page.</li><li>Once inbound routing is configured, messages appear in the Widesip Inbox.</li></ol><p className="mailbox-honesty">This prototype still needs the Widesip server’s mail provider credentials and a public inbound webhook connection. Adding an address here does not create an IMAP mailbox for Outlook or Apple Mail.</p></aside>
    </div>}
    <section className="app-card mailbox-list-card"><div className="card-heading-row"><div><h2 className="card-title">Mailboxes in this workspace</h2></div><span className="coming-badge">{mailboxes.length} {mailboxes.length === 1 ? "address" : "addresses"}</span></div>
      {error && !verifiedDomains.length ? <p className="empty" role="alert">{error}</p> : mailboxes.length ? <div className="table-wrap"><table className="table"><thead><tr><th>Address</th>{canManage && <th>Profile image</th>}<th>Display name</th><th>Forwarding</th><th>Status</th>{canManage && <th>Send test</th>}</tr></thead><tbody>{mailboxes.map((box) => { const avatar = box.profileImage ?? box.domainProfileImage; return <tr key={box.id}><td><span className="mailbox-address-with-photo">{avatar ? <img src={avatar} alt=""/> : <span>{box.address.slice(0, 1).toUpperCase()}</span>}{box.address}</span></td>{canManage && <td><label className={`mailbox-photo-control${photoBusyId === box.id ? " busy" : ""}`}>{photoBusyId === box.id ? "Uploading…" : box.profileImage ? "Change override" : box.domainProfileImage ? "Override domain image" : "Add image"}<input type="file" accept="image/png,image/jpeg,image/webp" disabled={photoBusyId === box.id} onChange={event => { void updateMailboxPhoto(box, event.target.files?.[0]); event.currentTarget.value = ""; }}/></label>{box.profileImage && <button type="button" className="mailbox-photo-reset" disabled={photoBusyId === box.id} onClick={() => void updateMailboxPhoto(box, undefined, true)}>Use domain profile</button>}</td>}<td>{box.displayName}</td><td>{box.forwardingAddress ?? "—"}</td><td><span className={box.mailStatus === "active" ? "badge verified" : "badge"}>{box.mailStatus === "active" ? "Sending ready" : "Setup required"}</span></td>{canManage && <td><form className="mailbox-test-form" onSubmit={(event) => void sendTest(box, event)}><input type="email" name="recipient" aria-label={`Test recipient for ${box.address}`} placeholder="you@gmail.com" defaultValue={box.forwardingAddress ?? ""} required/><button className="button secondary" disabled={box.mailStatus !== "active" || testBusyId === box.id}>{testBusyId === box.id ? "Sending…" : "Send"}</button></form>{testMessages[box.id] && <small className="mailbox-test-status" role="status">{testMessages[box.id]}</small>}</td>}</tr>; })}</tbody></table></div> : <div className="empty">{canManage ? "No addresses yet. Create one above after verifying a domain." : "No addresses have been assigned to you yet. Ask your workspace owner or admin to grant access."}</div>}
    </section>
    </>}
  </AppShell>;
}
