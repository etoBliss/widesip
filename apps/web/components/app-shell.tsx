"use client";

import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { AtSign, ArrowRight, ChevronDown, Contact, CreditCard, Globe2, Inbox, LockKeyhole, LogOut, MailCheck, MailPlus, Megaphone, Menu, Settings2, UserRound, UsersRound } from "lucide-react";
import { StyledSelect } from "@/components/styled-select";
import "@/app/app/team/restricted-page.css";

type NavItem = { label: string; href: string; icon: LucideIcon; children?: NavItem[] };
const navGroups: { label: string; items: NavItem[] }[] = [
  { label: "EMAIL & AUDIENCE", items: [
    { label: "Inbox", href: "/app/mail", icon: Inbox },
    { label: "Addresses", href: "/app/mailboxes", icon: MailPlus },
    { label: "Aliases", href: "/app/aliases", icon: AtSign },
    { label: "Contacts", href: "/app/contacts", icon: Contact },
    { label: "Campaigns", href: "/app/campaigns", icon: Megaphone },
  ] },
  { label: "DOMAIN & PEOPLE", items: [
    { label: "Domains", href: "/app/domains", icon: Globe2 },
    { label: "Team", href: "/app/team", icon: UsersRound, children: [{ label: "Invitations", href: "/app/team/invitations", icon: MailCheck }] },
  ] },
  { label: "PREFERENCES", items: [
    { label: "Usage & billing", href: "/app/billing", icon: CreditCard },
    { label: "Settings", href: "/app/settings", icon: Settings2 },
  ] },
];
type Workspace = { id: string; name: string; type: string; role: string; hasVerifiedDomain?: boolean };
type AccountUser = { name?: string; email?: string; image?: string | null };
const api = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
function selectableWorkspaces(rows: Workspace[]) {
  const teamWorkspaces = rows.filter(row => row.type === "organization");
  return teamWorkspaces.length ? teamWorkspaces : rows;
}

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [ready, setReady] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [accountUser, setAccountUser] = useState<AccountUser | null>(null);
  const [accountUserReady, setAccountUserReady] = useState(false);
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const [refreshingWorkspaces, setRefreshingWorkspaces] = useState(false);
  const [workspaceListError, setWorkspaceListError] = useState("");
  const [signingOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState("");
  const accountMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let active = true;
    fetch(`${api}/v1/workspaces`, { credentials: "include" })
      .then(async (response) => {
        if (response.status === 401) { router.replace("/sign-in"); return null; }
        if (response.status === 403) {
          const returnTo = pathname.startsWith("/app/") ? pathname : "/app";
          router.replace(`/onboarding?next=${encodeURIComponent(returnTo)}`);
          return null;
        }
        if (!response.ok) throw new Error("Could not load your workspaces. Check the API connection.");
        const result = await response.json();
        return result.data as Workspace[];
      })
      .then((rows) => {
        if (!active || !rows) return;
        if (!rows.length) { router.replace("/onboarding"); return; }
        const selectable = selectableWorkspaces(rows);
        setWorkspaces(selectable);
        const saved = localStorage.getItem("widesip.workspace");
        const current = selectable.find((row) => row.id === saved) ?? selectable[0];
        localStorage.setItem("widesip.workspace", current.id);
        setWorkspace(current);
        setReady(true);
      })
      .catch((cause) => {
        if (active) { setLoadError(cause instanceof Error ? cause.message : "Could not load your workspace."); setReady(true); }
      });
    return () => { active = false; };
  }, [router]);

  useEffect(() => {
    let active = true;
    fetch(`${api}/api/auth/get-session`, { credentials: "include" })
      .then(response => response.ok ? response.json() : null)
      .then(result => { if (active) { setAccountUser(result?.user ?? null); setAccountUserReady(true); } })
      .catch(() => { if (active) { setAccountUser(null); setAccountUserReady(true); } });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    setAccountMenuOpen(false);
  }, [pathname]);

  useEffect(() => {
    const openMenu = () => { setAccountMenuOpen(true); setWorkspaceListError(""); };
    window.addEventListener("widesip:open-account-menu", openMenu);
    return () => window.removeEventListener("widesip:open-account-menu", openMenu);
  }, []);

  // Memberships may be accepted or changed in another browser tab while this
  // app remains open. Refresh the selectable workspaces whenever the menu opens.
  useEffect(() => {
    if (!accountMenuOpen) return;
    let active = true;
    setRefreshingWorkspaces(true);
    setWorkspaceListError("");
    fetch(`${api}/v1/workspaces`, { credentials: "include", cache: "no-store" })
      .then(async response => {
        if (response.status === 401) { router.replace("/sign-in"); return null; }
        if (!response.ok) throw new Error("Could not refresh your workspace list.");
        const result = await response.json();
        return result.data as Workspace[];
      })
      .then(rows => {
        if (!active || !rows) return;
        const selectable = selectableWorkspaces(rows);
        setWorkspaces(selectable);
        const savedId = localStorage.getItem("widesip.workspace");
        const current = selectable.find(row => row.id === savedId) ?? selectable[0];
        if (current) {
          localStorage.setItem("widesip.workspace", current.id);
          setWorkspace(current);
        }
      })
      .catch(cause => { if (active) setWorkspaceListError(cause instanceof Error ? cause.message : "Could not refresh your workspace list."); })
      .finally(() => { if (active) setRefreshingWorkspaces(false); });
    return () => { active = false; };
  }, [accountMenuOpen, router]);

  useEffect(() => {
    if (!accountMenuOpen) return;
    function closeMenu(event: PointerEvent) {
      const target = event.target;
      // StyledSelect renders its listbox in a portal under document.body. Treat
      // clicks in that listbox as part of this menu so switching still works.
      if (target instanceof Element && target.closest(".styled-select-popover")) return;
      if (!accountMenuRef.current?.contains(target as Node)) setAccountMenuOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setAccountMenuOpen(false);
    }
    document.addEventListener("pointerdown", closeMenu);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", closeMenu);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [accountMenuOpen]);

  useEffect(() => {
    function onWorkspaceUpdated(event: Event) {
      const detail = (event as CustomEvent<{ id: string; name: string }>).detail;
      if (!detail?.id || !detail.name) return;
      setWorkspaces(current => current.map(row => row.id === detail.id ? { ...row, name: detail.name } : row));
      setWorkspace(current => current?.id === detail.id ? { ...current, name: detail.name } : current);
    }
    window.addEventListener("widesip:workspace-updated", onWorkspaceUpdated);
    return () => window.removeEventListener("widesip:workspace-updated", onWorkspaceUpdated);
  }, []);

  useEffect(() => {
    function onAccountUpdated(event: Event) {
      const detail = (event as CustomEvent<AccountUser>).detail;
      if (detail) setAccountUser(current => ({ ...current, ...detail }));
    }
    window.addEventListener("widesip:account-updated", onAccountUpdated);
    return () => window.removeEventListener("widesip:account-updated", onAccountUpdated);
  }, []);

  function changeWorkspace(id: string) {
    const selected = workspaces.find((row) => row.id === id);
    if (!selected || selected.id === workspace?.id) return;
    setWorkspace(selected);
    localStorage.setItem("widesip.workspace", id);
    setAccountMenuOpen(false);
    // Navigate to a page every workspace can open, and remount its page state
    // below so each screen reloads data from the newly selected workspace.
    router.replace("/app/mail");
  }
  async function signOut() {
    setSigningOut(true); setSignOutError("");
    try {
      const response = await fetch(`${api}/api/auth/sign-out`, { method: "POST", credentials: "include" });
      if (!response.ok) throw new Error("Could not sign out. Please try again.");
      localStorage.removeItem("widesip.workspace");
      router.replace("/sign-in");
      router.refresh();
    } catch (cause) {
      setSignOutError(cause instanceof Error ? cause.message : "Could not sign out. Please try again.");
      setSigningOut(false);
    }
  }
  function isActive(href: string) {
    return href === "/app" ? pathname === href : pathname === href || pathname.startsWith(`${href}/`);
  }
  const workspaceReady = ready && workspace !== null;
  const allNavItems = navGroups.flatMap(group => group.items.flatMap(item => [item, ...(item.children ?? [])]));
  const currentPage = !workspaceReady ? "Workspace" : pathname === "/app/domains/new" ? "Add domain" : allNavItems.find(item => pathname === item.href)?.label ?? allNavItems.filter(item => pathname.startsWith(`${item.href}/`)).sort((a, b) => b.href.length - a.href.length)[0]?.label ?? "Workspace";
  const memberLimited = workspace?.type === "organization" && workspace.role === "member";
  const organizationWorkspace = workspace?.type === "organization";
  const personalWorkspace = workspace?.type === "personal";
  const hasTeamWorkspace = workspaces.some(row => row.type === "organization");
  const personalNeedsTeam = personalWorkspace && !hasTeamWorkspace;
  const organizationNeedsDomain = organizationWorkspace && workspace.hasVerifiedDomain === false;
  const personalName = accountUser?.name?.trim() || "Your space";
  const workspaceLabel = workspace?.type === "personal" ? personalName : workspace?.name ?? "Widesip";
  const visibleGroups = !workspaceReady ? [] : memberLimited
    ? [
        { label: "EMAIL & AUDIENCE", items: navGroups[0].items.filter(item => ["Inbox", "Addresses", "Contacts", "Campaigns"].includes(item.label)) },
        { label: "TEAM", items: navGroups[1].items.filter(item => item.label === "Team") },
      ]
    : organizationWorkspace
      ? [navGroups[0], navGroups[1], { ...navGroups[2], items: navGroups[2].items.filter(item => item.label === "Usage & billing") }]
      : personalNeedsTeam
        ? [{ label: "TEAM", items: navGroups[1].items.filter(item => item.label === "Team") }]
        : personalWorkspace
        ? [{ label: "TEAM", items: navGroups[1].items.filter(item => item.label === "Team") }]
        : navGroups;
  const memberAllowedPaths = ["/app/mail", "/app/mailboxes", "/app/contacts", "/app/campaigns", "/app/profile", "/app/settings", "/app/team", "/app/team/invitations"];
  const personalAllowedPaths = ["/app/profile", "/app/settings", "/app/team", "/app/team/invitations"];
  const personalTeamDashboard = workspace?.type === "personal" && pathname === "/app/team";
  const restrictedForMember = (memberLimited && !memberAllowedPaths.some(path => pathname === path || pathname.startsWith(`${path}/`)))
    || (personalWorkspace && pathname.startsWith("/app/billing"))
    || (personalWorkspace && !personalAllowedPaths.some(path => pathname === path || pathname.startsWith(`${path}/`)));
  const accountOnlyRoute = ["/app/profile", "/app/settings", "/app/team/invitations"].some(path => pathname === path || pathname.startsWith(`${path}/`));
  const mustFinishDomainSetup = organizationNeedsDomain && !accountOnlyRoute;
  useEffect(() => {
    if (!ready || !mustFinishDomainSetup || pathname === "/app/domains" || pathname.startsWith("/app/domains/")) return;
    router.replace("/app/domains");
  }, [ready, mustFinishDomainSetup, pathname, router]);
  const restrictionCopy = personalNeedsTeam
    ? "Join a team workspace to access this page. You can review and accept invitations from the Team section."
    : personalWorkspace
      ? "Your personal space is limited to team access and account settings. Choose an organization workspace from the profile menu to use Widesip features."
    : pathname.startsWith("/app/billing")
      ? "Usage and billing are only available in an organization workspace."
    : "Your role in this workspace does not include this page. Ask a workspace owner or admin if you need access.";
  function renderNavItem(item: NavItem) {
    const Icon = item.icon;
    const parentVisible = true;
    const active = item.children?.length ? pathname === item.href || item.children.some(child => isActive(child.href)) : isActive(item.href);
    return <div className="app-nav-entry" key={item.href}>{parentVisible && <Link className={`app-nav-item${active ? " active" : ""}`} aria-current={active ? "page" : undefined} href={item.href}><Icon size={16} strokeWidth={1.8}/><span>{item.label}</span>{active && <i className="nav-active-indicator"/>}</Link>}
      {item.children?.length && <div className={`app-nav-subitems${active ? " open" : ""}`}>{item.children.map(child => { const ChildIcon = child.icon; const childActive = isActive(child.href); return <Link key={child.href} className={`app-nav-subitem${childActive ? " active" : ""}`} aria-current={childActive ? "page" : undefined} href={child.href}><ChildIcon size={14}/><span>{child.label}</span></Link>; })}</div>}
    </div>;
  }

  return <div className="app-shell">
    <aside className="app-side">
      <Link className="brand app-brand" href="/"><span className="mark">w</span><span>widesip</span></Link>
      <nav className="app-nav" aria-label="Workspace navigation" aria-busy={!workspaceReady}>{visibleGroups.map((group) => <div className="app-nav-group" key={group.label}><span className="app-nav-label">{group.label}</span>{group.items.map(renderNavItem)}</div>)}</nav>
    </aside>
    <div className="app-main">
      <header className="app-header">
        <div className="app-header-title"><span className="app-header-kicker">WORKSPACE</span><span className="app-breadcrumb"><b>{workspaceLabel}</b><i>/</i>{currentPage}</span></div>
        <div className="app-header-actions"><div className="account-menu" ref={accountMenuRef}>
          <button className="app-header-avatar account-menu-trigger" type="button" aria-label="Open account menu" aria-haspopup="menu" aria-expanded={accountMenuOpen} onClick={() => { setAccountMenuOpen(value => !value); setSignOutError(""); }}>
            {accountUser?.image ? <img className="account-trigger-image" src={accountUser.image} alt=""/> : (accountUser?.name?.trim() || accountUser?.email || workspace?.name || "W").slice(0, 1).toUpperCase()}
          </button>
          {accountMenuOpen && <div className="account-menu-panel"><div className="account-menu-identity"><span className="account-menu-avatar">{accountUser?.image ? <img src={accountUser.image} alt=""/> : <UserRound size={16}/>}</span><span><b>{accountUser?.name || "Your account"}</b><small>{accountUser?.email || "Account profile"}</small></span></div><label className="account-workspace-switch"><span>Switch workspace</span>{workspaces.length > 0 ? <StyledSelect ariaLabel="Switch workspace" className="account-workspace-dropdown" value={workspace?.id ?? ""} disabled={refreshingWorkspaces && workspaces.length === 0} onValueChange={changeWorkspace} options={workspaces.map(row => ({ value: row.id, label: row.type === "personal" ? personalName : row.name, group: row.type === "personal" ? "Your spaces" : "Team workspaces", description: row.role === "member" ? "Member access" : row.role === "admin" ? "Admin access" : row.role === "owner" ? "Owner" : undefined }))}/> : <span className="account-workspace-empty">{refreshingWorkspaces ? "Loading workspaces…" : "No workspaces found"}</span>}{workspaceListError && <small className="account-workspace-error" role="status">{workspaceListError}</small>}{workspaces.length === 1 && !refreshingWorkspaces && <small className="account-workspace-hint">{hasTeamWorkspace ? "Your available team workspace." : "Accept a team invitation to join an organization workspace."}</small>}</label><div className="account-menu-divider"/><Link className="account-menu-item" href="/app/profile" onClick={() => setAccountMenuOpen(false)}><UserRound size={15}/>Profile</Link><Link className="account-menu-item" href="/app/settings" onClick={() => setAccountMenuOpen(false)}><Settings2 size={15}/>Settings</Link>{signOutError && <p className="account-menu-error" role="alert">{signOutError}</p>}<button className="account-menu-item account-menu-signout" type="button" onClick={() => void signOut()} disabled={signingOut}><LogOut size={15}/>{signingOut ? "Signing out…" : "Sign out"}</button></div>}
        </div></div>
      </header>
      {workspaceReady && <details className="app-mobile-menu"><summary><Menu size={17}/><span>{currentPage}</span><ChevronDown size={15}/></summary><nav aria-label="Workspace navigation">{visibleGroups.map((group) => <div className="app-mobile-group" key={group.label}><span>{group.label}</span>{group.items.flatMap(item => [{ ...item }, ...(item.children ?? []).map(child => ({ ...child }))]).map(item => { const Icon = item.icon; return <Link key={item.href} className={isActive(item.href) ? "active" : ""} href={item.href} onClick={(event) => event.currentTarget.closest("details")?.removeAttribute("open")}><Icon size={15}/>{item.label}</Link>; })}</div>)}</nav></details>}
      <main className="app-content">{!ready || !accountUserReady ? <div className="app-loading"><span className="loading-orbit"/>Loading your workspace…</div> : loadError ? <section className="app-card"><div className="empty" role="alert">{loadError}<br/><Link href="/sign-in" className="app-text-link">Return to sign in →</Link></div></section> : mustFinishDomainSetup && pathname !== "/app/domains" && !pathname.startsWith("/app/domains/") ? <div className="app-loading"><span className="loading-orbit"/>Opening required domain setup…</div> : restrictedForMember ? <section className="member-restricted-board"><span><LockKeyhole size={19}/></span><h1>{personalNeedsTeam ? "Join a team to continue" : personalWorkspace ? "Personal workspace is unavailable" : "Access restricted"}</h1><p>{personalWorkspace ? "Your account can work in the organization workspaces you’ve joined. Choose a team from the profile menu. Profile and account security stay available there." : restrictionCopy}</p>{(personalNeedsTeam || personalWorkspace && hasTeamWorkspace) && <Link className="button secondary" href={personalNeedsTeam ? "/app/team/invitations" : "/app/mail"}>{personalNeedsTeam ? <><MailCheck size={15}/>View team invitations</> : <><ArrowRight size={14}/>Open team workspace</>}</Link>}</section> : personalTeamDashboard ? <><div className="page-heading"><div><h1>Team</h1><p>Join an organization workspace with an invitation.</p></div></div><section className="app-card personal-team-dashboard"><span className="personal-team-icon"><UsersRound size={20}/></span><div><h2>Your account is personal</h2><p>You can join organization teams when invited. Organization accounts create workspaces and send team invitations; your personal inbox and data stay private.</p></div><div className="personal-team-actions"><Link className="button secondary" href="/app/team/invitations"><MailCheck size={15}/>View team invitations<ArrowRight size={14}/></Link></div></section></> : <div key={workspace?.id ?? "workspace"}>{children}</div>}</main>
    </div>
  </div>;
}
