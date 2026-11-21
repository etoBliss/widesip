type DomainTemplate = { brandName: string; logoUrl: string | null; accentColor: string; footerText: string };

function escapeHtml(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
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

function renderTextBody(text: string, paragraphStyle: string) {
  return text.split(/\r?\n/).map(line => line ? `<p style="${paragraphStyle}">${linkifyText(line)}</p>` : "<br>").join("");
}

export function renderCampaignHtml(input: { subject: string; body: string; unsubscribeUrl: string; template: DomainTemplate }) {
  const color = /^#[\da-f]{6}$/i.test(input.template.accentColor) ? input.template.accentColor : "#4165e8";
  const body = renderTextBody(input.body, "margin:0 0 16px;line-height:1.7");
  const brand = escapeHtml(input.template.brandName || "Widesip");
  const logo = input.template.logoUrl ? `<img src="${escapeHtml(input.template.logoUrl)}" alt="${brand}" width="42" height="42" style="display:block;width:42px;height:42px;object-fit:contain;border-radius:8px">` : "";
  const footer = input.template.footerText ? `<p style="margin:0 0 12px;color:#667085;line-height:1.6">${escapeHtml(input.template.footerText).replaceAll("\n", "<br>")}</p>` : "";
  const unsubscribe = `<a href="${escapeHtml(input.unsubscribeUrl)}" style="color:#667085;text-decoration:underline">Unsubscribe</a>`;
  return `<!doctype html><html><body style="margin:0;padding:24px;background:#f4f6fa;font-family:Arial,Helvetica,sans-serif;color:#25324b"><table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td align="center"><table role="presentation" width="600" cellspacing="0" cellpadding="0" style="width:100%;max-width:600px;background:#fff;border:1px solid #e7eaf0;border-radius:14px;overflow:hidden"><tr><td style="height:5px;background:${color}"></td></tr><tr><td style="padding:26px 32px 16px">${logo}<p style="margin:12px 0 0;color:${color};font-size:13px;font-weight:bold">${brand}</p><h1 style="margin:20px 0 0;color:#25324b;font-size:22px;line-height:1.3">${escapeHtml(input.subject)}</h1></td></tr><tr><td style="padding:12px 32px 30px;font-size:15px">${body}</td></tr><tr><td style="padding:20px 32px;border-top:1px solid #edf0f4;font-size:12px">${footer}<p style="margin:0;color:#667085;font-size:11px">${unsubscribe}</p></td></tr></table></td></tr></table></body></html>`;
}

export function renderBrandedMessageHtml(input: { subject: string; body: string; template: DomainTemplate }) {
  const color = /^#[\da-f]{6}$/i.test(input.template.accentColor) ? input.template.accentColor : "#4165e8";
  const body = renderTextBody(input.body, "margin:0 0 14px;line-height:1.7");
  const brand = escapeHtml(input.template.brandName || "Widesip");
  const logo = input.template.logoUrl ? `<img src="${escapeHtml(input.template.logoUrl)}" alt="${brand}" width="42" height="42" style="display:block;width:42px;height:42px;object-fit:contain;border-radius:8px">` : "";
  const footer = input.template.footerText ? `<p style="margin:0;color:#667085;line-height:1.6">${escapeHtml(input.template.footerText).replaceAll("\n", "<br>")}</p>` : "";
  return `<!doctype html><html><body style="margin:0;padding:24px;background:#f4f6fa;font-family:Arial,Helvetica,sans-serif;color:#25324b"><table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td align="center"><table role="presentation" width="600" cellspacing="0" cellpadding="0" style="width:100%;max-width:600px;background:#fff;border:1px solid #e7eaf0;border-radius:14px;overflow:hidden"><tr><td style="height:5px;background:${color}"></td></tr><tr><td style="padding:24px 30px 12px">${logo}<p style="margin:10px 0 0;color:${color};font-size:13px;font-weight:bold">${brand}</p><h1 style="margin:16px 0 0;color:#25324b;font-size:20px;line-height:1.35">${escapeHtml(input.subject)}</h1></td></tr><tr><td style="padding:14px 30px 25px;font-size:15px">${body}</td></tr>${footer ? `<tr><td style="padding:16px 30px;border-top:1px solid #edf0f4;font-size:12px">${footer}</td></tr>` : ""}</table></td></tr></table></body></html>`;
}
