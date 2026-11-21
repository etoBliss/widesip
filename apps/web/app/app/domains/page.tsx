"use client";

import { useEffect, useState } from "react";
import { Check, ChevronDown, Copy, Globe2, MoreHorizontal, RefreshCw } from "lucide-react";
import { AppShell } from "@/components/app-shell";

const api = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
type DnsVerification = { type: "TXT"; name: string; hostname: string; value: string; expiresAt: string; status: "pending" | "verified" };
type Domain = { id: string; domainName: string; verificationStatus: string; mailStatus: string; receivingEnabled?: boolean; createdAt: string; dnsVerification: DnsVerification | null };
type ApiResult<T> = { success: boolean; data?: T; error?: { message?: string } };

export default function DomainsPage() {
  const [rows, setRows] = useState<Domain[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [checkingId, setCheckingId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState("");
  const [messages, setMessages] = useState<Record<string, string>>({});
  const [copiedId, setCopiedId] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    async function loadDomains() {
      setLoading(true); setError("");
      try {
        let workspaceId = localStorage.getItem("widesip.workspace");
        if (!workspaceId) {
          const response = await fetch(`${api}/v1/workspaces`, { credentials: "include" });
          const result = await response.json() as ApiResult<Array<{ id: string }>>;
          if (!response.ok) throw new Error(result.error?.message ?? "Could not load your workspace.");
          workspaceId = result.data?.[0]?.id ?? null;
          if (workspaceId) localStorage.setItem("widesip.workspace", workspaceId);
        }
        if (!workspaceId) throw new Error("Create a workspace before adding domains.");
        const response = await fetch(`${api}/v1/domains?workspaceId=${encodeURIComponent(workspaceId)}`, { credentials: "include" });
        const result = await response.json() as ApiResult<Domain[]>;
        if (!response.ok) throw new Error(result.error?.message ?? "Could not load domains.");
        if (active) {
          setRows(result.data ?? []);
          const requested = new URLSearchParams(window.location.search).get("expand");
          if (requested && result.data?.some(domain => domain.id === requested)) setExpandedId(requested);
        }
      } catch (cause) { if (active) setError(cause instanceof Error ? cause.message : "Could not load domains."); }
      finally { if (active) setLoading(false); }
    }
    void loadDomains();
    return () => { active = false; };
  }, []);

  async function checkDns(domain: Domain) {
    setCheckingId(domain.id); setMessages(current => ({ ...current, [domain.id]: "Checking DNS…" }));
    try {
      const response = await fetch(`${api}/v1/domains/${domain.id}/verify`, { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: "{}" });
      const result = await response.json() as ApiResult<{ verified: boolean; message: string; dnsVerification?: DnsVerification }>;
      if (!response.ok || !result.data) throw new Error(result.error?.message ?? "Could not check the DNS record.");
      setRows(current => current.map(row => row.id === domain.id ? { ...row, verificationStatus: result.data!.verified ? "verified" : row.verificationStatus, dnsVerification: result.data!.dnsVerification ?? row.dnsVerification } : row));
      setMessages(current => ({ ...current, [domain.id]: result.data!.message }));
    } catch (cause) {
      setMessages(current => ({ ...current, [domain.id]: cause instanceof Error ? cause.message : "Could not check the DNS record." }));
    } finally { setCheckingId(null); }
  }

  async function copyRecord(domainId: string, value: string) {
    try { await navigator.clipboard.writeText(value); setCopiedId(domainId); window.setTimeout(() => setCopiedId(null), 1800); }
    catch { setMessages(current => ({ ...current, [domainId]: "Select and copy the TXT value manually." })); }
  }

  return <AppShell>
    <div className="page-heading domains-page-heading"><div><h1>Domains</h1><p>Connect a domain and check its DNS records.</p></div><a className="button" href="/app/domains/new">＋ &nbsp;Add domain</a></div>
    {error && <p className="auth-error" role="alert">{error}</p>}
    <section className="app-card domain-list-card" aria-label="Connected domains">
      {loading ? <div className="domain-list-empty"><RefreshCw size={16} className="mail-spinner"/>Loading domains…</div> : !rows.length ? <div className="domain-list-empty"><span className="domain-empty-icon"><Globe2 size={20}/></span><b>No domains connected</b><p>Add a domain you own to get its DNS verification record.</p><a className="button" href="/app/domains/new">Add domain</a></div> : <div className="domain-list">{rows.map(domain => {
        const verified = domain.verificationStatus === "verified";
        const expanded = expandedId === domain.id;
        return <article className={`domain-accordion${expanded ? " expanded" : ""}`} key={domain.id}>
          <div className="domain-accordion-head"><button className="domain-accordion-trigger" type="button" aria-expanded={expanded} onClick={() => setExpandedId(current => current === domain.id ? "" : domain.id)}><ChevronDown size={15} className="domain-expand-chevron"/><span className="domain-row-icon"><Globe2 size={16}/></span><span className="domain-row-copy"><b>{domain.domainName}</b></span><span className={`domain-verify-pill${verified ? " verified" : ""}`}>{verified && <Check size={12}/>} {verified ? "Verified" : "Pending"}</span><span className={`domain-verify-pill${domain.mailStatus === "active" ? " verified" : ""}`}>{domain.mailStatus === "active" ? "Sending ready" : verified ? "Sending setup needed" : "Sending locked"}</span></button><details className="domain-row-menu"><summary aria-label={`Actions for ${domain.domainName}`}><MoreHorizontal size={18}/></summary><div role="menu"><a role="menuitem" href={`/app/domains/${domain.id}/template`}>Edit domain profile</a><a role="menuitem" href={`/app/domains/${domain.id}/setup`}>{domain.mailStatus === "active" ? "Sending setup" : "Set up sending"}</a></div></details></div>
          {expanded && <div className="domain-dns-details"><div className="domain-dns-title"><div><p>{verified ? "Ownership check" : "Add this record at your DNS provider, then refresh the check."}</p></div><button className="button secondary" type="button" onClick={() => void checkDns(domain)} disabled={checkingId === domain.id}><RefreshCw size={14} className={checkingId === domain.id ? "mail-spinner" : undefined}/>{checkingId === domain.id ? "Checking…" : "Refresh status"}</button></div>
            {domain.dnsVerification ? <div className="table-wrap domain-dns-table-wrap"><table className="table domain-dns-table"><thead><tr><th>Type</th><th>Name</th><th>Content</th><th>TTL</th><th>Status</th></tr></thead><tbody><tr><td>TXT</td><td><code>{domain.dnsVerification.name}</code><small>{domain.dnsVerification.hostname}</small></td><td><code className="domain-dns-value">{domain.dnsVerification.value}</code><button className="copy-button" type="button" onClick={() => void copyRecord(domain.id, domain.dnsVerification!.value)}>{copiedId === domain.id ? "Copied" : <Copy size={12}/>}</button></td><td>Auto</td><td><span className={`badge ${verified ? "verified" : ""}`}>{verified ? "Verified" : "Pending"}</span></td></tr></tbody></table></div> : <p className="domain-dns-missing">No verification record is available yet. Refresh to create or renew it.</p>}
            {messages[domain.id] && <p className="dns-message" role="status">{messages[domain.id]}</p>}
          </div>}
        </article>;
      })}</div>}
    </section>
  </AppShell>;
}
