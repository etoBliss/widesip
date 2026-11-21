"use client";

import { useEffect, useState } from "react";
import { ArrowLeft, ArrowRight, Check, CircleAlert, Copy, Globe2, MailCheck, Palette, RefreshCw, ShieldCheck, Waypoints } from "lucide-react";
import Link from "next/link";

const api = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
type DnsRecord = { type: string; name: string; value: string; priority?: number | null; ttl?: string | number };
type Domain = { id: string; domainName: string; verificationStatus: string; mailStatus: string; receivingEnabled: boolean; dnsVerification: null | { type: "TXT"; name: string; hostname: string; value: string; expiresAt: string; status: string } };
type Setup = { status: string; verified?: boolean; receivingEnabled?: boolean; receivingStatus?: string; receivingMxAvailable?: boolean; receivingMxStatus?: string; dnsAutomated?: boolean; appliedRecords?: string[]; conflicts?: DnsRecord[]; records?: DnsRecord[]; message: string };
type CloudflareStatus = { connected: boolean; zoneName: string | null; canManage: boolean; configured: boolean };
type Result<T> = { success?: boolean; data?: T; error?: { message?: string } };

const steps = ["Domain added", "Verify ownership", "Set up email", "Domain profile"];

export function DomainSetupWizard({ domainId }: { domainId: string }) {
  const [domain, setDomain] = useState<Domain | null>(null);
  const [step, setStep] = useState(2);
  const [receiving, setReceiving] = useState(false);
  const [receivingTouched, setReceivingTouched] = useState(false);
  const [records, setRecords] = useState<DnsRecord[]>([]);
  const [receivingMxAvailable, setReceivingMxAvailable] = useState(false);
  const [receivingMxStatus, setReceivingMxStatus] = useState("unknown");
  const [dnsConflicts, setDnsConflicts] = useState<DnsRecord[]>([]);
  const [dnsAutomated, setDnsAutomated] = useState(false);
  const [cloudflare, setCloudflare] = useState<CloudflareStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [copied, setCopied] = useState("");

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const workspaceId = localStorage.getItem("widesip.workspace") ?? "";
        if (!workspaceId) throw new Error("Choose a workspace before setting up a domain.");
        const response = await fetch(`${api}/v1/domains?workspaceId=${encodeURIComponent(workspaceId)}`, { credentials: "include" });
        const result = await response.json() as Result<Domain[]>;
        if (!response.ok) throw new Error(result.error?.message ?? "Could not load this domain.");
        const found = result.data?.find(item => item.id === domainId);
        if (!found) throw new Error("This domain is not available in the selected workspace.");
        const cloudflareResponse = await fetch(`${api}/v1/domains/${domainId}/cloudflare/status`, { credentials: "include" });
        const cloudflareResult = await cloudflareResponse.json() as Result<CloudflareStatus>;
        if (!active) return;
        setDomain(found); setReceiving(found.receivingEnabled);
        if (cloudflareResponse.ok && cloudflareResult.data) setCloudflare(cloudflareResult.data);
        const cloudflareResultCode = new URLSearchParams(window.location.search).get("cloudflare");
        const cloudflareMessages: Record<string, string> = {
          connected: "Cloudflare is connected for this organization. Widesip can now add compatible DNS records automatically.",
          "zone-not-found": "Cloudflare was authorized, but this domain was not found in that account. Confirm the right account and try again.",
          "sign-in-required": "Your Widesip session ended while connecting Cloudflare. Sign in and start the connection again.",
          expired: "The Cloudflare connection expired before it completed. Start the connection again.",
          "domain-changed": "This domain is no longer verified. Verify it again before connecting Cloudflare.",
          "access-changed": "Your organization access changed before Cloudflare finished connecting.",
          failed: "Cloudflare could not complete the connection. Try again or use the manual DNS records.",
        };
        if (cloudflareResultCode && cloudflareMessages[cloudflareResultCode]) {
          setNotice(cloudflareMessages[cloudflareResultCode]);
          window.history.replaceState({}, "", window.location.pathname);
          if (cloudflareResponse.ok && cloudflareResult.data) setCloudflare(cloudflareResult.data);
        }
        if (found.verificationStatus !== "verified") setStep(2);
        else if (found.mailStatus !== "active" || found.receivingEnabled) setStep(3);
        else setStep(4);
      } catch (cause) { if (active) setError(cause instanceof Error ? cause.message : "Could not load this domain."); }
      finally { if (active) setLoading(false); }
    })();
    return () => { active = false; };
  }, [domainId]);

  async function checkOwnership() {
    setBusy(true); setError(""); setNotice("");
    try {
      const response = await fetch(`${api}/v1/domains/${domainId}/verify`, { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: "{}" });
      const result = await response.json() as Result<{ verified: boolean; message: string; dnsVerification?: Domain["dnsVerification"] }>;
      if (!response.ok || !result.data) throw new Error(result.error?.message ?? "Could not check this domain's DNS.");
      setDomain(current => current ? { ...current, verificationStatus: result.data!.verified ? "verified" : current.verificationStatus, dnsVerification: result.data!.dnsVerification ?? current.dnsVerification } : current);
      setNotice(result.data.message);
      if (result.data.verified) setStep(3);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not check DNS."); }
    finally { setBusy(false); }
  }

  async function setupMail() {
    setBusy(true); setError(""); setNotice("");
    try {
      const response = await fetch(`${api}/v1/domains/${domainId}/mail-setup`, { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify(receivingTouched ? { receiving } : {}) });
      const result = await response.json() as Result<Setup>;
      if (!response.ok || !result.data) throw new Error(result.error?.message ?? "Could not prepare this domain's email setup.");
      setRecords(result.data.records ?? []); setDnsAutomated(Boolean(result.data.dnsAutomated)); setNotice(result.data.message);
      setReceivingMxAvailable(Boolean(result.data.receivingMxAvailable)); setDnsConflicts(result.data.conflicts ?? []);
      setReceivingMxStatus(result.data.receivingMxStatus ?? "unknown");
      setDomain(current => current ? { ...current, mailStatus: result.data!.verified || result.data!.status === "verified" ? "active" : "pending", receivingEnabled: result.data!.receivingEnabled ?? receiving } : current);
      setReceiving(result.data.receivingEnabled ?? receiving); setReceivingTouched(false);
      if ((result.data.verified || result.data.status === "verified") && (!receiving || (result.data.receivingMxAvailable && result.data.receivingMxStatus === "verified"))) setStep(4);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not prepare email setup."); }
    finally { setBusy(false); }
  }

  async function checkMail() {
    setBusy(true); setError(""); setNotice("");
    try {
      const response = await fetch(`${api}/v1/domains/${domainId}/mail-setup/verify`, { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: "{}" });
      const result = await response.json() as Result<Setup>;
      if (!response.ok || !result.data) throw new Error(result.error?.message ?? "Could not check mail DNS.");
      if (result.data.records) setRecords(result.data.records);
      if (typeof result.data.receivingMxAvailable === "boolean") setReceivingMxAvailable(result.data.receivingMxAvailable);
      setReceivingMxStatus(result.data.receivingMxStatus ?? "unknown");
      setNotice(result.data.message);
      if (result.data.verified) {
        const nextReceivingEnabled = result.data.receivingEnabled ?? domain?.receivingEnabled ?? false;
        setDomain(current => current ? { ...current, mailStatus: "active", receivingEnabled: nextReceivingEnabled } : current);
        if (!nextReceivingEnabled || (result.data.receivingMxAvailable && result.data.receivingMxStatus === "verified")) setStep(4);
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not check mail DNS."); }
    finally { setBusy(false); }
  }

  async function connectCloudflare() {
    setBusy(true); setError(""); setNotice("");
    try {
      const response = await fetch(`${api}/v1/domains/${domainId}/cloudflare/connect`, { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: "{}" });
      const result = await response.json() as Result<{ authorizationUrl: string }>;
      if (!response.ok || !result.data?.authorizationUrl) throw new Error(result.error?.message ?? "Could not start Cloudflare authorization.");
      window.location.assign(result.data.authorizationUrl);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not connect Cloudflare.");
      setBusy(false);
    }
  }

  async function copy(value: string, key: string) {
    try { await navigator.clipboard.writeText(value); setCopied(key); window.setTimeout(() => setCopied(""), 1600); }
    catch { setError("Could not copy automatically. Select the record value and copy it."); }
  }

  const activeStep = domain?.verificationStatus !== "verified" ? 2 : step === 3 || domain.mailStatus !== "active" ? 3 : 4;

  return <>
    <div className="page-heading"><div><Link className="template-back-link" href="/app/domains"><ArrowLeft size={14}/> Back to domains</Link><h1>Connect {domain?.domainName ?? "your domain"}</h1><p>We’ll walk through ownership, email delivery, and the domain identity shared by your addresses.</p></div></div>
    <section className="domain-wizard app-card">
      <nav className="domain-wizard-steps" aria-label="Domain setup progress">{steps.map((label, index) => { const number = index + 1; const complete = number < activeStep; return <div className={`domain-wizard-step${number === activeStep ? " current" : ""}${complete ? " complete" : ""}`} key={label}><span>{complete ? <Check size={14}/> : String(number).padStart(2, "0")}</span><b>{label}</b>{index < steps.length - 1 && <i/>}</div>; })}</nav>
      {error && <p className="team-notice team-error" role="alert">{error}</p>}{notice && <p className="team-notice" role="status">{notice}</p>}
      {loading ? <div className="app-loading"><span className="loading-orbit"/>Loading domain setup…</div> : domain && <>
        {step === 2 && <div className="domain-wizard-content"><div className="domain-wizard-heading"><span className="domain-wizard-icon"><ShieldCheck size={21}/></span><div><span className="usage-section-kicker">STEP 2 OF 4 · OWNERSHIP</span><h2>Prove you control this domain</h2><p>This check confirms ownership only. It does not change where your email goes.</p></div></div>
          <div className="domain-name-confirm"><Globe2 size={17}/><div><small>DOMAIN CONNECTED</small><b>{domain.domainName}</b></div><Check size={17}/></div>
          {domain.dnsVerification ? <div className="domain-wizard-record"><div className="domain-record-explainer"><b>Add one TXT record</b><p>Open your DNS provider (for example, Cloudflare), create the record below, save it, then return and check. DNS changes can take a few minutes to appear.</p></div><dl className="dns-record-grid"><dt>Type</dt><dd>TXT</dd><dt>Name / host</dt><dd><code>{domain.dnsVerification.name}</code><span className="dns-muted">Full name checked: {domain.dnsVerification.hostname}</span></dd><dt>Value</dt><dd><code className="dns-value">{domain.dnsVerification.value}</code><button className="copy-button" type="button" onClick={() => void copy(domain.dnsVerification!.value, "verify")}>{copied === "verify" ? "Copied" : <><Copy size={12}/> Copy value</>}</button></dd></dl></div> : <div className="domain-wizard-record"><p>We’ll create a TXT verification record now. It’s separate from your mail routing.</p></div>}
          <div className="domain-wizard-actions"><button className="button" disabled={busy} onClick={() => void checkOwnership()}>{busy ? "Checking DNS…" : "I’ve added the record — check DNS"}<ArrowRight size={15}/></button></div>
        </div>}
        {step === 3 && <div className="domain-wizard-content"><div className="domain-wizard-heading"><span className="domain-wizard-icon"><MailCheck size={21}/></span><div><span className="usage-section-kicker">STEP 3 OF 4 · DELIVERY</span><h2>Choose how this domain handles mail</h2><p>Sending and receiving are separate capabilities. You can start with sending and enable receiving when you’re ready.</p></div></div>
          <div className="domain-capability-card"><span className="domain-capability-icon"><ArrowRight size={16}/></span><div><b>Send from addresses on this domain</b><p>Widesip prepares SPF and DKIM records so mail providers can authenticate mail sent by your addresses. This does not route incoming mail.</p><span className="domain-capability-status"><Check size={12}/> Included</span></div></div>
          <label className="domain-receiving-choice"><input type="checkbox" checked={receiving} onChange={event => { setReceiving(event.target.checked); setReceivingTouched(true); }}/><span><b>Also receive incoming mail in Widesip</b><small>Receiving uses MX records. They control inbound routing for the domain; changing existing MX records can interrupt Google Workspace or another mail provider.</small></span></label>
          {receiving && <div className="domain-mx-warning"><CircleAlert size={17}/><p><b>Check your current MX records first.</b> If this domain already receives mail elsewhere, use a dedicated subdomain for Widesip or prepare to replace its root MX records. Widesip will leave existing routes unchanged and tell you what needs action.</p></div>}
          <div className="domain-automation-note"><Waypoints size={15}/><p>{dnsAutomated ? `DNS automation is active for ${cloudflare?.zoneName ?? "the connected Cloudflare zone"}.` : "Add the displayed records at your DNS provider. Existing conflicting mail routes are left untouched."} {cloudflare?.connected ? "Cloudflare is linked to this organization." : "Connect Cloudflare to add compatible DNS records automatically."}</p></div>
          {!cloudflare?.connected && cloudflare?.configured && cloudflare.canManage && <div className="domain-wizard-actions"><button className="button secondary" type="button" disabled={busy} onClick={() => void connectCloudflare()}>{busy ? "Connecting…" : "Connect Cloudflare"}<ArrowRight size={15}/></button></div>}
          {records.length > 0 && <div className="sending-records"><b>{dnsAutomated ? (dnsConflicts.length ? "DNS records applied or needing action" : "DNS records applied by Widesip") : "DNS records to add"}</b><p>{receiving ? (receivingMxAvailable ? "Includes Resend's receiving MX. Check the status below before changing existing MX records." : "Sending records are available. Resend has not supplied the receiving MX yet, so incoming mail is not routed to Widesip.") : "These records authenticate sending. Incoming routing stays with your current mail provider."}</p><div className="table-wrap"><table className="table"><thead><tr><th>Type</th><th>Name / host</th><th>Value</th></tr></thead><tbody>{records.map((record,index)=><tr key={`${record.type}-${record.name}-${index}`}><td>{record.type}{record.type.toUpperCase()==="MX"&&record.priority!=null?` · ${record.priority}`:""}</td><td><code>{record.name}</code></td><td><code>{record.value}</code></td></tr>)}</tbody></table></div></div>}
            {receiving && !receivingMxAvailable && <div className="domain-mx-warning" role="status"><CircleAlert size={17}/><p><b>Receiving is not ready yet.</b> Resend has not returned the receiving MX record for this domain. Widesip cannot route incoming mail until that record is available.</p></div>}
            {receiving && receivingMxAvailable && dnsConflicts.some(record => record.type.toUpperCase() === "MX") && <div className="domain-mx-warning" role="status"><CircleAlert size={17}/><p><b>Incoming mail has not been switched yet.</b> Existing root MX records were left unchanged. To route all mail for this domain to Widesip, replace those records with the exact MX record shown above. This will stop the previous mail routing.</p></div>}
            {receiving && receivingMxAvailable && !dnsConflicts.some(record => record.type.toUpperCase() === "MX") && <div className="domain-webhook-guide"><b>{receivingMxStatus === "verified" ? "Receiving MX is verified" : "Receiving MX is waiting for DNS verification"}</b><p>{receivingMxStatus === "verified" ? "Resend has confirmed the receiving route. Incoming messages can now be delivered to Widesip." : "The required MX record is shown above. Add it at your DNS provider, replacing existing root MX records if you want all mail for this domain routed to Widesip, then select Check mail DNS."}</p></div>}
          <div className="domain-wizard-actions"><button className="button" disabled={busy} onClick={() => void setupMail()}>{busy ? "Preparing records…" : records.length ? "Refresh records and status" : "Prepare email setup"}<ArrowRight size={15}/></button>{records.length > 0 && <button className="button secondary" disabled={busy} onClick={() => void checkMail()}><RefreshCw size={14}/> Check mail DNS</button>}</div>
        </div>}
        {step === 4 && <div className="domain-wizard-content"><div className="domain-wizard-heading"><span className="domain-wizard-icon"><Palette size={21}/></span><div><span className="usage-section-kicker">STEP 4 OF 4 · DOMAIN IDENTITY</span><h2>Give this domain one shared identity</h2><p>Set the profile image and brand once. Widesip uses it across addresses on this domain and in campaign design.</p></div></div>
          <div className="domain-profile-summary"><span className="domain-profile-mark"><ShieldCheck size={18}/></span><div><b>{domain.domainName} is connected</b><p>Ownership verified · sending {domain.mailStatus === "active" ? "ready" : "checking"} · receiving {domain.receivingEnabled ? "enabled" : "not enabled"}</p></div></div>
          <p className="domain-profile-explainer">Upload a square logo or company image, choose the accent color, and watch the desktop and mobile email previews update as you edit. Images are hosted by Widesip for use in campaign emails.</p>
          <div className="domain-wizard-actions"><Link className="button" href={`/app/domains/${domain.id}/template`}>Create domain profile <ArrowRight size={15}/></Link><Link className="button secondary" href="/app/mailboxes">Create addresses <ArrowRight size={15}/></Link></div>
        </div>}
      </>}
    </section>
  </>;
}
