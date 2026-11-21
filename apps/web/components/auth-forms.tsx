"use client";

import type { FormEvent } from "react";
import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import { Building2, Check, Eye, EyeOff, UserRound } from "lucide-react";
import { TurnstileCaptcha } from "./turnstile-captcha";
import { ScheduleCalendar } from "./schedule-calendar";

const api = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
const captchaEnabled=process.env.NODE_ENV==="production";
type AuthResponse = { message?: string; error?: { message?: string } };

function getSafeNext() {
  const candidate = new URLSearchParams(window.location.search).get("next") ?? "";
  return candidate === "/onboarding" || /^\/onboarding\?next=\/invite\/[a-f0-9]{64}$/.test(candidate) || /^\/invite\/[a-f0-9]{64}$/.test(candidate) ? candidate : "";
}

async function readAuthResponse(response: Response): Promise<AuthResponse> {
  const body = await response.text();
  if (!body.trim()) throw new Error(`The API returned an empty response (HTTP ${response.status}). Check the API terminal for the server error.`);
  try { return JSON.parse(body) as AuthResponse; }
  catch { throw new Error(`The API returned a non-JSON response (HTTP ${response.status}). Check the API terminal for the server error.`); }
}

function useChallenge() {
  const [token,setToken]=useState("");
  const [resetSignal,setResetSignal]=useState(0);
  const onToken=useCallback((value:string)=>setToken(value),[]);
  function reset(){setToken("");setResetSignal(value=>value+1);}
  return {token,onToken,resetSignal,reset};
}

function challengeHeaders(token:string) {
  return {"Content-Type":"application/json",...(token?{"x-captcha-response":token}:{})};
}

export function PasswordInput({ id, label, autoComplete, minLength, value, onValue }: { id: string; label: string; autoComplete: string; minLength?: number; value?: string; onValue?: (value: string) => void }) {
  const [visible, setVisible] = useState(false);
  return <div className="field"><label htmlFor={id}>{label}</label><div className="auth-password-wrap"><input id={id} name={id} type={visible ? "text" : "password"} autoComplete={autoComplete} minLength={minLength} required value={value} onChange={onValue ? (event) => onValue(event.target.value) : undefined}/><button className="password-visibility" type="button" onClick={() => setVisible(!visible)} aria-label={visible ? `Hide ${label.toLowerCase()}` : `Show ${label.toLowerCase()}`} aria-pressed={visible}>{visible ? <EyeOff size={15}/> : <Eye size={15}/>}</button></div></div>;
}

function getStrength(password: string) {
  if (!password) return 0;
  return [password.length >= 12, /[a-z]/.test(password) && /[A-Z]/.test(password), /\d/.test(password), /[^A-Za-z0-9]/.test(password)].filter(Boolean).length;
}

export function SignUpForm({ next = "" }: { next?: string }) {
  const router = useRouter();
  const inviteFlow = /^\/invite\/[a-f0-9]{64}$/.test(next);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const initialStep = Math.min(5, Math.max(inviteFlow ? 2 : 1, Number(new URLSearchParams(typeof window === "undefined" ? "" : window.location.search).get("step")) || 1));
  const [step, setStep] = useState(initialStep);
  function goToStep(next: number) { setStep(next); window.dispatchEvent(new CustomEvent("widesip-auth-step", { detail: { step: next, organization: kind === "organization" && !inviteFlow } })); }
  const [kind, setKind] = useState<"personal" | "organization">("personal");
  const [name, setName] = useState("");
  const [dateOfBirth, setDateOfBirth] = useState("");
  const [organizationName, setOrganizationName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const challenge=useChallenge();
  const strength = getStrength(password);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError("");
    const flowFinalStep = !inviteFlow && kind === "organization" ? 5 : 4;
    if (step < flowFinalStep) { goToStep(step + 1); return; }
    setBusy(true);
    if(captchaEnabled && !challenge.token){setError("Complete the security check before creating your account.");setBusy(false);return;}
    if (password !== confirm) { setError("Those passwords do not match."); setBusy(false); return; }
    try {
      const callbackURL = `${window.location.origin}${next || "/onboarding"}`;
      const response = await fetch(`${api}/api/auth/sign-up/email`, { method: "POST", credentials: "include", headers: challengeHeaders(challenge.token), body: JSON.stringify({ name: name.trim(), email: email.trim(), password, accountType: inviteFlow ? "personal" : kind, dateOfBirth, ...(kind === "organization" && !inviteFlow ? { organizationName: organizationName.trim() } : {}), callbackURL }) });
      const result = await readAuthResponse(response);
      if (!response.ok) throw new Error(result.message ?? result.error?.message ?? "We could not create your account.");
      router.push(next ? `/verify-email?next=${encodeURIComponent(next)}` : "/verify-email");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Something went wrong. Try again."); }
    finally { setBusy(false);challenge.reset(); }
  }
  const organizationFlow = !inviteFlow && kind === "organization";
  const finalStep = organizationFlow ? 5 : 4;
  const stepCount = inviteFlow ? 3 : finalStep;
  const visibleStep = inviteFlow ? step - 1 : organizationFlow && step > 2 ? step - 1 : step;
  return <section className="signup-wizard" aria-labelledby="signup-step-title">
    <div className="signup-progress"><div><b>Step {visibleStep} of {stepCount}</b></div><i><b style={{ width: `${Math.round(visibleStep / stepCount * 100)}%` }}/></i></div>
    <h1 id="signup-step-title">{!inviteFlow && step === 1 ? "Choose your account" : organizationFlow && step === 2 ? "Name your organization" : step === (organizationFlow ? 3 : 2) ? "Your details" : step === (organizationFlow ? 4 : 3) ? "Your email address" : "Create a password"}</h1>
    <p className="auth-intro">{!inviteFlow && step === 1 ? "Start with the space that fits how you’ll use Widesip." : organizationFlow && step === 2 ? "Choose the name your team will see in Widesip." : step === (organizationFlow ? 3 : 2) ? inviteFlow ? "You’re joining a team as a personal account. Your own space stays private." : "Add your name and date of birth." : step === (organizationFlow ? 4 : 3) ? "We’ll send a verification link to this address." : "Use at least 12 characters and keep it unique to Widesip."}</p>
    <form onSubmit={submit}>
      {!inviteFlow && step === 1 && <div className="workspace-choice-grid" role="group" aria-label="Account type">
        <button type="button" className={`workspace-choice ${kind === "personal" ? "selected" : ""}`} aria-pressed={kind === "personal"} onClick={() => setKind("personal")}><span className="choice-icon"><UserRound size={17}/></span><span><b>Personal</b><small>Join an organization when invited</small></span>{kind === "personal" && <span className="choice-check"><Check size={12}/></span>}</button>
        <button type="button" className={`workspace-choice ${kind === "organization" ? "selected" : ""}`} aria-pressed={kind === "organization"} onClick={() => setKind("organization")}><span className="choice-icon team-choice"><Building2 size={17}/></span><span><b>Organization</b><small>Create a workspace and invite your team</small></span>{kind === "organization" && <span className="choice-check"><Check size={12}/></span>}</button>
      </div>}
      {organizationFlow && step === 2 && <div className="field"><label htmlFor="signup-organization">Organization name</label><input id="signup-organization" autoComplete="organization" placeholder="Northstar Studio" value={organizationName} onChange={event => setOrganizationName(event.target.value)} required minLength={2} maxLength={80}/></div>}
      {step === (organizationFlow ? 3 : 2) && <>
        <div className="field"><label htmlFor="signup-name">Full name</label><input id="signup-name" autoComplete="name" placeholder="Ada Okafor" value={name} onChange={event => setName(event.target.value)} required minLength={2} maxLength={80}/></div>
        <div className="field"><label>Date of birth</label><ScheduleCalendar mode="date" value={dateOfBirth} onChange={setDateOfBirth}/><input type="hidden" autoComplete="bday" value={dateOfBirth} required readOnly/></div>
      </>}
      {step === (organizationFlow ? 4 : 3) && <div className="field"><label htmlFor="signup-email">Email address</label><input id="signup-email" type="email" autoComplete="email" placeholder="you@example.com" value={email} onChange={event => setEmail(event.target.value)} required maxLength={254}/><small>Use an address you can open now. We’ll verify it before you enter Widesip.</small></div>}
      {step === finalStep && <>
        <PasswordInput id="password" label="Password" autoComplete="new-password" minLength={12} value={password} onValue={setPassword}/>
        {password && <div className={`password-strength strength-${strength}`} aria-live="polite"><div className="strength-bars"><i/><i/><i/><i/></div><span>{["Add a little more variety", "Getting stronger", "Good foundation", "Strong password", "Excellent password"][strength]}</span></div>}
        <PasswordInput id="confirm" label="Confirm password" autoComplete="new-password" minLength={12} value={confirm} onValue={setConfirm}/>
        <TurnstileCaptcha onToken={challenge.onToken} resetSignal={challenge.resetSignal}/>
        <label className="auth-consent"><input type="checkbox" required/><span>I agree to the <a href="/terms">Terms</a> and <a href="/privacy">Privacy Policy</a>.</span></label>
      </>}
      {error && <p role="alert" className="auth-error">{error}</p>}
      <div className="onboarding-actions">{step > (inviteFlow ? 2 : 1) && <button type="button" className="button secondary" onClick={() => { setError(""); goToStep(step - 1); }} disabled={busy}>Back</button>}<button className="button auth-wide-button" disabled={busy || (organizationFlow && step === 2 && organizationName.trim().length < 2) || (step === (organizationFlow ? 3 : 2) && (name.trim().length < 2 || !dateOfBirth)) || (step === (organizationFlow ? 4 : 3) && !email.includes("@")) || (step === finalStep && (!password || !confirm))}>{busy ? "Creating your account…" : step === finalStep ? "Create account" : "Continue"}<span aria-hidden="true">→</span></button></div>
    </form>
  </section>;
}

export function SignInForm() {
  const router = useRouter();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const challenge=useChallenge();
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(""); setBusy(true);
    const data = new FormData(event.currentTarget);
    if(captchaEnabled && !challenge.token){setError("Complete the security check before signing in.");setBusy(false);return;}
    try {
      const response = await fetch(`${api}/api/auth/sign-in/email`, { method: "POST", credentials: "include", headers: challengeHeaders(challenge.token), body: JSON.stringify({ email: data.get("email"), password: data.get("password"), rememberMe: true, callbackURL: new URL("/app", window.location.origin).toString() }) });
      const result = await readAuthResponse(response);
      if (!response.ok) throw new Error(result.message ?? result.error?.message ?? `Sign-in failed (HTTP ${response.status}). Check the API terminal for the server error.`);
      router.push(getSafeNext() || "/app");
    } catch (cause) {
      console.error("[Widesip sign-in] Request failed",cause);
      const message=typeof cause==="string"?cause:cause&&typeof cause==="object"&&"message" in cause&&typeof cause.message==="string"?cause.message:"Sign-in failed unexpectedly. Check the API terminal for the server error.";
      setError(message);
    }
    finally { setBusy(false);challenge.reset(); }
  }
  return <form onSubmit={submit}>
    <div className="field"><label htmlFor="email">Email address</label><input id="email" name="email" type="email" autoComplete="email" placeholder="you@example.com" required/></div>
    <PasswordInput id="password" label="Password" autoComplete="current-password"/>
    <TurnstileCaptcha onToken={challenge.onToken} resetSignal={challenge.resetSignal}/>
    <div className="auth-forgot-link"><a href="/forgot-password">Forgot password?</a></div>
    {error && <p role="alert" className="auth-error">{error}</p>}
    <button className="button" disabled={busy}>{busy ? "Signing you in..." : "Sign in"}<span aria-hidden="true">→</span></button>
  </form>;
}
