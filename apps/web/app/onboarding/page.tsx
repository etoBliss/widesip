import { AuthLayout } from "@/components/auth-layout";
import { OnboardingForm } from "@/components/setup-forms";
export default async function Onboarding({searchParams}:{searchParams:Promise<{next?:string}>}){
  const params=await searchParams;
  const next=params.next&&(/^\/invite\/[a-f0-9]{64}$/.test(params.next)||/^\/app(?:\/[a-z0-9-]+)*$/.test(params.next))?params.next:"";
  return <AuthLayout scene="workspace"><OnboardingForm next={next}/></AuthLayout>;
}
