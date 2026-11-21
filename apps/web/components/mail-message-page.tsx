"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Archive, ArrowLeft, Camera, ChevronDown, LoaderCircle, Reply, Trash2, UserRound } from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { MailComposeModal } from "@/components/mail-compose-modal";
import { MailQuotedText } from "@/components/mail-quoted-text";
import { useConfirmDialog } from "@/components/confirm-dialog";

const api = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
type Mailbox = { id: string; address: string; displayName: string; mailStatus: string };
type Contact = { id: string; email: string; firstName: string | null; lastName: string | null; company?: string | null; consentStatus: string };
type Message = { id: string; mailboxId: string; mailboxAddress: string; fromAddress: string; toAddresses: string[]; ccAddresses: string[]; direction: "inbound" | "outbound"; subject: string; textBody: string | null; isArchived: boolean; isRead: boolean; receivedAt: string; senderProfile?: { displayName: string | null; profileImage: string | null } | null };
type Result<T> = { success: boolean; data?: T; error?: { message?: string } };

function parseSender(from: string) {
  const address = from.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] ?? from;
  const display = from.replace(address, "").replace(/[<>\"]/g, "").trim();
  const fallback = address.split("@")[0]?.replace(/[._+-]+/g, " ").replace(/\b\w/g, letter => letter.toUpperCase()) || "Unknown sender";
  return { address, name: display || fallback };
}

export function MailMessagePage({ messageId }: { messageId: string }) {
  const { confirm, dialog: confirmDialog } = useConfirmDialog();
  const router = useRouter();
  const [thread, setThread] = useState<Message[]>([]);
  const [mailboxes, setMailboxes] = useState<Mailbox[]>([]);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [composeOpen, setComposeOpen] = useState(false);
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [busy, setBusy] = useState(false);
  const [senderDetailsOpen, setSenderDetailsOpen] = useState(false);
  const [photoBusy, setPhotoBusy] = useState(false);
  const photoInput = useRef<HTMLInputElement>(null);

  const loadThread = useCallback(async () => {
    const response = await fetch(`${api}/v1/messages/${encodeURIComponent(messageId)}/thread`, { credentials: "include" });
    const result = await response.json() as Result<Message[]>;
    if (!response.ok || !result.data) throw new Error(result.error?.message ?? "Could not load this conversation.");
    const messages = result.data;
    setThread(messages);
    await Promise.all(messages.filter(message => message.direction === "inbound" && !message.isRead).map(message => fetch(`${api}/v1/messages/${message.id}/read`, { method: "PATCH", credentials: "include" })));
    setThread(current => current.map(message => message.direction === "inbound" ? { ...message, isRead: true } : message));
  }, [messageId]);

  useEffect(() => {
    let cancelled = false;
    const workspace = localStorage.getItem("widesip.workspace") ?? "";
    void (async () => {
      try {
        const [mailboxResponse, contactResponse] = await Promise.all([
          fetch(`${api}/v1/mailboxes?workspaceId=${encodeURIComponent(workspace)}`, { credentials: "include" }),
          fetch(`${api}/v1/contacts?workspaceId=${encodeURIComponent(workspace)}`, { credentials: "include" }),
        ]);
        const mailboxResult = await mailboxResponse.json() as Result<Mailbox[]>;
        if (!mailboxResponse.ok) throw new Error(mailboxResult.error?.message ?? "Could not load your mailboxes.");
        if (cancelled) return;
        setMailboxes(mailboxResult.data ?? []);
        if (contactResponse.ok) { const contactResult = await contactResponse.json() as Result<Contact[]>; if (!cancelled) setContacts(contactResult.data ?? []); }
        await loadThread();
      } catch (cause) { if (!cancelled) setError(cause instanceof Error ? cause.message : "Could not load this conversation."); }
      finally { if (!cancelled) setLoading(false); }
    })();
    return () => { cancelled = true; };
  }, [loadThread]);

  useEffect(() => {
    let cancelled = false;
    const update = () => {
      if (cancelled || document.visibilityState !== "visible") return;
      void loadThread().catch(cause => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : "Could not update this conversation.");
      });
    };
    const timer = window.setInterval(update, 10_000);
    window.addEventListener("focus", update);
    return () => { cancelled = true; window.clearInterval(timer); window.removeEventListener("focus", update); };
  }, [loadThread]);

  async function applyToThread(action: "archive" | "delete") {
    if (!thread.length || busy) return;
    if (action === "delete" && !await confirm({ title: "Delete this conversation?", message: `All ${thread.length} message${thread.length === 1 ? "" : "s"} in this conversation will be permanently deleted from Widesip.`, confirmLabel: "Delete conversation", destructive: true })) return;
    setBusy(true); setError("");
    try {
      const results = await Promise.all(thread.map(message => fetch(`${api}/v1/messages/${message.id}${action === "archive" ? "/archive" : ""}`, {
        method: action === "archive" ? "PATCH" : "DELETE", credentials: "include",
        ...(action === "archive" ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ isArchived: true }) } : {}),
      })));
      const failed = results.find(response => !response.ok);
      if (failed) { const result = await failed.json() as Result<unknown>; throw new Error(result.error?.message ?? "Some messages could not be updated."); }
      router.push("/app/mail");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not update this conversation."); }
    finally { setBusy(false); }
  }

  async function uploadSenderPhoto(file?: File) {
    if (!file) return;
    const inbound = thread.find(message => message.direction === "inbound");
    if (!inbound) return;
    setError("");
    if (!/^image\/(png|jpeg|webp)$/.test(file.type) || file.size > 1_000_000) {
      setError("Choose a PNG, JPG, or WebP image smaller than 1 MB.");
      if (photoInput.current) photoInput.current.value = "";
      return;
    }
    setPhotoBusy(true);
    try {
      const image = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error("Could not read that image."));
        reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("Could not read that image."));
        reader.readAsDataURL(file);
      });
      const response = await fetch(`${api}/v1/messages/${inbound.id}/sender-profile`, { method: "PATCH", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ profileImage: image }) });
      const result = await response.json() as Result<{ displayName: string | null; profileImage: string | null }>;
      if (!response.ok || !result.data) throw new Error(result.error?.message ?? "Could not save this sender photo.");
      setThread(current => current.map(message => message.direction === "inbound" ? { ...message, senderProfile: result.data! } : message));
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not save this sender photo."); }
    finally { setPhotoBusy(false); if (photoInput.current) photoInput.current.value = ""; }
  }

  const replyTarget = [...thread].reverse().find(message => message.direction === "inbound") ?? null;
  const firstInbound = thread.find(message => message.direction === "inbound") ?? null;
  const senderInfo = firstInbound ? parseSender(firstInbound.fromAddress) : null;
  const knownContact = senderInfo ? contacts.find(contact => contact.email.toLowerCase() === senderInfo.address.toLowerCase()) : undefined;
  const senderDisplayName = firstInbound?.senderProfile?.displayName || [knownContact?.firstName, knownContact?.lastName].filter(Boolean).join(" ") || senderInfo?.name;
  const subject = thread.find(message => message.id === messageId)?.subject ?? thread[thread.length - 1]?.subject ?? "Conversation";

  return <AppShell>
    <div className="mail-reader-topbar"><Link className="mail-reader-back" href="/app/mail"><ArrowLeft size={16}/> Back to inbox</Link><div className="mail-reader-actions"><button className="button secondary" type="button" onClick={() => void applyToThread("archive")} disabled={!thread.length || busy}><Archive size={14}/>{busy ? "Working…" : "Archive conversation"}</button><button className="button secondary mail-reader-delete" type="button" onClick={() => void applyToThread("delete")} disabled={!thread.length || busy}><Trash2 size={14}/>Delete</button></div></div>
    {error && <p className="auth-error" role="alert">{error}</p>}
    {loading ? <section className="app-card mail-reader-loading"><LoaderCircle size={17} className="mail-spinner"/>Loading conversation…</section> : thread.length ? <>
      <header className="mail-reader-heading"><h1>{subject}</h1></header>
      {firstInbound && senderInfo && <section className="app-card mail-sender-card">
        <div className="mail-sender-card-top">
          <span className="mail-sender-large-avatar">{firstInbound.senderProfile?.profileImage ? <img src={firstInbound.senderProfile.profileImage} alt=""/> : <span>{(senderDisplayName || senderInfo.name).slice(0, 1).toUpperCase() || <UserRound size={22}/>}</span>}</span>
          <div className="mail-sender-card-copy"><h2>{senderDisplayName}</h2><p>{senderInfo.address}</p></div>
          <button className="button secondary mail-sender-details-toggle" type="button" aria-expanded={senderDetailsOpen} onClick={() => setSenderDetailsOpen(open => !open)}>{senderDetailsOpen ? "Hide details" : "Details"}<ChevronDown size={14}/></button>
        </div>
        {senderDetailsOpen && <div className="mail-sender-details">
          <div><small>From</small><b>{firstInbound.fromAddress}</b></div>
          {knownContact?.company && <div><small>Company</small><b>{knownContact.company}</b></div>}
          <div><small>To</small><b>{firstInbound.toAddresses.join(", ") || firstInbound.mailboxAddress}</b></div>
          {firstInbound.ccAddresses.length > 0 && <div><small>CC</small><b>{firstInbound.ccAddresses.join(", ")}</b></div>}
          <div><small>First message in this conversation</small><b>{new Date(firstInbound.receivedAt).toLocaleString()}</b></div>
          <label className="mail-sender-photo-control"><Camera size={14}/>{photoBusy ? "Saving photo…" : firstInbound.senderProfile?.profileImage ? "Change Widesip photo" : "Add a Widesip photo"}<input ref={photoInput} type="file" accept="image/png,image/jpeg,image/webp" disabled={photoBusy} onChange={event => { void uploadSenderPhoto(event.target.files?.[0]); }}/></label>
          <p>Sender photos are managed by your workspace and appear only in Widesip. Email doesn’t provide access to a sender’s private Google profile photo.</p>
        </div>}
      </section>}
      <section className="mail-thread">{thread.map((message, index) => {
        const parsed = parseSender(message.fromAddress);
        const sender = message.direction === "outbound" ? message.mailboxAddress : message.senderProfile?.displayName || parsed.name;
        const initials = sender.split(/[<@]/)[0].trim().split(/[\s._-]+/).slice(0, 2).map(part => part[0]?.toUpperCase() ?? "").join("") || "?";
        return <article className="app-card mail-thread-message" key={message.id}>
          <div className="mail-thread-message-header"><span className="mail-thread-avatar">{message.direction === "inbound" && message.senderProfile?.profileImage ? <img src={message.senderProfile.profileImage} alt=""/> : initials}</span><div className="mail-thread-sender"><b>{sender}{message.direction === "inbound" && <small className="mail-sender-address">{parsed.address}</small>}</b><small>to {message.direction === "outbound" ? message.toAddresses.join(", ") : message.mailboxAddress}{message.ccAddresses.length ? ` · cc ${message.ccAddresses.join(", ")}` : ""}</small></div><time>{new Date(message.receivedAt).toLocaleString()}</time></div>
          {index > 0 && <div className="mail-thread-subject">{message.subject}</div>}
          <MailQuotedText text={message.textBody || "This message has no readable text content."}/>
          {message.direction === "inbound" && <button className="button secondary mail-inline-reply" type="button" onClick={() => { setReplyTo(message); setComposeOpen(true); }}><Reply size={14}/> Reply</button>}
        </article>;
      })}</section>
    </> : <section className="app-card mail-reader-loading">This conversation could not be found. <Link href="/app/mail">Return to inbox</Link></section>}
    {composeOpen && <MailComposeModal mailboxes={mailboxes} contacts={contacts} initialMailboxId={replyTo?.mailboxId} replyTo={replyTo ? { id: replyTo.id, mailboxId: replyTo.mailboxId, fromAddress: replyTo.fromAddress, subject: replyTo.subject } : null} onClose={() => setComposeOpen(false)} onSent={() => { setComposeOpen(false); setReplyTo(null); void loadThread(); }}/>} 
    {confirmDialog}
  </AppShell>;
}
