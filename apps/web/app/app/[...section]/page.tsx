import Link from "next/link";
import { ArrowRight, Clock3, Layers3, ShieldCheck, Sparkles } from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { UsageBilling } from "@/components/usage-billing";
import { SettingsPage } from "@/components/settings-page";
import { InvitationsPage } from "@/components/invitations-page";
import { ProfilePage } from "@/components/profile-page";
import { DomainTemplatePage } from "@/components/domain-template-page";
import { DomainSetupWizard } from "@/components/domain-setup-wizard";
import { CampaignMessagePage } from "@/components/campaign-message-page";

const modules: Record<string, { title: string; description: string; stage: string; icon: "mail" | "team" | "default"; steps: string[] }> = {
  mail: { title: "A clearer home for every conversation.", description: "The unified inbox is part of the Widesip roadmap. We’re building the domain, identity and access foundations it depends on first.", stage: "Planned", icon: "mail", steps: ["Connect and verify a domain", "Create mailboxes and identities", "Bring conversations into one inbox"] },
  mailboxes: { title: "Create addresses with confidence.", description: "Mailbox provisioning will follow domain verification and provider setup. You can prepare your workspace while this capability is in development.", stage: "In development", icon: "default", steps: ["Verify domain ownership", "Configure mail authentication", "Provision and manage mailboxes"] },
  aliases: { title: "More ways to reach the right inbox.", description: "Aliases will let you use additional addresses that route into an existing mailbox, without managing another separate inbox.", stage: "Planned", icon: "default", steps: ["Create an active mailbox", "Add an alias address", "Choose where messages should go"] },
  contacts: { title: "Keep important people close at hand.", description: "Contact management will support everyday correspondence first, with lists and segments added when campaign tools are ready.", stage: "Planned", icon: "default", steps: ["Save contacts in your workspace", "Organize contacts into groups", "Use contacts across workflows"] },
  campaigns: { title: "Campaigns, with the right safeguards.", description: "Campaign delivery will be built separately from one-to-one correspondence, with unsubscribe and suppression controls from the start.", stage: "Later release", icon: "default", steps: ["Build and review a campaign", "Manage consent and suppression", "Track delivery and engagement"] },
  team: { title: "Give teammates the access they need.", description: "Team invitations, roles and shared mailbox permissions are planned for organization workspaces after the membership model is complete.", stage: "Planned", icon: "team", steps: ["Invite a teammate", "Choose a workspace role", "Assign mailbox access"] },
  billing: { title: "Understand usage before you scale.", description: "Plan and usage details will be published after mail provider capacity and operating costs have been validated.", stage: "Not configured", icon: "default", steps: ["Choose a plan that fits", "See domains, mailboxes and storage", "Review sending limits and usage"] },
  settings: { title: "Your workspace, set up your way.", description: "Workspace settings are being connected to account preferences and organization controls. For now, you can manage your workspace name during setup.", stage: "In development", icon: "default", steps: ["Update workspace details", "Manage members and access", "Review security preferences"] },
};

export default async function AppSection({ params }: { params: Promise<{ section: string[] }> }) {
  const { section = [] } = await params;
  const key = section[0] ?? "overview";
  const module = modules[key];
  const title = module ? key === "billing" ? "Usage & billing" : key.charAt(0).toUpperCase() + key.slice(1) : "Page not found";
  if (key === "billing") return <AppShell><UsageBilling/></AppShell>;
  if (key === "settings") return <AppShell><SettingsPage/></AppShell>;
  if (key === "profile") return <AppShell><ProfilePage/></AppShell>;
  if (key === "team" && section[1] === "invitations") return <InvitationsPage/>;
  if (key === "campaigns" && section[1]) return <CampaignMessagePage campaignId={section[1]}/>;
  if (key === "domains" && section[1] && section[2] === "template") return <AppShell><DomainTemplatePage domainId={section[1]}/></AppShell>;
  if (key === "domains" && section[1] && section[2] === "setup") return <AppShell><DomainSetupWizard domainId={section[1]}/></AppShell>;
  return <AppShell><div className="page-heading"><div><h1 className="module-page-title">{title}</h1><p>{module ? "A Widesip capability, taking shape in clear steps." : "We couldn’t find that workspace section."}</p></div></div>
    {module ? <section className="module-panel app-card"><div className="module-panel-main"><span className="module-icon">{module.icon === "team" ? <ShieldCheck size={19}/> : module.icon === "mail" ? <Layers3 size={19}/> : <Sparkles size={19}/>}</span><span className="module-stage"><Clock3 size={12}/>{module.stage}</span><h2>{module.title}</h2><p>{module.description}</p><Link className="button" href="/app/domains">Continue with domains <ArrowRight size={15}/></Link></div><aside className="module-roadmap">{module.steps.map((step, index) => <div className="roadmap-step" key={step}><span>{String(index + 1).padStart(2, "0")}</span><p>{step}</p></div>)}</aside></section> : <section className="app-card"><p className="empty">This page isn’t available. <Link href="/app">Return to your overview →</Link></p></section>}
  </AppShell>;
}
