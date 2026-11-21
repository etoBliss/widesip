"use client";
import type { ReactNode } from "react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { Building2, LockKeyhole, Mail, UserRound, CalendarDays, Fingerprint, KeyRound, BadgeCheck, ArrowRight, Inbox, Sparkles, Building, AtSign, Check } from "lucide-react";

type Scene = "signup" | "signin" | "verify" | "recovery" | "reset" | "workspace";
export function AuthCard({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return <div className="auth-form-card"><h1>{title}</h1><p className="auth-intro">{description}</p>{children}</div>;
}

export function AuthLayout({ scene, children, step = 1 }: { scene: Scene; children: ReactNode; step?: number }) {
  const [liveStep, setLiveStep] = useState(step);
  const [organizationFlow, setOrganizationFlow] = useState(false);
  useEffect(() => { const update = (event: Event) => { const detail = (event as CustomEvent<{step:number;organization:boolean}>).detail; setLiveStep(detail.step); setOrganizationFlow(detail.organization); }; window.addEventListener("widesip-auth-step", update); return () => window.removeEventListener("widesip-auth-step", update); }, []);
  const flowIndex = organizationFlow ? (liveStep === 1 ? 1 : liveStep - 1) : liveStep;
  const activeStep = Math.min(4, Math.max(1, flowIndex));
  return <main className={`auth-page auth-${scene}`}>
    <section className="auth-visual" aria-label="Widesip introduction">
      <div className="auth-visual-texture" />
      <div className={`auth-art auth-flow-art auth-step-${activeStep} ${scene === "signin" ? "auth-returning-art" : ""}`} aria-label={scene === "signin" ? "Welcome back to your Widesip workspace" : `Account setup step ${activeStep} illustration`}>
        <div className="auth-flow-glow"/>
        {scene === "signin" ? <article className="auth-flow-card returning-card"><div className="auth-flow-card-top"><span className="mark">w</span><span className="auth-flow-secure"><LockKeyhole size={12}/> Private</span></div><div className="welcome-illustration"><div className="welcome-orbit welcome-orbit-one"/><div className="welcome-orbit welcome-orbit-two"/><div className="welcome-inbox-icon"><Inbox/></div><span className="welcome-spark spark-one"><Sparkles/></span><span className="welcome-spark spark-two"><Mail/></span><span className="welcome-dot dot-one"/><span className="welcome-dot dot-two"/></div><div className="welcome-copy"><span>Widesip workspace</span><h3>Good to have you back.</h3><p>Your conversations and team spaces are ready when you are.</p></div><div className="welcome-return-link">Continue to your workspace <ArrowRight size={15}/></div></article> : <article className="auth-flow-card">
          <div className="auth-flow-card-top"><span className="mark">w</span><span className="auth-flow-secure"><LockKeyhole size={12}/> Private</span></div>
          <div className="auth-illustration" aria-hidden="true">{organizationFlow && liveStep === 2 ? <><span className="illustration-org-building"><Building/></span><span className="illustration-org-card"><b>Organization name</b><i/><small>Workspace identity</small></span><span className="illustration-org-check"><Check size={15}/></span></> : activeStep === 1 ? <><span className="illustration-tile tile-left"><UserRound/></span><span className="illustration-tile tile-right"><Building2/></span><span className="illustration-link"/></> : activeStep === 2 ? <><span className="illustration-profile"><UserRound/></span><span className="illustration-detail detail-one"><b>Name</b><i/></span><span className="illustration-detail detail-two"><CalendarDays/><b>Date of birth</b><i/></span></> : activeStep === 3 ? <><span className="illustration-envelope"><Mail/></span><span className="illustration-check"><BadgeCheck/></span><i className="illustration-orbit orbit-one"/><i className="illustration-orbit orbit-two"/><AtSign className="illustration-at"/></> : <><span className="illustration-key"><KeyRound/></span><span className="illustration-password"><i/><i/><i/><i/><i/><i/></span><span className="illustration-shield"><Fingerprint/></span></>}</div>
          <h3>{organizationFlow && liveStep === 2 ? "Name your organization" : ["Choose your space", "Add your details", "Verify your email", "Secure your account"][activeStep - 1]}</h3>
          {activeStep === 1 && <div className="auth-flow-options"><div className="auth-flow-option personal"><span><UserRound size={15}/></span><div><b>Personal</b><small>Your private space</small></div></div><div className="auth-flow-option organization"><span><Building2 size={15}/></span><div><b>Organization</b><small>For your team</small></div></div></div>}
          <div className="auth-flow-divider"/>
          <div className={`auth-flow-steps ${organizationFlow ? "five-steps" : ""}`}>{(organizationFlow ? ["Account", "Org", "Details", "Email", "Password"] : ["Account", "Details", "Email", "Password"]).map((label, index) => { const current = organizationFlow ? liveStep : activeStep; return <span key={label} className={current === index + 1 ? "current" : current > index + 1 ? "done" : ""}><i>{current > index + 1 ? "✓" : index + 1}</i><b>{label}</b></span>; })}</div>
        </article>}
      </div>
    </section>
    <section className="auth-content"><header className="auth-topbar"/><div className="auth-content-center">{children}</div><footer className="auth-content-footer"><Link href="/privacy">Privacy</Link><Link href="/terms">Terms</Link><Link href="/">Back to Widesip</Link></footer></section>
  </main>;
}
