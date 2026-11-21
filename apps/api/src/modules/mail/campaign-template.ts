type DomainTemplate = { brandName: string; logoUrl: string | null; accentColor: string; footerText: string; customHtml?: string };

function escapeHtml(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

export function sanitizeCustomEmailHtml(value: string) {
  return value
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|iframe|object|embed|form|input|button|textarea|select|video|audio)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<(script|iframe|object|embed|form|input|button|textarea|select|meta|base|video|audio)\b[^>]*\/?>/gi, "")
    .replace(/\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/\s+(?:srcdoc|formaction)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/\b(?:javascript|vbscript)\s*:/gi, "")
    .replace(/@import\s+[^;]+;?/gi, "");
}

function linkifyText(value: string) {
  const urlPattern = /https?:\/\/[^\s<>"']+/gi;
  let output = "";
  let cursor = 0;
  for (const match of value.matchAll(urlPattern)) {
    const raw = match[0];
    const trailing = raw.match(/[),.!?;:]+$/)?.[0] ?? "";
    const url = trailing ? raw.slice(0, -trailing.length) : raw;
    const start = match.index ?? 0;
    output += escapeHtml(value.slice(cursor, start));
    output += `<a href="${escapeHtml(url)}" style="color:#4165e8;text-decoration:underline">${escapeHtml(url)}</a>${escapeHtml(trailing)}`;
    cursor = start + raw.length;
  }
  return output + escapeHtml(value.slice(cursor));
}

function renderTextBody(text: string) {
  return text
    .split(/\r?\n\s*\r?\n/)
    .filter(Boolean)
    .map(paragraph => `<p style="margin:0 0 22px;font-size:16px;line-height:1.8;color:#344054">${linkifyText(paragraph).replace(/\r?\n/g, "<br>")}</p>`)
    .join("") || `<p style="margin:0;font-size:16px;line-height:1.8;color:#344054"></p>`;
}

function footerHtml(text: string) {
  return text ? `<p style="margin:0 0 12px;color:#667085;font-size:12px;line-height:1.7">${escapeHtml(text).replaceAll("\n", "<br>")}</p>` : "";
}

function renderCustom(input: {
  customHtml: string;
  subject: string;
  body: string;
  template: DomainTemplate;
  senderName: string;
  senderAddress: string;
  unsubscribeUrl?: string;
}) {
  const safeTemplate = sanitizeCustomEmailHtml(input.customHtml);
  const hasFooterSlot = /{{\s*footer\s*}}/i.test(safeTemplate);
  const hasUnsubscribeSlot = /{{\s*unsubscribe_url\s*}}/i.test(safeTemplate);
  const footer = footerHtml(input.template.footerText);
  const replacements: Record<string, string> = {
    subject: escapeHtml(input.subject),
    body: renderTextBody(input.body),
    brand_name: escapeHtml(input.template.brandName),
    sender_name: escapeHtml(input.senderName),
    sender_address: escapeHtml(input.senderAddress),
    logo_url: escapeHtml(input.template.logoUrl ?? ""),
    footer,
    unsubscribe_url: escapeHtml(input.unsubscribeUrl ?? ""),
  };
  let html = safeTemplate.replace(/{{\s*(subject|body|brand_name|sender_name|sender_address|logo_url|footer|unsubscribe_url)\s*}}/gi, (_match, key: string) => replacements[key.toLowerCase()] ?? "");
  if (footer && !hasFooterSlot) html += footer;
  if (input.unsubscribeUrl && !hasUnsubscribeSlot) {
    html += `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse"><tr><td style="padding:24px 0 8px;border-top:1px solid #eaecf0;color:#667085;font:12px/1.6 Arial,Helvetica,sans-serif">You’re receiving this email because you subscribed to updates from ${escapeHtml(input.template.brandName)}. <a href="${escapeHtml(input.unsubscribeUrl)}" style="color:#667085;text-decoration:underline">Unsubscribe</a></td></tr></table>`;
  }
  return /<html[\s>]/i.test(html)
    ? html
    : `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"></head><body style="margin:0;background:#f4f6fa;font-family:Arial,Helvetica,sans-serif;color:#344054">${html}</body></html>`;
}

function brandHeader(input: { template: DomainTemplate; senderName: string; senderAddress: string; color: string }) {
  const brand = escapeHtml(input.template.brandName || "Widesip");
  const sender = escapeHtml(input.senderName || input.senderAddress || brand);
  const logo = input.template.logoUrl
    ? `<img src="${escapeHtml(input.template.logoUrl)}" alt="${brand}" width="44" height="44" style="display:block;width:44px;height:44px;object-fit:contain;border:1px solid #edf0f4;border-radius:12px;background:#fff">`
    : `<span style="display:block;width:44px;height:44px;border-radius:12px;background:${input.color};color:#fff;text-align:center;font:bold 20px/44px Arial,Helvetica,sans-serif">${escapeHtml(sender.slice(0, 1).toUpperCase())}</span>`;
  return `<table role="presentation" cellspacing="0" cellpadding="0" border="0"><tr><td style="padding:0 14px 0 0;vertical-align:middle">${logo}</td><td style="vertical-align:middle"><p style="margin:0;color:#1d2939;font:bold 15px/1.35 Arial,Helvetica,sans-serif">${sender}</p><p style="margin:4px 0 0;color:#667085;font:12px/1.4 Arial,Helvetica,sans-serif">${brand} · ${escapeHtml(input.senderAddress)}</p></td></tr></table>`;
}

function emailFrame(content: string, color: string) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title></title></head><body style="margin:0;padding:0;background:#f3f5f8;font-family:Arial,Helvetica,sans-serif;color:#344054"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="border-collapse:collapse;background:#f3f5f8"><tr><td align="center" style="padding:40px 16px"><table role="presentation" width="640" cellspacing="0" cellpadding="0" border="0" style="width:100%;max-width:640px;border-collapse:separate;border-spacing:0;background:#fff;border:1px solid #e7eaf0;border-radius:18px;overflow:hidden"><tr><td style="height:5px;background:${color};font-size:0;line-height:0">&nbsp;</td></tr>${content}</table><p style="margin:18px 0 0;color:#98a2b3;font:11px/1.5 Arial,Helvetica,sans-serif;text-align:center">Sent with care by Widesip</p></td></tr></table></body></html>`;
}

function normalizedColor(value: string) {
  return /^#[\da-f]{6}$/i.test(value) ? value : "#4165e8";
}

export function renderCampaignHtml(input: { subject: string; body: string; unsubscribeUrl: string; senderName: string; senderAddress: string; template: DomainTemplate }) {
  if (input.template.customHtml?.trim()) return renderCustom({ ...input, customHtml: input.template.customHtml });
  const color = normalizedColor(input.template.accentColor);
  const unsubscribe = `<a href="${escapeHtml(input.unsubscribeUrl)}" style="color:#667085;text-decoration:underline">Unsubscribe</a>`;
  const footer = footerHtml(input.template.footerText);
  const content = `<tr><td style="padding:30px 40px 24px">${brandHeader({ template: input.template, senderName: input.senderName, senderAddress: input.senderAddress, color })}</td></tr><tr><td style="padding:24px 40px 0"><p style="margin:0 0 10px;color:${color};font:bold 11px/1.4 Arial,Helvetica,sans-serif;letter-spacing:1.1px;text-transform:uppercase">A message from ${escapeHtml(input.template.brandName)}</p><h1 style="margin:0;color:#182230;font:bold 28px/1.3 Arial,Helvetica,sans-serif;letter-spacing:-.4px">${escapeHtml(input.subject)}</h1></td></tr><tr><td style="padding:28px 40px 34px;font:16px/1.8 Arial,Helvetica,sans-serif">${renderTextBody(input.body)}</td></tr><tr><td style="padding:22px 40px 28px;border-top:1px solid #eaecf0">${footer}<p style="margin:0;color:#667085;font:12px/1.6 Arial,Helvetica,sans-serif">${unsubscribe}</p></td></tr>`;
  return emailFrame(content, color);
}

export function renderBrandedMessageHtml(input: { subject: string; body: string; senderName: string; senderAddress: string; template: DomainTemplate }) {
  if (input.template.customHtml?.trim()) return renderCustom({ ...input, customHtml: input.template.customHtml });
  const color = normalizedColor(input.template.accentColor);
  const footer = footerHtml(input.template.footerText);
  const content = `<tr><td style="padding:30px 40px 24px">${brandHeader({ template: input.template, senderName: input.senderName, senderAddress: input.senderAddress, color })}</td></tr><tr><td style="padding:24px 40px 0"><h1 style="margin:0;color:#182230;font:bold 26px/1.35 Arial,Helvetica,sans-serif;letter-spacing:-.35px">${escapeHtml(input.subject)}</h1></td></tr><tr><td style="padding:28px 40px 36px;font:16px/1.8 Arial,Helvetica,sans-serif">${renderTextBody(input.body)}</td></tr>${footer ? `<tr><td style="padding:22px 40px 28px;border-top:1px solid #eaecf0">${footer}</td></tr>` : ""}`;
  return emailFrame(content, color);
}
