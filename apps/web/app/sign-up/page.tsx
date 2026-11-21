import Link from "next/link";
import { AuthLayout } from "@/components/auth-layout";
import { SignUpForm } from "@/components/auth-forms";
export default async function SignUp({searchParams}:{searchParams:Promise<{next?:string;step?:string}>}){
  const params=await searchParams;
  const next=params.next&&/^\/invite\/[a-f0-9]{64}$/.test(params.next)?params.next:"";
  const initialStep = Math.min(4, Math.max(1, Number(params.step) || 1));
  return <AuthLayout scene="signup" step={initialStep}><div className="auth-form-card auth-signup-card"><SignUpForm next={next}/><div className="auth-switch">Already using Widesip? <Link href="/sign-in">Sign in</Link></div></div></AuthLayout>;
}
