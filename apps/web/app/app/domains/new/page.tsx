"use client";

import type { FormEvent } from "react";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, ArrowRight, Globe2, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { AppShell } from "@/components/app-shell";

const api = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

export default function AddDomainPage() {
  const router = useRouter();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError("");
    const workspaceId = localStorage.getItem("widesip.workspace");
    if (!workspaceId) { setError("Choose or create a workspace before adding a domain."); setBusy(false); return; }
    const data = new FormData(event.currentTarget);
    try {
      const response = await fetch(`${api}/v1/domains`, { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ workspaceId, domainName: data.get("domain") }) });
      const result = await response.json();
      if (!response.ok || !result.data?.id) throw new Error(result.error?.message ?? "Domain could not be added.");
      router.push(`/app/domains?expand=${encodeURIComponent(result.data.id)}`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Something went wrong. Try again."); }
    finally { setBusy(false); }
  }

  return <AppShell>
    <div className="page-heading"><div><h1>Add a domain</h1><p>Add a domain you own. Widesip will show the DNS record to verify it.</p></div><Link className="button secondary" href="/app/domains"><ArrowLeft size={14}/> Back to domains</Link></div>
    <section className="domain-setup-layout domain-setup-simple">
      <article className="app-card domain-form-card"><span className="domain-form-icon"><Globe2 size={18}/></span><h2>Connect your domain</h2><p>Enter the domain you use for your business or project.</p><form onSubmit={submit}><div className="field"><label htmlFor="domain">Domain name</label><input id="domain" name="domain" placeholder="yourcompany.com" required autoComplete="url" aria-describedby="domain-help"/><span className="field-help" id="domain-help">Enter only the domain name, without www or an email address.</span></div>{error&&<p role="alert" className="auth-error">{error}</p>}<button className="button" disabled={busy}>{busy?"Adding domain…":"Add domain"}<ArrowRight size={15}/></button></form><div className="domain-safety-note"><ShieldCheck size={15}/><span>Adding a domain does not change DNS records. You’ll review the verification record before adding it.</span></div></article>
    </section>
  </AppShell>;
}
