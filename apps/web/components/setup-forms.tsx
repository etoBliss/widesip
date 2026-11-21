"use client";

import type { FormEvent } from "react";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, Building2, Check, CheckCircle2, MailCheck, UserRound } from "lucide-react";
import { PasswordInput } from "@/components/auth-forms";

const api = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

type OnboardingAccount = { name: string; accountType: "personal" | "organization"; dateOfBirth: string | null; organizationName: string | null; onboardingComplete: boolean };

export function OnboardingForm({ next = "" }: { next?: string }) {
  const router = useRouter();
  const inviteFlow = /^\/invite\/[a-f0-9]{64}$/.test(next);
  const [kind, setKind] = useState<"personal" | "organization">("personal");
  const [dateOfBirth, setDateOfBirth] = useState("");
  const [organizationName, setOrganizationName] = useState("");
  const [accountName, setAccountName] = useState("");
  const [step, setStep] = useState(inviteFlow ? 2 : 1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    void fetch(`${api}/v1/account`, { credentials: "include", cache: "no-store" })
      .then(async response => {
        if (response.status === 401) throw new Error("Sign in to continue setting up your account.");
        const result = await response.json() as { data?: OnboardingAccount; error?: { message?: string } };
        if (!response.ok || !result.data) throw new Error(result.error?.message ?? "Could not load your account.");
        if (!active) return;
        setAccountName(result.data.name);
        if (result.data.dateOfBirth) setDateOfBirth(result.data.dateOfBirth);
        if (result.data.organizationName) setOrganizationName(result.data.organizationName);
        if (!inviteFlow && result.data.accountType === "organization") setKind("organization");
        if (result.data.onboardingComplete) { router.replace(next || (result.data.accountType === "organization" ? "/app/domains" : "/app")); return; }
        const accountType = inviteFlow ? "personal" : result.data.accountType;
        const organization = result.data.organizationName?.trim() ?? "";
        if (result.data.dateOfBirth && (accountType === "personal" || organization.length >= 2)) {
          const completion = await fetch(`${api}/v1/account/complete-onboarding`, { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ accountType, dateOfBirth: result.data.dateOfBirth, ...(accountType === "organization" ? { organizationName: organization } : {}), ...(inviteFlow ? { inviteToken: next.split("/").at(-1) } : {}) }) });
          const completed = await completion.json() as { data?: { activeWorkspaceId?: string; personalWorkspaceId?: string }; error?: { message?: string } };
          if (!completion.ok || !completed.data) throw new Error(completed.error?.message ?? "Your account setup could not be completed.");
          const activeWorkspace = inviteFlow ? completed.data.personalWorkspaceId : completed.data.activeWorkspaceId;
          if (activeWorkspace) localStorage.setItem("widesip.workspace", activeWorkspace);
          router.replace(next || (accountType === "organization" ? "/app/domains" : "/app"));
        }
      })
      .catch(cause => { if (active) setError(cause instanceof Error ? cause.message : "Could not load your account."); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [inviteFlow, next, router]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError("");
    if (!inviteFlow && step === 1) { setStep(2); return; }
    if (!inviteFlow && step === 2 && kind === "organization") { setStep(3); return; }
    setBusy(true);
    try {
      const response = await fetch(`${api}/v1/account/complete-onboarding`, { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ accountType: inviteFlow ? "personal" : kind, dateOfBirth, organizationName: kind === "organization" ? organizationName : undefined, ...(inviteFlow ? { inviteToken: next.split("/").at(-1) } : {}) }) });
      const result = await response.json() as { data?: { activeWorkspaceId?: string; personalWorkspaceId?: string }; error?: { message?: string } };
      if (!response.ok || !result.data) throw new Error(result.error?.message ?? "Account setup could not be completed.");
      const activeWorkspace = inviteFlow ? result.data.personalWorkspaceId : result.data.activeWorkspaceId;
      if (activeWorkspace) localStorage.setItem("widesip.workspace", activeWorkspace);
      router.replace(next || (kind === "organization" ? "/app/domains" : "/app"));
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Something went wrong. Try again."); }
    finally { setBusy(false); }
  }

  if (loading) return <div className="auth-form-card onboarding-card"><span className="loading-orbit"/><p>Preparing your account setup…</p></div>;
  if (error.startsWith("Sign in to continue")) return <div className="auth-form-card onboarding-card"><h1>Sign in to finish setup</h1><p className="auth-intro">Your account was created. Sign in to finish setting up your personal or organization workspace.</p><a className="button auth-wide-button" href={`/sign-in?next=${encodeURIComponent(next || "/onboarding")}`}>Continue to sign in <ArrowRight size={15}/></a></div>;
  const stepCount = inviteFlow ? 1 : kind === "organization" ? 3 : 2;
  const stepNumber = inviteFlow ? 1 : step;
  return <div className="auth-form-card onboarding-card">
    <div className="onboarding-progress"><span>STEP {stepNumber} OF {stepCount}</span><i><b style={{ width: `${Math.round(stepNumber / stepCount * 100)}%` }}/></i></div>
    <h1>{inviteFlow ? "Your personal account" : step === 1 ? "How will you use Widesip?" : step === 2 ? "A little about you." : "Set up your organization."}</h1>
    <p className="auth-intro">{inviteFlow ? `You’re joining ${accountName ? "a team" : "an organization"}. This invitation creates your private personal account first.` : step === 1 ? "Choose a personal account or an organization account for a business and its team." : step === 2 ? "Add your date of birth to complete your account profile." : "Give your team workspace a name. You can connect a domain later."}</p>
    <form onSubmit={submit}>
      {!inviteFlow && step === 1 && <div className="workspace-choice-grid" role="group" aria-label="Account type">
        <button type="button" className={`workspace-choice ${kind === "personal" ? "selected" : ""}`} aria-pressed={kind === "personal"} onClick={() => setKind("personal")}><span className="choice-icon"><UserRound size={17}/></span><span><b>Personal</b><small>Join organizations when invited</small></span>{kind === "personal" && <span className="choice-check"><Check size={12}/></span>}</button>
        <button type="button" className={`workspace-choice ${kind === "organization" ? "selected" : ""}`} aria-pressed={kind === "organization"} onClick={() => setKind("organization")}><span className="choice-icon team-choice"><Building2 size={17}/></span><span><b>Organization</b><small>Create a business workspace and invite people</small></span>{kind === "organization" && <span className="choice-check"><Check size={12}/></span>}</button>
      </div>}
      {(inviteFlow || step === 2) && <div className="field"><label htmlFor="date-of-birth">Date of birth</label><input id="date-of-birth" type="date" value={dateOfBirth} max={new Date().toISOString().slice(0, 10)} onChange={event => setDateOfBirth(event.target.value)} required/><small>This stays private to your account.</small></div>}
      {!inviteFlow && step === 3 && <div className="field"><label htmlFor="organization-name">Organization name</label><input id="organization-name" value={organizationName} onChange={event => setOrganizationName(event.target.value)} minLength={2} maxLength={80} placeholder="Northstar Studio" required autoComplete="organization"/></div>}
      {error && <p role="alert" className="auth-error">{error}</p>}
      <div className="onboarding-actions">{!inviteFlow && step > 1 && <button type="button" className="button secondary" onClick={() => setStep(step - 1)} disabled={busy}>Back</button>}<button className="button auth-wide-button" disabled={busy || ((inviteFlow || step === 2) && !dateOfBirth) || (step === 3 && organizationName.trim().length < 2)}>{busy ? "Finishing setup…" : (inviteFlow || step === stepCount) ? "Finish setup" : "Continue"}<ArrowRight size={15}/></button></div>
    </form>
    <div className="onboarding-note"><span><Check size={12}/></span><p><b>Private by design.</b> Personal accounts can join organization teams, but only organization accounts can create them.</p></div>
  </div>;
}

export function ResetPasswordForm({ token }: { token: string }) {
  const router = useRouter();
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError("");
    const data = new FormData(event.currentTarget);
    const password = String(data.get("password"));
    if (password !== data.get("confirm")) { setError("Those passwords don’t match yet."); return; }
    setBusy(true);
    try {
      const response = await fetch(`${api}/api/auth/reset-password`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ newPassword: password, token }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.message ?? result.error?.message ?? "This reset link may have expired.");
      setDone(true);
      setTimeout(() => router.push("/sign-in"), 1600);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Something went wrong. Try again."); }
    finally { setBusy(false); }
  }

  if (done) return <div className="auth-success-state" role="status"><CheckCircle2 size={20}/><span><b>Password updated.</b><small>Taking you back to sign in…</small></span></div>;
  return <form onSubmit={submit}><PasswordInput id="password" label="New password" autoComplete="new-password" minLength={12}/><PasswordInput id="confirm" label="Confirm new password" autoComplete="new-password" minLength={12}/>{error && <p role="alert" className="auth-error">{error}</p>}<button className="button" disabled={busy}>{busy ? "Updating password…" : "Set new password"}<ArrowRight size={15}/></button></form>;
}

export function ForgotPasswordForm() {
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError("");
    const data = new FormData(event.currentTarget);
    try {
      const response = await fetch(`${api}/api/auth/request-password-reset`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: data.get("email"), redirectTo: `${window.location.origin}/reset-password` }) });
      if (!response.ok) {
        const result = await response.json();
        throw new Error(result.message ?? result.error?.message ?? "Please try again later.");
      }
      setSent(true);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Please try again later."); }
    finally { setBusy(false); }
  }

  if (sent) return <div className="auth-success-state" role="status"><MailCheck size={20}/><span><b>Check your inbox.</b><small>If an account matches that address, a reset link is on its way.</small></span></div>;
  return <form onSubmit={submit}><div className="field"><label htmlFor="email">Account email</label><input id="email" name="email" type="email" autoComplete="email" placeholder="you@example.com" required/></div>{error && <p role="alert" className="auth-error">{error}</p>}<button className="button" disabled={busy}>{busy ? "Preparing your link…" : "Send reset link"}<ArrowRight size={15}/></button></form>;
}
