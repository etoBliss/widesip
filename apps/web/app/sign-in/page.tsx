import Link from "next/link";
import { AuthCard, AuthLayout } from "@/components/auth-layout";
import { SignInForm } from "@/components/auth-forms";
export default function SignIn(){return <AuthLayout scene="signin"><AuthCard title="Sign in to Widesip." description="Continue to your personal space or a team workspace."><SignInForm/><div className="auth-switch">New to Widesip? <Link href="/sign-up">Create an account</Link></div></AuthCard></AuthLayout>}
