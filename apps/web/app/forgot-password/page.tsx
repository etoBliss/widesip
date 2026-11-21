import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { AuthCard, AuthLayout } from "@/components/auth-layout";
import { ForgotPasswordForm } from "@/components/setup-forms";
export default function ForgotPassword(){return <AuthLayout scene="recovery"><AuthCard title="Let’s get you back in." description="Enter the email address linked to your account. We’ll prepare a secure reset link if we find a match."><ForgotPasswordForm/><div className="auth-switch"><Link href="/sign-in"><ArrowLeft size={13}/> Back to sign in</Link></div></AuthCard></AuthLayout>}