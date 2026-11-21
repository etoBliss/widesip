import Link from "next/link";
import { ArrowRight, MailCheck } from "lucide-react";
import { AuthCard, AuthLayout } from "@/components/auth-layout";

export default async function VerifyEmail({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const params = await searchParams;
  const next = params.next && /^\/invite\/[a-f0-9]{64}$/.test(params.next) ? params.next : "";
  const signInHref = next ? `/sign-in?next=${encodeURIComponent(next)}` : "/sign-in";
  const localDevelopment = process.env.NODE_ENV !== "production";
  return <AuthLayout scene="verify"><AuthCard title="Check your inbox." description="Open the verification link we sent you. Widesip will finish setting up your account once your email is confirmed."><div className="auth-inline-success"><MailCheck size={19}/><span>Your email address is the key to your Widesip account.</span></div>{localDevelopment && <div className="verify-local-note"><b>Working locally?</b><span>Email delivery isn’t configured yet. Open the link printed in the API terminal under “Widesip local email preview.”</span></div>}<Link className="button auth-wide-button" href={signInHref}>Return to sign in <ArrowRight size={15}/></Link><div className="auth-switch">Need a fresh link? <span>Try signing in to send another.</span></div></AuthCard></AuthLayout>;
}
