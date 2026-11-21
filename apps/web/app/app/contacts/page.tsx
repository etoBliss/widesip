"use client";

import type { FormEvent } from "react";
import { useEffect, useState } from "react";
import { Check, Copy, ExternalLink, Link2, Pencil, RefreshCw, Search, Trash2, UserCheck, UserPlus, UserRound, UserX, X } from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { useConfirmDialog } from "@/components/confirm-dialog";

const api = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
type Contact = { id: string; email: string; firstName: string | null; lastName: string | null; company: string | null; consentStatus: "unknown" | "subscribed" | "unsubscribed"; consentSource: string | null; consentAt: string | null; unsubscribedAt: string | null; createdAt: string };
type Result<T> = { success: boolean; data?: T; error?: { message?: string } };

export default function ContactsPage() {
  const { confirm, dialog: confirmDialog } = useConfirmDialog();
  const [workspaceId, setWorkspaceId] = useState("");
  const [canManageSignup, setCanManageSignup] = useState(false);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [unsubscribing, setUnsubscribing] = useState<string | null>(null);
  const [editing, setEditing] = useState<Contact | null>(null);
  const [updating, setUpdating] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [addContactOpen, setAddContactOpen] = useState(false);
  const [signupOpen, setSignupOpen] = useState(false);
  const [signupUrl, setSignupUrl] = useState("");
  const [signupLoading, setSignupLoading] = useState(true);
  const [signupBusy, setSignupBusy] = useState(false);
  const [signupCopied, setSignupCopied] = useState(false);
  const [signupEmbedCopied, setSignupEmbedCopied] = useState(false);
  const [signupError, setSignupError] = useState("");
  const signupEmbedCode = (() => {
    if (!signupUrl) return "";
    try {
      const parsed = new URL(signupUrl);
      const token = parsed.pathname.split("/").at(-1);
      if (!token) return "";
      return `<script async src="${parsed.origin}/v1/subscribe-widget/${token}.js" data-label="Subscribe to our newsletter"></script>`;
    } catch { return ""; }
  })();

  async function load(workspace: string, term: string) {
    const query = new URLSearchParams({ workspaceId: workspace });
    if (term.trim()) query.set("search", term.trim());
    const response = await fetch(`${api}/v1/contacts?${query}`, { credentials: "include" });
    const result = await response.json() as Result<Contact[]>;
    if (!response.ok) throw new Error(result.error?.message ?? "Could not load contacts.");
    setContacts(result.data ?? []);
  }

  useEffect(() => { setWorkspaceId(localStorage.getItem("widesip.workspace") ?? ""); }, []);
  useEffect(() => {
    if (!workspaceId) { setSignupLoading(false); return; }
    let active = true;
    void (async () => {
      try {
        const workspacesResponse = await fetch(`${api}/v1/workspaces`, { credentials: "include" });
        const workspacesResult = await workspacesResponse.json() as Result<Array<{ id: string; role: string }>>;
        const role = workspacesResult.data?.find(row => row.id === workspaceId)?.role;
        if (!active) return;
        setCanManageSignup(role === "owner" || role === "admin");
        if (role !== "owner" && role !== "admin") return;
        const response = await fetch(`${api}/v1/workspaces/${encodeURIComponent(workspaceId)}/subscription-link`, { credentials: "include" });
        const result = await response.json() as Result<{ url: string }>;
        if (!response.ok || !result.data) throw new Error(result.error?.message ?? "Could not load the contact collection link.");
        if (active) setSignupUrl(result.data.url);
      } catch (cause) { if (active) setSignupError(cause instanceof Error ? cause.message : "Could not load the contact collection link."); }
      finally { if (active) setSignupLoading(false); }
    })();
    return () => { active = false; };
  }, [workspaceId]);

  async function regenerateSignupLink() {
    if (signupUrl && !await confirm({ title: "Replace contact collection link?", message: "The current link will stop working. Update it anywhere you have shared or embedded it.", confirmLabel: "Replace link", destructive: true })) return;
    setSignupBusy(true); setSignupError(""); setSignupCopied(false);
    try {
      const response = await fetch(`${api}/v1/workspaces/${encodeURIComponent(workspaceId)}/subscription-link/regenerate`, { method: "POST", credentials: "include" });
      const result = await response.json() as Result<{ url: string }>;
      if (!response.ok || !result.data) throw new Error(result.error?.message ?? "Could not create the contact collection link.");
      setSignupUrl(result.data.url);
    } catch (cause) { setSignupError(cause instanceof Error ? cause.message : "Could not create the contact collection link."); }
    finally { setSignupBusy(false); }
  }

  async function copySignupLink() {
    if (!signupUrl) return;
    try { await navigator.clipboard.writeText(signupUrl); }
    catch { const input = document.querySelector<HTMLInputElement>("#contact-signup-url"); input?.select(); document.execCommand("copy"); }
    setSignupCopied(true); window.setTimeout(() => setSignupCopied(false), 2200);
  }
  async function copySignupEmbedCode() {
    if (!signupEmbedCode) return;
    try { await navigator.clipboard.writeText(signupEmbedCode); }
    catch { const input = document.querySelector<HTMLTextAreaElement>("#contact-signup-embed"); input?.select(); document.execCommand("copy"); }
    setSignupEmbedCopied(true); window.setTimeout(() => setSignupEmbedCopied(false), 2200);
  }
  useEffect(() => {
    if (!workspaceId) { setLoading(false); return; }
    setLoading(true);
    const timer = setTimeout(() => {
      void load(workspaceId, search).catch((cause) => setError(cause instanceof Error ? cause.message : "Could not load contacts."))
        .finally(() => setLoading(false));
    }, search ? 220 : 0);
    return () => clearTimeout(timer);
  }, [workspaceId, search]);

  useEffect(() => {
    if (!workspaceId) return;
    let active = true;
    const update = () => {
      if (active && document.visibilityState === "visible") {
        void load(workspaceId, search).catch(cause => { if (active) setError(cause instanceof Error ? cause.message : "Could not update contacts."); });
      }
    };
    const timer = window.setInterval(update, 15_000);
    window.addEventListener("focus", update);
    return () => { active = false; window.clearInterval(timer); window.removeEventListener("focus", update); };
  }, [workspaceId, search]);

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setSaving(true); setError(""); setNotice("");
    const form = event.currentTarget;
    const values = new FormData(form);
    const hasConsent = values.get("marketingConsent") === "yes";
    try {
      const response = await fetch(`${api}/v1/contacts`, {
        method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspaceId, email: values.get("email"), firstName: values.get("firstName"),
          lastName: values.get("lastName"), company: values.get("company"),
          consentStatus: hasConsent ? "subscribed" : "unknown",
          ...(hasConsent ? { consentSource: "manual_confirmation" } : {}),
        }),
      });
      const result = await response.json() as Result<Contact>;
      if (!response.ok || !result.data) throw new Error(result.error?.message ?? "Could not add this contact.");
      form.reset();
      setNotice(`${result.data.email} was added${hasConsent ? " with recorded opt-in" : " without marketing consent"}.`);
      setAddContactOpen(false);
      await load(workspaceId, search);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not add this contact."); }
    finally { setSaving(false); }
  }

  async function recordOptIn(contact: Contact) {
    const prompt = contact.consentStatus === "unsubscribed"
      ? "Has this person explicitly opted in again since unsubscribing? Record their new permission only if they have."
      : "Record that this person explicitly agreed to receive marketing emails? Only do this if they have given permission.";
    if (!await confirm({ title: "Record marketing permission", message: prompt, confirmLabel: "Record permission" })) return;
    setUnsubscribing(contact.id); setError(""); setNotice("");
    try {
      const response = await fetch(api + "/v1/contacts/" + contact.id + "/consent", { method: "PATCH", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ consentSource: "manual_confirmation" }) });
      const result = await response.json() as Result<Contact>;
      if (!response.ok || !result.data) throw new Error(result.error?.message ?? "Could not record permission.");
      setContacts(current => current.map(row => row.id === contact.id ? result.data! : row));
      setNotice(contact.email + " is opted in and will be included in campaigns.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not record permission."); }
    finally { setUnsubscribing(null); }
  }

  async function unsubscribe(contact: Contact) {
    if (!await confirm({ title: "Unsubscribe this contact?", message: `${contact.email} will be excluded from future marketing sends.`, confirmLabel: "Unsubscribe", destructive: true })) return;
    setUnsubscribing(contact.id); setError(""); setNotice("");
    try {
      const response = await fetch(`${api}/v1/contacts/${contact.id}/unsubscribe`, { method: "PATCH", credentials: "include" });
      const result = await response.json() as Result<Contact>;
      if (!response.ok || !result.data) throw new Error(result.error?.message ?? "Could not update this contact.");
      setContacts((current) => current.map((row) => row.id === contact.id ? result.data! : row));
      setNotice(`${contact.email} is marked unsubscribed.`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not update this contact."); }
    finally { setUnsubscribing(null); }
  }

  async function deleteContact(contact: Contact) {
    if (!await confirm({ title: "Delete this contact?", message: `${contact.email} will be permanently removed from this workspace.`, confirmLabel: "Delete contact", destructive: true })) return;
    setUnsubscribing(contact.id); setError(""); setNotice("");
    try {
      const response = await fetch(`${api}/v1/contacts/${contact.id}`, { method: "DELETE", credentials: "include" });
      const result = await response.json() as Result<unknown>;
      if (!response.ok) throw new Error(result.error?.message ?? "Could not delete this contact.");
      setContacts((current) => current.filter((row) => row.id !== contact.id));
      setEditing(null);
      setNotice(`${contact.email} was permanently removed from this workspace.`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not delete this contact."); }
    finally { setUnsubscribing(null); }
  }

  async function saveEdit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editing) return;
    setUpdating(true); setError(""); setNotice("");
    const values = new FormData(event.currentTarget);
    try {
      const response = await fetch(`${api}/v1/contacts/${editing.id}`, {
        method: "PATCH", credentials: "include", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: values.get("email"), firstName: values.get("firstName"), lastName: values.get("lastName"), company: values.get("company") }),
      });
      const result = await response.json() as Result<Contact>;
      if (!response.ok || !result.data) throw new Error(result.error?.message ?? "Could not update this contact.");
      setContacts((current) => current.map((contact) => contact.id === editing.id ? result.data! : contact));
      setNotice(`${result.data.email} was updated. Its email permission status was left unchanged.`);
      setEditing(null);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not update this contact."); }
    finally { setUpdating(false); }
  }

  return <AppShell>
    <div className="page-heading contacts-page-heading"><div><h1>Contacts</h1><p>Manage the people and permissions in your audience.</p></div><div className="contacts-page-actions">{canManageSignup && <button className="button secondary" type="button" onClick={() => setSignupOpen(true)}><Link2 size={15}/>Signup form</button>}<button className="button" type="button" onClick={() => { setError(""); setAddContactOpen(true); }}><UserPlus size={15}/>Add contact</button></div></div>
    {error && !addContactOpen && !editing && <p className="auth-error" role="alert">{error}</p>}{notice && !addContactOpen && !editing && <p className="dns-message" role="status">{notice}</p>}
    <section className="app-card inbox-workspace contacts-directory"><div className="inbox-toolbar"><div className="inbox-title"><span className="onboard-icon"><UserRound size={18}/></span><div><h2>Contact directory</h2><p>Subscribers, customers, and people you work with.</p></div></div></div><div className="inbox-search-row"><label className="inbox-search"><Search size={15}/><input aria-label="Search contacts" type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search name, company, or email"/></label></div>
      {error && contacts.length === 0 ? <p className="empty" role="alert">{error}</p> : loading ? <div className="inbox-empty">Loading contacts…</div> : contacts.length ? <div className="table-wrap"><table className="table"><thead><tr><th>Contact</th><th>Company</th><th>Email permission</th><th>Added</th><th></th></tr></thead><tbody>{contacts.map((contact) => <tr key={contact.id}><td><b>{[contact.firstName, contact.lastName].filter(Boolean).join(" ") || "Unnamed contact"}</b><small style={{ display: "block" }}>{contact.email}</small></td><td>{contact.company || "—"}</td><td><span className={`badge ${contact.consentStatus === "subscribed" ? "verified" : ""}`}>{contact.consentStatus === "subscribed" ? "Opted in" : contact.consentStatus === "unsubscribed" ? "Unsubscribed" : "Unknown"}</span>{contact.consentSource && <small style={{ display: "block" }}>Source: {contact.consentSource.replaceAll("_", " ")}</small>}</td><td>{new Date(contact.createdAt).toLocaleDateString()}</td><td><div className="contacts-row-actions"><button className="button secondary" onClick={() => { setError(""); setEditing(contact); }}><Pencil size={14}/> Edit</button>{contact.consentStatus !== "subscribed" && <button className="button secondary" onClick={() => void recordOptIn(contact)} disabled={unsubscribing === contact.id}><UserCheck size={14}/>{unsubscribing === contact.id ? "Updating…" : "Record opt-in"}</button>}{contact.consentStatus !== "unsubscribed" && <button className="button secondary" onClick={() => void unsubscribe(contact)} disabled={unsubscribing === contact.id}><UserX size={14}/>{unsubscribing === contact.id ? "Updating…" : "Unsubscribe"}</button>}</div></td></tr>)}</tbody></table></div> : <div className="inbox-empty"><span><UserRound size={20}/></span><b>{search ? "No contacts match your search" : "No contacts yet"}</b><p>{search ? "Try another name, company, or email." : "Add a contact or share your contact collection form to build your audience."}</p><button className="button" type="button" onClick={() => setAddContactOpen(true)}><UserPlus size={14}/>Add contact</button></div>}
    </section>
    {(addContactOpen || editing) && <div className="contact-modal-layer" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget && !saving && !updating) { setAddContactOpen(false); setEditing(null); } }}><section className="contact-modal" role="dialog" aria-modal="true" aria-labelledby="contact-modal-title"><header><div><h2 id="contact-modal-title">{editing ? "Edit contact" : "Add a contact"}</h2><p>{editing ? "Editing leaves email permission unchanged." : "Permission is optional to record here; campaigns only include opted-in contacts."}</p></div><button className="icon-button" type="button" aria-label="Close dialog" onClick={() => { setAddContactOpen(false); setEditing(null); }} disabled={saving || updating}><X size={17}/></button></header>
      {error && <p className="auth-error" role="alert">{error}</p>}{notice && <p className="dns-message" role="status">{notice}</p>}
      {editing ? <form onSubmit={saveEdit}><div className="field"><label htmlFor="edit-contact-email">Email address</label><input id="edit-contact-email" name="email" type="email" required maxLength={254} defaultValue={editing.email}/></div><div className="contact-modal-fields"><div className="field"><label htmlFor="edit-contact-first">First name</label><input id="edit-contact-first" name="firstName" maxLength={100} defaultValue={editing.firstName ?? ""}/></div><div className="field"><label htmlFor="edit-contact-last">Last name</label><input id="edit-contact-last" name="lastName" maxLength={100} defaultValue={editing.lastName ?? ""}/></div></div><div className="field"><label htmlFor="edit-contact-company">Company</label><input id="edit-contact-company" name="company" maxLength={160} defaultValue={editing.company ?? ""}/></div><div className="contact-modal-footer"><button className="button danger-button" type="button" disabled={unsubscribing === editing.id} onClick={() => void deleteContact(editing)}><Trash2 size={14}/>Delete</button><span/><button className="button secondary" type="button" onClick={() => setEditing(null)}>Cancel</button><button className="button" disabled={updating}>{updating ? "Saving…" : "Save changes"}</button></div></form> : <form onSubmit={create}><div className="field"><label htmlFor="contact-email">Email address</label><input id="contact-email" name="email" type="email" required maxLength={254} placeholder="person@example.com" autoFocus/></div><div className="contact-modal-fields"><div className="field"><label htmlFor="contact-first-name">First name</label><input id="contact-first-name" name="firstName" maxLength={100}/></div><div className="field"><label htmlFor="contact-last-name">Last name</label><input id="contact-last-name" name="lastName" maxLength={100}/></div></div><div className="field"><label htmlFor="contact-company">Company <span className="field-optional">Optional</span></label><input id="contact-company" name="company" maxLength={160}/></div><label className="contact-consent-check"><input name="marketingConsent" type="checkbox" value="yes"/><span><b>They agreed to receive marketing emails</b><small>Leave unchecked if you do not have their permission. You can add them as a contact without opting them in.</small></span></label><div className="contact-modal-footer"><span/><button className="button secondary" type="button" onClick={() => setAddContactOpen(false)}>Cancel</button><button className="button" disabled={saving || !workspaceId}><UserPlus size={14}/>{saving ? "Adding…" : "Add contact"}</button></div></form>}</section></div>}
    {signupOpen && <div className="contact-modal-layer" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) setSignupOpen(false); }}><section className="contact-modal signup-modal" role="dialog" aria-modal="true" aria-labelledby="signup-modal-title"><header><div><h2 id="signup-modal-title">Collect contacts from your website</h2><p>Share the form link or embed a pop-up so visitors can join this organization’s contact list.</p></div><button className="icon-button" type="button" aria-label="Close dialog" onClick={() => setSignupOpen(false)}><X size={17}/></button></header>
      {signupLoading ? <div className="inbox-empty"><RefreshCw size={16} className="mail-spinner"/>Preparing your link…</div> : signupUrl ? <><label className="field"><span>Public contact collection link</span><div className="contact-signup-url-row"><input id="contact-signup-url" value={signupUrl} readOnly aria-label="Public contact collection form link"/><button className="button" type="button" onClick={() => void copySignupLink()}>{signupCopied ? <Check size={15}/> : <Copy size={15}/>} {signupCopied ? "Copied" : "Copy link"}</button></div></label><div className="contact-signup-actions"><a href={signupUrl} target="_blank" rel="noreferrer"><ExternalLink size={13}/>Preview contact form</a><button type="button" onClick={() => void regenerateSignupLink()} disabled={signupBusy}><RefreshCw size={13} className={signupBusy ? "mail-spinner" : undefined}/>{signupBusy ? "Creating…" : "Regenerate link"}</button></div><div className="contact-signup-embed"><div><b>Website pop-up</b><small>Paste this code on your portfolio or website. Visitors’ names and emails go directly to this organization’s Contacts.</small></div><textarea id="contact-signup-embed" value={signupEmbedCode} readOnly rows={2} aria-label="Website contact collection widget code"/><button className="button secondary" type="button" onClick={() => void copySignupEmbedCode()}>{signupEmbedCopied ? <Check size={14}/> : <Copy size={14}/>} {signupEmbedCopied ? "Code copied" : "Copy website code"}</button></div></> : <button className="button" type="button" onClick={() => void regenerateSignupLink()} disabled={signupBusy || !workspaceId}><Link2 size={15}/>{signupBusy ? "Creating…" : "Create contact collection link"}</button>}{signupError && <p className="auth-error" role="alert">{signupError}</p>}<small className="contact-signup-hint">For local testing, the link uses your active HTTPS tunnel. If its address changes, update <code>WIDESIP_PUBLIC_URL</code> in the root <code>.env</code>, restart the API, then copy the updated code.</small></section></div>}
    {confirmDialog}
  </AppShell>;
}
