"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ArrowRight, Mail, ShieldCheck, Users } from "lucide-react";

const api = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
type Invite = { email: string; role: "admin" | "member"; workspaceName: string; expiresAt: string };
type Result<T> = { data?: T; error?: { code?: string; message?: string } };
export default function AcceptInvitePage() {
  const params = useParams<{ token: string }>();
  const token = params.token;
  const next = `/invite/${token}`;
  const router = useRouter();
  const [invite, setInvite] = useState<Invite | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [signedIn, setSignedIn] = useState(false);
  const [accountReady, setAccountReady] = useState(false);
  useEffect(() => {
    let active = true;
    fetch(`${api}/v1/invitations/${encodeURIComponent(token)}`, { credentials: "include" })
      .then(async (response) => { const result = await response.json() as Result<Invite>; if (!response.ok || !result.data) throw new Error(result.error?.message ?? "This invitation is not valid."); if (active) setInvite(result.data); })
      .catch((cause) => { if (active) setError(cause instanceof Error ? cause.message : "Could not load this invitation."); });
    fetch(`${api}/api/auth/get-session`, { credentials: "include" }).then((response) => response.json()).then(async session => {
      if (!active) return;
      if (!session?.user) { setAccountReady(true); return; }
      const accountResponse = await fetch(`${api}/v1/account`, { credentials: "include", cache: "no-store" });
      const account = await accountResponse.json() as { data?: { onboardingComplete?: boolean } };
      if (!active) return;
      if (accountResponse.ok && !account.data?.onboardingComplete) {
        router.replace(`/onboarding?next=${encodeURIComponent(next)}`);
        return;
      }
      setSignedIn(true);
      setAccountReady(true);
    }).catch(() => { if (active) setAccountReady(true); });
    return () => { active = false; };
  }, [token]);
  async function accept() {
    setBusy(true); setError("");
    try {
      const response = await fetch(`${api}/v1/invitations/${encodeURIComponent(token)}/accept`, { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: "{}" });
      const result = await response.json() as Result<{ workspaceId: string }>;
      if (!response.ok || !result.data) throw new Error(result.error?.message ?? "Could not accept this invitation.");
      localStorage.setItem("widesip.workspace", result.data.workspaceId);
      router.push("/app");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not accept this invitation."); }
    finally { setBusy(false); }
  }
  const authHref = (path: string) => `${path}?next=${encodeURIComponent(next)}`;
  return <main className="invite-page"><section className="invite-card"><div className="invite-mark"><Users size={22}/></div><h1>You’re invited to join {invite?.workspaceName ?? "a Widesip workspace"}</h1><p className="invite-lede">Share the work, keep everything in one place.</p>{invite ? <div className="invite-details"><div><Mail size={16}/><span>Invitation for <b>{invite.email}</b></span></div><div><ShieldCheck size={16}/><span>Workspace role: <b>{invite.role}</b></span></div><small>Link expires {new Intl.DateTimeFormat(undefined, { dateStyle: "long" }).format(new Date(invite.expiresAt))}.</small></div> : !error && <p>Loading invitation…</p>}{error && <p className="team-notice team-error" role="alert">{error}</p>}{invite && !accountReady ? <p>Checking your account…</p> : invite && (signedIn ? <button className="button invite-accept" onClick={() => void accept()} disabled={busy}>{busy ? "Joining…" : "Accept invitation"}<ArrowRight size={16}/></button> : <div className="invite-auth"><p>Sign in or create an account using <b>{invite.email}</b> to accept.</p><Link className="button invite-accept" href={authHref("/sign-in")}>Sign in <ArrowRight size={16}/></Link><Link className="button secondary invite-accept" href={authHref("/sign-up")}>Create account</Link></div>)}<Link className="invite-back" href="/">Back to Widesip</Link></section></main>;
}
