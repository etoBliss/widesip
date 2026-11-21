"use client";

import type { FormEvent } from "react";
import { useEffect, useRef, useState } from "react";
import { FilePlus2, Paperclip, Send, X } from "lucide-react";
import { StyledSelect } from "@/components/styled-select";
import Link from "next/link";

const api = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
type Mailbox = { id: string; domainId?: string; domainName?: string; address: string; displayName: string; mailStatus: string };
type Contact = { id: string; email: string; firstName: string | null; lastName: string | null; consentStatus: string };
type ReplyTarget = { id: string; mailboxId: string; fromAddress: string; subject: string };
type Props = { mailboxes: Mailbox[]; contacts: Contact[]; initialMailboxId?: string; replyTo?: ReplyTarget | null; onClose: () => void; onSent: () => void };
type Result<T> = { success: boolean; data?: T; error?: { message?: string } };
type Attachment = { filename: string; contentType: string; content: string };
const MAX_ATTACHMENT_BYTES = 6 * 1024 * 1024;

export function MailComposeModal({ mailboxes, contacts, initialMailboxId, replyTo, onClose, onSent }: Props) {
  const [mailboxId, setMailboxId] = useState(replyTo?.mailboxId ?? initialMailboxId ?? "");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);
  const sendable = mailboxes.filter(mailbox => mailbox.mailStatus === "active");

  useEffect(() => {
    const preferred = replyTo?.mailboxId ?? initialMailboxId;
    setMailboxId(current => preferred && sendable.some(mailbox => mailbox.id === preferred) ? preferred : sendable.some(mailbox => mailbox.id === current) ? current : sendable[0]?.id ?? "");
  }, [mailboxes, initialMailboxId, replyTo?.mailboxId]);

  useEffect(() => {
    function handleKey(event: KeyboardEvent) { if (event.key === "Escape" && !sending) onClose(); }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose, sending]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!mailboxId) return;
    setSending(true); setError("");
    const data = new FormData(event.currentTarget);
    const payload = replyTo
      ? { replyToMessageId: replyTo.id, text: data.get("text") }
      : { recipient: data.get("recipient"), subject: data.get("subject"), text: data.get("text"), attachments };
    if (replyTo) Object.assign(payload, { attachments });
    try {
      const response = await fetch(`${api}/v1/mailboxes/${mailboxId}/messages`, { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const result = await response.json() as Result<{ message?: string }>;
      if (!response.ok) throw new Error(result.error?.message ?? "Could not send this message.");
      onSent();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not send this message."); }
    finally { setSending(false); }
  }

  async function addFiles(files: FileList | null) {
    if (!files?.length) return;
    setError("");
    const selected = [...files];
    const total = attachments.reduce((sum, attachment) => sum + Math.floor(attachment.content.length * 3 / 4), 0) + selected.reduce((sum, file) => sum + file.size, 0);
    if (attachments.length + selected.length > 8) { setError("Attach up to eight files."); return; }
    if (total > MAX_ATTACHMENT_BYTES) { setError("Attachments must total 6 MB or less."); return; }
    if (selected.some(file => /\.(exe|dll|bat|cmd|com|scr|js|jse|vbs|ps1|msi|jar|sh)$/i.test(file.name))) { setError("Executable and script files can’t be attached."); return; }
    try {
      const additions = await Promise.all(selected.map(file => new Promise<Attachment>((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error(`Could not read ${file.name}.`));
        reader.onload = () => {
          const value = typeof reader.result === "string" ? reader.result : "";
          const content = value.split(",", 2)[1] ?? "";
          if (!content) reject(new Error(`Could not read ${file.name}.`));
          else resolve({ filename: file.name.slice(0, 180), contentType: file.type || "application/octet-stream", content });
        };
        reader.readAsDataURL(file);
      })));
      setAttachments(current => [...current, ...additions]);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not read the selected file."); }
    if (fileInput.current) fileInput.current.value = "";
  }

  return <div className="compose-floating-layer">
    <section className="compose-floating-modal" role="dialog" aria-modal="false" aria-labelledby="compose-title">
      <header className="compose-floating-header"><div><b id="compose-title">{replyTo ? "Reply" : "New message"}</b>{replyTo && <small>To {replyTo.fromAddress}</small>}</div><button className="icon-button" type="button" aria-label="Close composer" onClick={onClose} disabled={sending}><X size={16}/></button></header>
      {sendable.length ? <form className="compose-floating-form" onSubmit={submit}>
        <div className="field"><label>From</label><StyledSelect ariaLabel="From address" value={mailboxId} onValueChange={setMailboxId} options={sendable.map(mailbox => ({ value: mailbox.id, label: `${mailbox.displayName} <${mailbox.address}>` }))} required/></div>
        {replyTo ? <div className="compose-reply-context">Re: {replyTo.subject}</div> : <>
          <div className="field"><label htmlFor="compose-recipient">To</label><input id="compose-recipient" name="recipient" type="email" list="widesip-contact-suggestions" required placeholder="name@example.com"/><datalist id="widesip-contact-suggestions">{contacts.map(contact => <option key={contact.id} value={contact.email} label={`${[contact.firstName, contact.lastName].filter(Boolean).join(" ") || contact.email} · ${contact.consentStatus}`}/>)}</datalist></div>
          <div className="field"><label htmlFor="compose-subject">Subject</label><input id="compose-subject" name="subject" required maxLength={200}/></div>
        </>}
        <div className="field"><label htmlFor="compose-body">Message</label><textarea id="compose-body" name="text" required maxLength={100000} rows={replyTo ? 7 : 9}/></div>
        <div className="compose-attachment-area"><input ref={fileInput} className="compose-file-input" type="file" multiple onChange={event => void addFiles(event.target.files)}/><button className="button secondary" type="button" onClick={() => fileInput.current?.click()} disabled={sending}><Paperclip size={14}/>Attach files</button><span>Paste a full https:// link in your message to make it clickable.</span>{attachments.length > 0 && <ul className="compose-attachment-list">{attachments.map((file, index) => <li key={`${file.filename}-${index}`}><FilePlus2 size={13}/><span>{file.filename}</span><small>{(Math.floor(file.content.length * 3 / 4) / 1024).toFixed(0)} KB</small><button type="button" aria-label={`Remove ${file.filename}`} onClick={() => setAttachments(current => current.filter((_, itemIndex) => itemIndex !== index))}>×</button></li>)}</ul>}</div>
        {error && <p className="auth-error" role="alert">{error}</p>}
        <footer className="compose-floating-footer"><span>Recipients can see this message.</span><button className="button" disabled={sending}><Send size={14}/>{sending ? "Sending…" : "Send"}</button></footer>
      </form> : <div className="compose-no-mailbox"><b>No address is ready to send yet</b><p>Widesip checks sending status separately from domain ownership and receiving. Open the domain’s email setup, prepare its sending records, then check the status. Your domain must show <strong>Sending ready</strong> before composing is enabled.</p>{mailboxes.length > 0 && <ul>{[...new Map(mailboxes.map(mailbox => [mailbox.domainId ?? mailbox.address, mailbox])).values()].map(mailbox => <li key={mailbox.domainId ?? mailbox.id}><span><b>{mailbox.domainName ?? mailbox.address}</b><small>{mailbox.mailStatus === "active" ? "Sending ready" : "Sending setup required"}</small></span>{mailbox.domainId && <Link href={`/app/domains/${mailbox.domainId}/setup`}>Set up sending</Link>}</li>)}</ul>}<Link className="button secondary" href="/app/domains">Open domains</Link></div>}
    </section>
  </div>;
}
