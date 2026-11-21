"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Archive, ArrowRight, FolderInput, Inbox, LoaderCircle, Mail, MailOpen, MoreHorizontal, RefreshCw, Search, SquarePen, Trash2 } from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { StyledSelect } from "@/components/styled-select";
import { MailComposeModal } from "@/components/mail-compose-modal";
import { splitQuotedText } from "@/components/mail-quoted-text";
import { useConfirmDialog } from "@/components/confirm-dialog";

const api = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
type Mailbox = { id: string; domainId?: string; domainName?: string; address: string; displayName: string; mailStatus: string; profileImage?: string | null; domainProfileImage?: string | null };
type Contact = { id: string; email: string; firstName: string | null; lastName: string | null; company?: string | null; consentStatus: string };
type MessageCategory = "people" | "updates" | "promotions";
type InboxView = MessageCategory | "sent" | "archived";
type Message = { id: string; mailboxId: string; mailboxAddress: string; fromAddress: string; toAddresses: string[]; ccAddresses: string[]; inReplyToMessageId: string | null; direction: "inbound" | "outbound"; subject: string; textBody: string | null; category: MessageCategory; isArchived: boolean; isRead: boolean; receivedAt: string; senderProfile?: { displayName: string | null; profileImage: string | null } | null };
type Thread = { key: string; messages: Message[]; latest: Message };
type Result<T> = { success: boolean; data?: T; error?: { message?: string } };

function threadKey(message: Message) {
  const subject = message.subject.trim().replace(/^(?:(?:re|fw|fwd)\s*:\s*)+/i, "").trim().toLowerCase() || "(no subject)";
  const address = (message.direction === "inbound" ? message.fromAddress : message.toAddresses[0] ?? "").match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0].toLowerCase() ?? "";
  return `${message.mailboxId}|${subject}|${address}`;
}

function parseSender(from: string) {
  const address = from.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] ?? from;
  const display = from.replace(address, "").replace(/[<>\"]/g, "").trim();
  const fallback = address.split("@")[0]?.replace(/[._+-]+/g, " ").replace(/\b\w/g, letter => letter.toUpperCase()) || "Unknown sender";
  return { address, name: display || fallback };
}

export default function InboxPage() {
  const { confirm, dialog: confirmDialog } = useConfirmDialog();
  const [workspaceId, setWorkspaceId] = useState("");
  const [mailboxes, setMailboxes] = useState<Mailbox[]>([]);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [mailboxId, setMailboxId] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [activeView, setActiveView] = useState<InboxView>("people");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [composeOpen, setComposeOpen] = useState(false);

  const loadMessages = useCallback(async (workspace: string, mailbox: string, query: string) => {
    const params = new URLSearchParams({ workspaceId: workspace });
    if (mailbox) params.set("mailboxId", mailbox);
    if (query.trim()) params.set("search", query.trim());
    const response = await fetch(`${api}/v1/messages?${params}`, { credentials: "include", cache: "no-store" });
    const result = await response.json() as Result<Message[]>;
    if (!response.ok) throw new Error(result.error?.message ?? "Could not load your inbox.");
    setMessages(result.data ?? []);
  }, []);

  async function refreshInbox() {
    if (!workspaceId || refreshing) return;
    setRefreshing(true); setError(""); setNotice("");
    try {
      const [mailboxResponse, contactResponse, messageResponse] = await Promise.all([
        fetch(`${api}/v1/mailboxes?workspaceId=${encodeURIComponent(workspaceId)}`, { credentials: "include", cache: "no-store" }),
        fetch(`${api}/v1/contacts?workspaceId=${encodeURIComponent(workspaceId)}`, { credentials: "include", cache: "no-store" }),
        (async () => {
          const params = new URLSearchParams({ workspaceId });
          if (mailboxId) params.set("mailboxId", mailboxId);
          if (search.trim()) params.set("search", search.trim());
          return fetch(`${api}/v1/messages?${params}`, { credentials: "include", cache: "no-store" });
        })(),
      ]);
      const mailboxResult = await mailboxResponse.json() as Result<Mailbox[]>;
      if (!mailboxResponse.ok) throw new Error(mailboxResult.error?.message ?? "Could not refresh your mailboxes.");
      setMailboxes(mailboxResult.data ?? []);
      if (contactResponse.ok) { const contactResult = await contactResponse.json() as Result<Contact[]>; setContacts(contactResult.data ?? []); }
      const messageResult = await messageResponse.json() as Result<Message[]>;
      if (!messageResponse.ok) throw new Error(messageResult.error?.message ?? "Could not refresh your messages.");
      setMessages(messageResult.data ?? []);
      setNotice("Inbox refreshed.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not refresh your inbox."); }
    finally { setRefreshing(false); }
  }

  useEffect(() => {
    const workspace = localStorage.getItem("widesip.workspace") ?? "";
    setWorkspaceId(workspace);
    if (!workspace) { setLoading(false); return; }
    void (async () => {
      try {
        const [mailboxResponse, contactResponse] = await Promise.all([
          fetch(`${api}/v1/mailboxes?workspaceId=${encodeURIComponent(workspace)}`, { credentials: "include" }),
          fetch(`${api}/v1/contacts?workspaceId=${encodeURIComponent(workspace)}`, { credentials: "include" }),
        ]);
        const mailboxResult = await mailboxResponse.json() as Result<Mailbox[]>;
        if (!mailboxResponse.ok) throw new Error(mailboxResult.error?.message ?? "Could not load your mailboxes.");
        setMailboxes(mailboxResult.data ?? []);
        if (contactResponse.ok) { const contactResult = await contactResponse.json() as Result<Contact[]>; setContacts(contactResult.data ?? []); }
      } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not load your inbox."); }
    })();
  }, []);

  useEffect(() => {
    if (!workspaceId) { setLoading(false); return; }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      setRefreshing(true); setError("");
      void loadMessages(workspaceId, mailboxId, search).catch(cause => { if (!cancelled) setError(cause instanceof Error ? cause.message : "Could not load your inbox."); })
        .finally(() => { if (!cancelled) { setLoading(false); setRefreshing(false); } });
    }, search ? 300 : 0);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [workspaceId, mailboxId, search, loadMessages]);

  // Keep the inbox current while it is open. Polling uses the normal authenticated
  // API and skips background tabs to avoid needless requests during local testing.
  useEffect(() => {
    if (!workspaceId) return;
    let cancelled = false;
    const update = () => {
      if (document.visibilityState !== "visible") return;
      const params = new URLSearchParams({ workspaceId });
      if (mailboxId) params.set("mailboxId", mailboxId);
      if (search.trim()) params.set("search", search.trim());
      void Promise.all([
        fetch(`${api}/v1/messages?${params}`, { credentials: "include", cache: "no-store" }),
        fetch(`${api}/v1/mailboxes?workspaceId=${encodeURIComponent(workspaceId)}`, { credentials: "include", cache: "no-store" }),
        fetch(`${api}/v1/contacts?workspaceId=${encodeURIComponent(workspaceId)}`, { credentials: "include", cache: "no-store" }),
      ]).then(async ([messageResponse, mailboxResponse, contactResponse]) => {
        const messageResult = await messageResponse.json() as Result<Message[]>;
        if (!messageResponse.ok) throw new Error(messageResult.error?.message ?? "Could not update your inbox.");
        if (cancelled) return;
        setMessages(messageResult.data ?? []);
        if (mailboxResponse.ok) { const result = await mailboxResponse.json() as Result<Mailbox[]>; if (!cancelled) setMailboxes(result.data ?? []); }
        if (contactResponse.ok) { const result = await contactResponse.json() as Result<Contact[]>; if (!cancelled) setContacts(result.data ?? []); }
      }).catch(cause => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : "Could not update your inbox.");
      });
    };
    const timer = window.setInterval(update, 10_000);
    window.addEventListener("focus", update);
    return () => { cancelled = true; window.clearInterval(timer); window.removeEventListener("focus", update); };
  }, [workspaceId, mailboxId, search, loadMessages]);

  function viewMessages(view: InboxView) {
    if (view === "archived") return messages.filter(message => message.isArchived);
    if (view === "sent") return messages.filter(message => !message.isArchived && message.direction === "outbound");
    return messages.filter(message => !message.isArchived && message.direction === "inbound" && message.category === view);
  }

  const tabs: { id: InboxView; label: string }[] = [
    { id: "people", label: "People" }, { id: "updates", label: "Updates" }, { id: "promotions", label: "Promotions" }, { id: "sent", label: "Sent" }, { id: "archived", label: "Archived" },
  ];
  const visibleMessages = viewMessages(activeView);
  const threads = useMemo<Thread[]>(() => {
    const grouped = new Map<string, Message[]>();
    for (const message of visibleMessages) {
      const key = threadKey(message);
      grouped.set(key, [...(grouped.get(key) ?? []), message]);
    }
    return [...grouped.entries()].map(([key, items]) => {
      const ordered = [...items].sort((a, b) => new Date(a.receivedAt).getTime() - new Date(b.receivedAt).getTime());
      return { key, messages: ordered, latest: ordered[ordered.length - 1] };
    }).sort((a, b) => new Date(b.latest.receivedAt).getTime() - new Date(a.latest.receivedAt).getTime());
  }, [visibleMessages]);

  async function threadAction(thread: Thread, action: "archive" | "delete" | "read" | "move", value?: string) {
    setError(""); setNotice("");
    try {
      const threadResponse = await fetch(`${api}/v1/messages/${thread.latest.id}/thread`, { credentials: "include" });
      const threadResult = await threadResponse.json() as Result<Message[]>;
      if (!threadResponse.ok || !threadResult.data) throw new Error(threadResult.error?.message ?? "Could not open this conversation.");
      const fullThread = threadResult.data;
      if (action === "delete" && !await confirm({ title: "Delete this conversation?", message: `All ${fullThread.length} message${fullThread.length === 1 ? "" : "s"} in this conversation will be permanently deleted from Widesip.`, confirmLabel: "Delete conversation", destructive: true })) return;
      const shouldArchive = !fullThread.every(message => message.isArchived);
      const responses = await Promise.all(fullThread.map(message => {
        if (action === "delete") return fetch(`${api}/v1/messages/${message.id}`, { method: "DELETE", credentials: "include" });
        const path = action === "archive" ? "/archive" : action === "move" ? "/category" : "/read";
        const body = action === "archive" ? { isArchived: shouldArchive } : action === "move" ? { category: value } : { isRead: !fullThread.every(item => item.isRead) };
        return fetch(`${api}/v1/messages/${message.id}${path}`, { method: "PATCH", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      }));
      const failed = responses.find(response => !response.ok);
      if (failed) { const result = await failed.json() as Result<unknown>; throw new Error(result.error?.message ?? "Some messages could not be updated."); }
      const ids = new Set(fullThread.map(message => message.id));
      if (action === "delete" || action === "archive" && shouldArchive) setMessages(items => items.filter(message => !ids.has(message.id)));
      else if (action === "archive") setMessages(items => items.map(message => ids.has(message.id) ? { ...message, isArchived: false } : message));
      else if (action === "read") setMessages(items => items.map(message => ids.has(message.id) ? { ...message, isRead: !fullThread.every(item => item.isRead) } : message));
      else setMessages(items => items.map(message => ids.has(message.id) ? { ...message, category: value as MessageCategory } : message));
      setNotice(action === "delete" ? "Conversation deleted from Widesip." : action === "archive" ? (shouldArchive ? "Conversation archived." : "Conversation restored to the inbox.") : action === "read" ? "Conversation read state updated." : `Conversation moved to ${value}.`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not update this conversation."); }
  }

  const sendableMailboxes = mailboxes.filter(mailbox => mailbox.mailStatus === "active");

  return <AppShell>
    <div className="page-heading"><div><h1>Inbox</h1><p>Conversations across your Widesip addresses.</p></div><div className="inbox-heading-actions"><button className="button secondary" type="button" disabled={!workspaceId || refreshing} onClick={() => void refreshInbox()}><RefreshCw size={15} className={refreshing ? "mail-spinner" : undefined}/>{refreshing ? "Refreshing…" : "Refresh"}</button><button className="button" type="button" disabled={!sendableMailboxes.length} onClick={() => setComposeOpen(true)}><SquarePen size={15}/> Compose</button></div></div>
    <section className="app-card inbox-workspace">
      <div className="inbox-toolbar"><div className="inbox-title"><span className="onboard-icon"><Inbox size={18}/></span><div><h2>Shared inbox</h2><p>Move a message to correct its category. Widesip remembers your choice for future mail from that sender in this mailbox.</p></div></div><StyledSelect className="inbox-address-filter" ariaLabel="Filter by address" value={mailboxId} onValueChange={setMailboxId} options={[{ value: "", label: "All addresses" }, ...mailboxes.map(box => ({ value: box.id, label: box.address }))]}/></div>
      <div className="inbox-search-row"><label className="inbox-search"><Search size={16}/><input type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder="Search sender, subject, or message" aria-label="Search email"/>{refreshing && <LoaderCircle size={14} className="mail-spinner"/>}</label><span className="inbox-result-count">{threads.length} conversation{threads.length === 1 ? "" : "s"}</span></div>
      <div className="inbox-tabs" role="tablist" aria-label="Inbox categories">{tabs.map(tab => <button type="button" role="tab" aria-selected={activeView === tab.id} className={activeView === tab.id ? "active" : ""} key={tab.id} onClick={() => setActiveView(tab.id)}><span>{tab.label}</span><small>{viewMessages(tab.id).length}</small></button>)}</div>
      {error && <p className="auth-error" role="alert">{error}</p>}{notice && <p className="dns-message" role="status">{notice}</p>}
      {!loading && mailboxes.length > 0 && sendableMailboxes.length === 0 && <div className="inbox-setup-hint"><span>No sending-ready address yet. Complete sending setup for your verified domain to enable Compose.</span>{[...new Map(mailboxes.map(box => [box.domainId ?? box.address, box])).values()].map(box => box.domainId && <Link key={box.domainId} href={`/app/domains/${box.domainId}/setup`}>Set up {box.domainName ?? "domain"}</Link>)}</div>}
      {!loading && !error && mailboxes.length === 0 ? <div className="inbox-empty"><span><Mail size={20}/></span><b>No addresses yet</b><p>Create a mailbox to start receiving messages in Widesip.</p><Link className="inline-link" href="/app/mailboxes">Create an address <ArrowRight size={14}/></Link></div> : loading ? <div className="inbox-empty">Loading your messages…</div> : !threads.length ? <div className="inbox-empty"><span><Mail size={20}/></span><b>{search ? "No conversations match your search" : `Nothing in ${tabs.find(tab => tab.id === activeView)?.label} yet`}</b><p>{search ? "Try a different sender, subject, or phrase." : "New messages will appear here when they match this view."}</p></div> : <div className="inbox-message-list">{threads.map(thread => {
        const message = thread.latest;
        const parsedSender = parseSender(message.fromAddress);
        const knownContact = message.direction === "inbound" ? contacts.find(contact => contact.email.toLowerCase() === parsedSender.address.toLowerCase()) : undefined;
        const sender = message.direction === "outbound" ? `To ${message.toAddresses.join(", ")}` : message.senderProfile?.displayName || [knownContact?.firstName, knownContact?.lastName].filter(Boolean).join(" ") || parsedSender.name;
        const initials = (message.direction === "outbound" ? "You" : sender).trim().split(/[\s._-]+/).slice(0, 2).map(part => part[0]?.toUpperCase() ?? "").join("") || "?";
        const mailbox = mailboxes.find(box => box.id === message.mailboxId);
        const senderImage = message.direction === "outbound" ? mailbox?.profileImage ?? mailbox?.domainProfileImage : message.senderProfile?.profileImage ?? null;
        const allRead = thread.messages.every(item => item.isRead);
        const returnViewCategories: MessageCategory[] = ["people", "updates", "promotions"];
        return <article className={`inbox-message-row${allRead ? " is-read" : " is-unread"}`} key={thread.key}>
          <Link className="inbox-message-open" href={`/app/mail/${message.id}`}><span className="inbox-sender-avatar" style={senderImage ? { overflow: "hidden" } : undefined}>{senderImage ? <img src={senderImage} alt="" style={{ width: "100%", height: "100%", display: "block", objectFit: "cover", borderRadius: "inherit" }}/> : initials}</span><span className="inbox-message-main"><span className="inbox-message-sender">{sender}<small>{message.direction === "inbound" ? parsedSender.address : message.mailboxAddress}</small></span><b>{message.subject || "(no subject)"}{thread.messages.length > 1 && <span className="inbox-thread-count">{thread.messages.length}</span>}</b><small className="inbox-message-preview">{message.textBody ? splitQuotedText(message.textBody).visible.replace(/\s+/g, " ") || "Reply with quoted text" : "No text preview available."}</small></span><time>{new Date(message.receivedAt).toLocaleDateString()}</time></Link>
          <details className="message-actions"><summary aria-label={`More actions for ${message.subject}`}><MoreHorizontal size={17}/></summary><div className="message-actions-menu" role="menu"><button role="menuitem" type="button" onClick={event => { event.currentTarget.closest("details")?.removeAttribute("open"); void threadAction(thread, "read"); }}><MailOpen size={14}/>{allRead ? "Mark unread" : "Mark as read"}</button>{message.direction === "inbound" && <><span className="message-menu-label">Move conversation to</span>{returnViewCategories.filter(category => category !== message.category).map(category => <button role="menuitem" type="button" key={category} onClick={event => { event.currentTarget.closest("details")?.removeAttribute("open"); void threadAction(thread, "move", category); }}><FolderInput size={14}/>{category === "people" ? "People" : category === "updates" ? "Updates" : "Promotions"}</button>)}</>}<button role="menuitem" type="button" onClick={event => { event.currentTarget.closest("details")?.removeAttribute("open"); void threadAction(thread, "archive"); }}><Archive size={14}/>{thread.messages.every(item => item.isArchived) ? "Restore to inbox" : "Archive conversation"}</button><button className="message-delete-action" role="menuitem" type="button" onClick={event => { event.currentTarget.closest("details")?.removeAttribute("open"); void threadAction(thread, "delete"); }}><Trash2 size={14}/>Delete conversation</button></div></details>
        </article>;
      })}</div>}
    </section>
    {composeOpen && <MailComposeModal mailboxes={mailboxes} contacts={contacts} initialMailboxId={sendableMailboxes[0]?.id} onClose={() => setComposeOpen(false)} onSent={() => { setComposeOpen(false); setNotice("Message sent."); if (workspaceId) void loadMessages(workspaceId, mailboxId, search).catch(cause => setError(cause instanceof Error ? cause.message : "Message sent, but the inbox could not be refreshed.")); }}/>} 
    {confirmDialog}
  </AppShell>;
}
