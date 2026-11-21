"use client";

import { useState } from "react";

export function splitQuotedText(text: string) {
  const lines = text.split(/\r?\n/);
  const marker = /^\s*(?:On\s+.{1,180}\bwrote:\s*|[-_]{2,}\s*Original Message\s*[-_]{2,}|Begin forwarded message:\s*|>\s?)/i;
  const cutAt = lines.findIndex(line => marker.test(line));
  if (cutAt < 0) return { visible: text, quoted: "" };
  return { visible: lines.slice(0, cutAt).join("\n").trimEnd(), quoted: lines.slice(cutAt).join("\n").trim() };
}

export function MailQuotedText({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const { visible, quoted } = splitQuotedText(text);
  if (!quoted) return <div className="mail-thread-body">{text || "This message has no readable text content."}</div>;
  return <div className="mail-thread-body mail-thread-body-collapsible">
    <div className="mail-quoted-visible">{visible || <span className="mail-quote-only-note">This reply only contains quoted text.</span>}</div>
    <button className="mail-quoted-toggle" type="button" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>{expanded ? "Hide quoted text" : "Show quoted text"}</button>
    {expanded && <div className="mail-quoted-content">{quoted}</div>}
  </div>;
}
