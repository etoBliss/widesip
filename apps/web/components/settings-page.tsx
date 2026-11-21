"use client";

import { useEffect, useState, type FormEvent } from "react";
import { AlertTriangle, Check, ChevronRight, KeyRound, LockKeyhole, Monitor, ShieldCheck, Smartphone, Trash2 } from "lucide-react";

const api = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
type Workspace = { id: string; name: string; type: "personal" | "organization"; role: "owner" | "admin" | "member" };
type Result<T> = { data?: T; message?: string; error?: { message?: string }; code?: string };
type AccountSession = { id:string;createdAt:string;updatedAt:string;expiresAt:string;ipAddress:string|null;userAgent:string|null;current:boolean };

export function SettingsPage() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [loading, setLoading] = useState(true);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [changingPassword, setChangingPassword] = useState(false);
  const [passwordNotice, setPasswordNotice] = useState("");
  const [deletePassword, setDeletePassword] = useState("");
  const [deleteConfirmation, setDeleteConfirmation] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState("");
  const [activeSessions,setActiveSessions]=useState<AccountSession[]>([]);
  const [sessionsLoading,setSessionsLoading]=useState(true);
  const [sessionBusy,setSessionBusy]=useState("");
  const [sessionNotice,setSessionNotice]=useState("");

  useEffect(() => {
    let active = true;
    fetch(`${api}/v1/workspaces`, { credentials: "include" })
      .then(async response => {
        const result = await response.json() as Result<Workspace[]>;
        if (!response.ok || !result.data) throw new Error(result.error?.message ?? "Could not load account settings.");
        if (active) setWorkspaces(result.data);
      })
      .catch(cause => { if (active) setError(cause instanceof Error ? cause.message : "Could not load account settings."); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  async function loadSessions() {
    setSessionsLoading(true);
    try {
      const response=await fetch(`${api}/v1/security/sessions`,{credentials:"include",cache:"no-store"});
      const result=await response.json() as Result<AccountSession[]>;
      if(!response.ok || !result.data) throw new Error(result.error?.message??"Could not load active sessions.");
      setActiveSessions(result.data);
    } catch(cause) { setError(cause instanceof Error?cause.message:"Could not load active sessions."); }
    finally { setSessionsLoading(false); }
  }

  useEffect(()=>{void loadSessions();},[]);

  async function revokeSession(sessionId:string) {
    setError("");setSessionNotice("");setSessionBusy(sessionId);
    try {
      const response=await fetch(`${api}/v1/security/sessions/${encodeURIComponent(sessionId)}/revoke`,{method:"POST",credentials:"include"});
      const result=await response.json() as Result<unknown>;
      if(!response.ok)throw new Error(result.error?.message??"Could not sign out that device.");
      setSessionNotice("That session has been signed out.");await loadSessions();
    } catch(cause) { setError(cause instanceof Error?cause.message:"Could not sign out that device."); }
    finally { setSessionBusy(""); }
  }

  async function revokeOtherSessions() {
    setError("");setSessionNotice("");setSessionBusy("others");
    try {
      const response=await fetch(`${api}/v1/security/sessions/revoke-others`,{method:"POST",credentials:"include"});
      const result=await response.json() as Result<unknown>;
      if(!response.ok)throw new Error(result.error?.message??"Could not sign out other sessions.");
      setSessionNotice("All other active sessions have been signed out.");await loadSessions();
    } catch(cause) { setError(cause instanceof Error?cause.message:"Could not sign out other sessions."); }
    finally { setSessionBusy(""); }
  }

  async function changePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(""); setPasswordNotice("");
    if (newPassword.length < 12) { setError("Use at least 12 characters for your new password."); return; }
    if (newPassword !== confirmPassword) { setError("The new passwords do not match."); return; }
    setChangingPassword(true);
    try {
      const response = await fetch(`${api}/api/auth/change-password`, { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ currentPassword, newPassword, revokeOtherSessions: true }) });
      const result = await response.json() as Result<unknown>;
      if (!response.ok) throw new Error(result.error?.message ?? result.message ?? "Could not change your password.");
      setCurrentPassword(""); setNewPassword(""); setConfirmPassword(""); setPasswordNotice("Password updated. Other signed-in sessions were revoked.");await loadSessions();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not change your password."); }
    finally { setChangingPassword(false); }
  }

  async function deleteAccount(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError("");
    if (deleteConfirmation !== "DELETE") { setError("Type DELETE exactly to confirm account removal."); return; }
    setDeleting(true);
    try {
      const response = await fetch(`${api}/api/auth/delete-user`, { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...(deletePassword ? { password: deletePassword } : {}), callbackURL: "/sign-in" }) });
      const result = await response.json() as Result<unknown>;
      if (!response.ok) throw new Error(result.error?.message ?? result.message ?? "Could not delete your account.");
      localStorage.removeItem("widesip.workspace");
      window.location.assign("/sign-in?account-deleted=1");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not delete your account."); setDeleting(false); }
  }

  const ownedOrganizations = workspaces.filter(workspace => workspace.type === "organization" && workspace.role === "owner");
  if (loading) return <><div className="page-heading"><div><h1>Settings</h1><p>Protect your account and control access.</p></div></div><section className="app-card settings-loading"><span className="loading-orbit"/>Loading security settings…</section></>;

  return <>
    <div className="page-heading"><div><h1>Settings</h1><p>Manage your password, active access, and account deletion.</p></div></div>
    {error && <p className="team-notice team-error" role="alert">{error}</p>}

    <section className="settings-section app-card"><div className="settings-section-heading"><span className="settings-icon security"><KeyRound size={18}/></span><div><span className="usage-section-kicker">SIGN-IN</span><h2>Change password</h2><p>Choose a new password to secure your Widesip account.</p></div></div>
      <form className="security-password-form" onSubmit={changePassword}><div className="settings-field"><label htmlFor="current-password">Current password</label><input id="current-password" type="password" autoComplete="current-password" value={currentPassword} onChange={event => setCurrentPassword(event.target.value)} required/></div><div className="settings-field"><label htmlFor="new-password">New password</label><input id="new-password" type="password" autoComplete="new-password" minLength={12} value={newPassword} onChange={event => setNewPassword(event.target.value)} required/><small>Use at least 12 characters.</small></div><div className="settings-field"><label htmlFor="confirm-password">Confirm new password</label><input id="confirm-password" type="password" autoComplete="new-password" minLength={12} value={confirmPassword} onChange={event => setConfirmPassword(event.target.value)} required/></div><div className="settings-form-actions"><button className="button" disabled={changingPassword}>{changingPassword ? "Updating password…" : "Update password"}</button></div></form>
      {passwordNotice && <p className="settings-success" role="status"><Check size={14}/>{passwordNotice}</p>}
      <a className="settings-security-row settings-reset-link" href="/forgot-password"><span className="settings-security-icon"><LockKeyhole size={15}/></span><span><b>Forgot your current password?</b><small>Request a secure reset link by email.</small></span><ChevronRight size={16}/></a>
    </section>

    <section className="settings-section app-card"><div className="settings-section-heading"><span className="settings-icon security"><Monitor size={18}/></span><div><span className="usage-section-kicker">ACTIVE ACCESS</span><h2>Signed-in devices</h2><p>Review recent sessions and sign out any device you no longer use.</p></div><button className="button button-secondary" type="button" onClick={()=>void revokeOtherSessions()} disabled={sessionBusy!==""||activeSessions.filter(session=>!session.current).length===0}>{sessionBusy==="others"?"Signing out…":"Sign out other devices"}</button></div>
      {sessionNotice&&<p className="settings-success" role="status"><Check size={14}/>{sessionNotice}</p>}
      {sessionsLoading?<div className="settings-session-loading"><span className="loading-orbit"/>Checking active sessions…</div>:activeSessions.length===0?<p className="settings-session-empty">No active sessions were found.</p>:<div className="settings-session-list">{activeSessions.map(session=>{const mobile=/mobile|android|iphone|ipad/i.test(session.userAgent??"");return <article className="settings-session-row" key={session.id}><span className="settings-session-device">{mobile?<Smartphone size={17}/>:<Monitor size={17}/>}</span><span className="settings-session-copy"><b>{mobile?"Mobile browser":"Desktop browser"}{session.current&&<em>Current device</em>}</b><small>{session.userAgent||"Browser details unavailable"}</small><small>Signed in {Number.isNaN(Date.parse(session.createdAt))?"recently":new Intl.DateTimeFormat(undefined,{dateStyle:"medium",timeStyle:"short"}).format(new Date(session.createdAt))}{session.ipAddress?` · ${session.ipAddress}`:""}</small></span>{!session.current&&<button className="button button-secondary" type="button" onClick={()=>void revokeSession(session.id)} disabled={sessionBusy!==""}>{sessionBusy===session.id?"Signing out…":"Sign out"}</button>}</article>})}</div>}
      <div className="settings-security-foot"><ShieldCheck size={14}/><span>Sessions expire after 12 hours of inactivity. Changing your password revokes your other active sessions.</span></div>
    </section>

    <section className="settings-section app-card"><div className="settings-section-heading"><span className="settings-icon security"><ShieldCheck size={18}/></span><div><span className="usage-section-kicker">THIS DEVICE</span><h2>Sign out</h2><p>Sign out of this browser from the account menu beside your avatar.</p></div></div></section>

    <section className="settings-section settings-danger-section app-card"><div className="settings-section-heading"><span className="settings-icon danger"><AlertTriangle size={18}/></span><div><span className="usage-section-kicker">PERMANENT ACTION</span><h2>Delete account</h2><p>Remove your account and personal workspace data from Widesip.</p></div></div>
      {ownedOrganizations.length > 0 && <p className="settings-danger-notice" role="note">Transfer ownership of {ownedOrganizations.map(workspace => workspace.name).join(", ")} before deleting this account. Organization data will not be deleted with your personal account.</p>}
      <form className="delete-account-form" onSubmit={deleteAccount}><div className="settings-field"><label htmlFor="delete-account-password">Current password <span>(optional for recently re-authenticated Google accounts)</span></label><input id="delete-account-password" type="password" autoComplete="current-password" value={deletePassword} onChange={event => setDeletePassword(event.target.value)}/><small>For accounts with a password, enter it to confirm. Without it, Widesip requires a recent sign-in.</small></div><div className="settings-field"><label htmlFor="delete-confirmation">Type DELETE to confirm</label><input id="delete-confirmation" value={deleteConfirmation} onChange={event => setDeleteConfirmation(event.target.value)} autoComplete="off"/></div><button className="button danger-button" disabled={deleting || deleteConfirmation !== "DELETE" || ownedOrganizations.length > 0}><Trash2 size={14}/>{deleting ? "Deleting account…" : "Delete my account"}</button></form>
      <p className="settings-danger-foot">This cannot be undone. Personal workspaces and their data will be removed. Your membership will be removed from workspaces you do not own.</p>
    </section>
  </>;
}
