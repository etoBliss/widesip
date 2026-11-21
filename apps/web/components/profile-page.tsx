"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { BadgeCheck, Camera, Check, Mail, Save, UserRound, X, Building2, ArrowLeftRight } from "lucide-react";

const api = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
type Account = { id: string; name: string; email: string; emailVerified: boolean; image: string | null; createdAt: string | null };
type Result<T> = { data?: T; message?: string; error?: { message?: string } };
type WorkspaceInfo = { id: string; name: string; type: "personal" | "organization"; role: "owner" | "admin" | "member" };

async function readResult<T>(response: Response): Promise<Result<T>> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    const hint = response.status === 404
      ? "The profile API endpoint was not found. Restart the API server and try again."
      : `The profile API returned a non-JSON response (HTTP ${response.status}). Check that the API is running at ${api}.`;
    throw new Error(hint);
  }
  return await response.json() as Result<T>;
}

function formatAccountDate(value: string | null | undefined): string {
  if (!value) return "recently";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "recently";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "long" }).format(date);
}

export function ProfilePage() {
  const [account, setAccount] = useState<Account | null>(null);
  const [name, setName] = useState("");
  const [image, setImage] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [photoBusy, setPhotoBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [workspace, setWorkspace] = useState<WorkspaceInfo | null>(null);
  const [organizationName, setOrganizationName] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let active = true;
    fetch(`${api}/v1/workspaces`, { credentials: "include" }).then(response => response.ok ? response.json() : null).then(result => {
      if (!active || !result?.data) return;
      const saved = localStorage.getItem("widesip.workspace");
      const current = (result.data as WorkspaceInfo[]).find(item => item.id === saved) ?? null;
      setWorkspace(current); if (current?.type === "organization") setOrganizationName(current.name);
    }).catch(() => undefined);
    fetch(`${api}/v1/account`, { credentials: "include" })
      .then(async response => {
        const result = await readResult<Account>(response);
        if (!response.ok || !result.data) throw new Error(result.error?.message ?? "Could not load your profile.");
        if (active) { setAccount(result.data); setName(result.data.name); setImage(result.data.image); }
      })
      .catch(cause => { if (active) setError(cause instanceof Error ? cause.message : "Could not load your profile."); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  async function saveProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setSaving(true); setError(""); setNotice("");
    try {
      const response = await fetch(`${api}/v1/account`, { method: "PATCH", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, image }) });
      const result = await readResult<Account>(response);
      if (!response.ok || !result.data) throw new Error(result.error?.message ?? "Could not save your profile.");
      setAccount(result.data); setName(result.data.name); setImage(result.data.image); setNotice(result.message ?? "Profile saved.");
      window.dispatchEvent(new CustomEvent("widesip:account-updated", { detail: result.data }));
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not save your profile."); }
    finally { setSaving(false); }
  }

  async function saveOrganization(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!workspace || workspace.role !== "owner") return;
    setSaving(true); setError(""); setNotice("");
    try {
      const response = await fetch(`${api}/v1/workspaces/${workspace.id}`, { method: "PATCH", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: organizationName }) });
      const result = await readResult<WorkspaceInfo>(response);
      if (!response.ok || !result.data) throw new Error(result.error?.message ?? "Could not update the organization profile.");
      const updated = { ...workspace, name: result.data.name };
      setWorkspace(updated); setOrganizationName(updated.name); setNotice("Organization profile saved.");
      window.dispatchEvent(new CustomEvent("widesip:workspace-updated", { detail: updated }));
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not update the organization profile."); }
    finally { setSaving(false); }
  }

  async function choosePhoto(file?: File) {
    if (!file) return;
    setError(""); setNotice("");
    if (!/^image\/(png|jpeg|webp)$/.test(file.type) || file.size > 1_000_000) {
      setError("Choose a PNG, JPG, or WebP image smaller than 1 MB.");
      if (fileInput.current) fileInput.current.value = "";
      return;
    }
    setPhotoBusy(true);
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error("Could not read that image."));
        reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("Could not read that image."));
        reader.readAsDataURL(file);
      });
      const response = await fetch(`${api}/v1/account`, { method: "PATCH", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: name || account?.name, image: dataUrl }) });
      const result = await readResult<Account>(response);
      if (!response.ok || !result.data) throw new Error(result.error?.message ?? "Could not upload your profile photo.");
      setAccount(result.data); setImage(result.data.image); setName(result.data.name); setNotice("Profile photo updated.");
      window.dispatchEvent(new CustomEvent("widesip:account-updated", { detail: result.data }));
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not upload your profile photo."); }
    finally { setPhotoBusy(false); if (fileInput.current) fileInput.current.value = ""; }
  }

  async function removePhoto() {
    setPhotoBusy(true); setError(""); setNotice("");
    try {
      const response = await fetch(`${api}/v1/account`, { method: "PATCH", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: name || account?.name, image: null }) });
      const result = await readResult<Account>(response);
      if (!response.ok || !result.data) throw new Error(result.error?.message ?? "Could not remove your profile photo.");
      setAccount(result.data); setImage(null); setNotice("Profile photo removed.");
      window.dispatchEvent(new CustomEvent("widesip:account-updated", { detail: result.data }));
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not remove your profile photo."); }
    finally { setPhotoBusy(false); }
  }

  const initials = (name || account?.email || "U").trim().slice(0, 1).toUpperCase();
  function openWorkspaceSwitcher() { window.dispatchEvent(new CustomEvent("widesip:open-account-menu")); }
  return <>
    <div className="page-heading"><div><h1>Profile</h1><p>{workspace?.type === "organization" ? "Your personal identity and this organization workspace." : "Manage the personal details people see in Widesip."}</p></div></div>
    {error && <p className="team-notice team-error" role="alert">{error}</p>}
    {notice && <p className="team-notice" role="status"><Check size={14}/>{notice}</p>}
    {workspace?.type === "organization" && <section className="app-card profile-card organization-profile-card"><div className="profile-workspace-card"><span className="profile-workspace-icon"><Building2 size={19}/></span><div className="profile-workspace-copy"><small>Organization profile</small><h2>{workspace.name}</h2><p>{workspace.role === "owner" ? "This profile belongs to your organization." : workspace.role === "admin" ? "Organization workspace profile." : "Organization mailbox workspace."}</p></div><span className={`profile-role-badge role-${workspace.role}`}>{workspace.role === "owner" ? "Owner" : workspace.role === "admin" ? "Admin" : "Member"}</span><button type="button" className="button secondary profile-switch-button" onClick={openWorkspaceSwitcher}><ArrowLeftRight size={14}/>Switch workspace</button></div>{workspace.role === "owner" ? <form className="settings-form profile-form" onSubmit={saveOrganization}><div className="settings-field"><label htmlFor="organization-profile-name">Organization name</label><input id="organization-profile-name" value={organizationName} onChange={event => setOrganizationName(event.target.value)} minLength={2} maxLength={80} required/></div><div className="settings-form-actions"><button className="button" disabled={saving || organizationName.trim().length < 2}><Save size={14}/>{saving ? "Saving…" : "Save organization profile"}</button></div></form> : <p className="profile-organization-note">Only the organization owner can change its profile.</p>}</section>}
    {loading ? <section className="app-card"><div className="app-loading"><span className="loading-orbit"/>Loading your profile…</div></section> : account && workspace?.type !== "organization" && <section className="app-card profile-card">
      <div className="profile-photo-area"><div className="profile-photo">{image ? <img src={image} alt="Your profile"/> : <span>{initials}</span>}{photoBusy && <span className="profile-photo-busy"><span className="loading-orbit"/></span>}</div><div className="profile-photo-actions"><b>Profile photo</b><small>Shown to you and your teammates. PNG, JPG, or WebP up to 1 MB.</small><div><button type="button" className="button secondary" disabled={photoBusy} onClick={() => fileInput.current?.click()}><Camera size={14}/>{photoBusy ? "Uploading…" : image ? "Change photo" : "Upload photo"}</button>{image && <button type="button" className="button secondary" disabled={photoBusy} onClick={() => void removePhoto()}><X size={14}/>Remove</button>}<input ref={fileInput} className="profile-file-input" type="file" accept="image/png,image/jpeg,image/webp" onChange={event => void choosePhoto(event.target.files?.[0])}/></div></div></div>
      <form className="settings-form profile-form" onSubmit={saveProfile}><div className="settings-field"><label htmlFor="profile-name">Full name</label><input id="profile-name" value={name} onChange={event => setName(event.target.value)} minLength={2} maxLength={80} required autoComplete="name"/></div>
        <div className="settings-field"><label htmlFor="profile-email">Email address</label><div className="settings-email-field"><Mail size={15}/><input id="profile-email" value={account.email} readOnly/><span className={`email-verification ${account.emailVerified ? "verified" : "pending"}`}>{account.emailVerified ? <><BadgeCheck size={13}/>Verified</> : "Not verified"}</span></div><small>Email address changes need an email verification flow. You can manage that once it is enabled.</small></div>
        <div className="profile-account-since"><UserRound size={15}/><span>Widesip account since {formatAccountDate(account.createdAt)}</span></div>
        <div className="settings-form-actions"><button className="button" disabled={saving || photoBusy || name.trim().length < 2}><Save size={14}/>{saving ? "Saving…" : "Save profile"}</button></div>
      </form>
    </section>}
  </>;
}
