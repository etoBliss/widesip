"use client";

import { useEffect, useState } from "react";
import { Activity, ArrowRight, AtSign, BadgeCheck, CreditCard, Database, Globe2, Inbox, Mail, MailPlus, Megaphone, UsersRound } from "lucide-react";

const api = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
type Usage = {
  workspace: { id: string; role: string };
  period: { start: string; end: string };
  billing: { configured: boolean; plan: string; status: string };
  resources: { domains: { total: number; verified: number }; mailboxes: number; aliases: number; contacts: number; campaigns: number; teamSeats: number };
  mail: { stored: number; received: number; sent: number; sentThisMonth: number; oneToOneSentThisMonth: number; campaignRecipientsThisMonth: number };
  limits: null | Record<string, number>;
};
type Result<T> = { data?: T; error?: { message?: string } };
const number = new Intl.NumberFormat();

function formattedPeriod(start: string, end: string) {
  const first = new Date(start);
  const last = new Date(new Date(end).getTime() - 1);
  const month = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric", timeZone: "UTC" }).format(first);
  const through = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", timeZone: "UTC" }).format(last);
  return `${month} · through ${through}`;
}

export function UsageBilling() {
  const [usage, setUsage] = useState<Usage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    async function load() {
      try {
        const workspaceId = localStorage.getItem("widesip.workspace") ?? "";
        if (!workspaceId) throw new Error("Select a workspace first.");
        const response = await fetch(`${api}/v1/usage?workspaceId=${encodeURIComponent(workspaceId)}`, { credentials: "include" });
        const result = await response.json() as Result<Usage>;
        if (!response.ok || !result.data) throw new Error(result.error?.message ?? "Could not load usage for this workspace.");
        if (active) setUsage(result.data);
      } catch (cause) {
        if (active) setError(cause instanceof Error ? cause.message : "Could not load usage for this workspace.");
      } finally { if (active) setLoading(false); }
    }
    void load();
    return () => { active = false; };
  }, []);

  const resources = usage ? [
    { label: "Domains", value: usage.resources.domains.total, detail: `${number.format(usage.resources.domains.verified)} verified`, icon: Globe2, tone: "blue" },
    { label: "Email addresses", value: usage.resources.mailboxes, detail: `${number.format(usage.resources.aliases)} aliases`, icon: Mail, tone: "mint" },
    { label: "Inbox messages", value: usage.mail.stored, detail: `${number.format(usage.mail.received)} received · ${number.format(usage.mail.sent)} sent`, icon: Inbox, tone: "violet" },
    { label: "Contacts", value: usage.resources.contacts, detail: "Stored in this workspace", icon: UsersRound, tone: "peach" },
    { label: "Campaigns", value: usage.resources.campaigns, detail: "Drafts, schedules, and sends", icon: Megaphone, tone: "blue" },
    { label: "Team seats", value: usage.resources.teamSeats, detail: "Current workspace members", icon: Activity, tone: "mint" },
  ] : [];
  const shortcuts = [
    { label: "Domains", detail: "Verify and configure domains", href: "/app/domains", icon: Globe2 },
    { label: "Email addresses", detail: "Create and assign addresses", href: "/app/mailboxes", icon: AtSign },
    { label: "Team", detail: "Manage members and invitations", href: "/app/team", icon: UsersRound },
    { label: "Contacts & campaigns", detail: "Manage your audience", href: "/app/contacts", icon: MailPlus },
  ];

  if (loading) return <><div className="page-heading"><div><h1>Usage &amp; billing</h1><p>See what this workspace is using and understand the current billing status.</p></div></div><section className="app-card usage-loading"><span className="loading-orbit"/> Loading workspace usage…</section></>;
  if (error || !usage) return <><div className="page-heading"><div><h1>Usage &amp; billing</h1><p>See what this workspace is using and understand the current billing status.</p></div></div><section className="app-card"><p className="team-notice team-error" role="alert">{error || "Usage is unavailable."}</p><p className="usage-permission-note">Usage details are available to workspace owners and admins. Switch to your personal space or ask an organization admin for billing access.</p></section></>;

  return <>
    <div className="page-heading usage-heading"><div><h1>Usage &amp; billing</h1><p>Your workspace snapshot, usage this period, and current billing status.</p></div><span className="usage-preview-chip"><i/> Preview</span></div>
    <section className="usage-billing-banner app-card"><div className="usage-banner-icon"><CreditCard size={19}/></div><div className="usage-banner-copy"><span className="usage-section-kicker">CURRENT PLAN</span><h2>{usage.billing.plan}</h2><p>Widesip does not have a paid subscription or payment method connected for this workspace in the current build.</p></div><span className="usage-unconfigured"><i/> {usage.billing.status}</span></section>

    <section className="usage-highlight-grid" aria-label="Current period usage">
      <article className="usage-highlight app-card"><div className="usage-highlight-top"><span className="usage-highlight-icon blue"><Activity size={17}/></span><span className="usage-period-label">THIS PERIOD</span></div><strong>{number.format(usage.mail.sentThisMonth)}</strong><b>Emails sent</b><small>{number.format(usage.mail.oneToOneSentThisMonth)} one-to-one · {number.format(usage.mail.campaignRecipientsThisMonth)} campaign recipients</small></article>
      <article className="usage-highlight app-card"><div className="usage-highlight-top"><span className="usage-highlight-icon violet"><Database size={17}/></span><span className="usage-period-label">STORED</span></div><strong>{number.format(usage.mail.stored)}</strong><b>Inbox messages</b><small>Inbound and one-to-one messages saved in this workspace.</small></article>
      <article className="usage-highlight app-card"><div className="usage-highlight-top"><span className="usage-highlight-icon mint"><BadgeCheck size={17}/></span><span className="usage-period-label">DOMAIN SETUP</span></div><strong>{number.format(usage.resources.domains.verified)}<em> / {number.format(usage.resources.domains.total)}</em></strong><b>Verified domains</b><small>Domains verified for workspace ownership.</small></article>
    </section>

    <section className="app-card usage-resource-card"><div className="usage-card-heading"><div><span className="usage-section-kicker">WORKSPACE FOOTPRINT</span><h2>Resources in use</h2><p>Current totals for the workspace and this billing period.</p></div><span className="usage-resource-count">{resources.length} categories</span></div>
      <div className="usage-resource-grid">{resources.map(({ label, value, detail, icon: Icon, tone }) => <article className="usage-resource" key={label}><span className={`usage-resource-icon tone-${tone}`}><Icon size={16}/></span><div className="usage-resource-main"><span>{label}</span><small>{detail}</small></div><strong>{number.format(value)}</strong></article>)}</div>
    </section>

    <section className="app-card usage-shortcuts"><div className="usage-card-heading"><div><span className="usage-section-kicker">WORKSPACE HOME</span><h2>Pick up where you left off</h2><p>Go directly to the areas that make up this workspace.</p></div></div><div className="usage-shortcut-grid">{shortcuts.map(({ label, detail, href, icon: Icon }) => <a className="usage-shortcut" href={href} key={label}><span><Icon size={16}/></span><div><b>{label}</b><small>{detail}</small></div><ArrowRight size={14}/></a>)}</div></section>

    <section className="usage-period-note"><span><Activity size={15}/></span><p><b>Usage period: {formattedPeriod(usage.period.start, usage.period.end)}.</b> Email totals count Widesip’s saved messages and campaign recipients accepted for delivery. No pricing limits or charges are being calculated yet.</p></section>
    <section className="usage-billing-foot app-card"><div><span className="usage-footer-icon"><CreditCard size={16}/></span><div><b>Billing is not connected yet</b><p>Plans, invoices, and payment methods will appear here when Widesip’s billing provider is configured.</p></div></div><a href="/app/settings" className="inline-link">Workspace settings <ArrowRight size={14}/></a></section>
  </>;
}
