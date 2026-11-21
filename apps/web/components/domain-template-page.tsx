"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowLeft, Check, Code2, ExternalLink, Image, Monitor, Palette, Save, ShieldCheck, Smartphone } from "lucide-react";
import { StyledSelect } from "./styled-select";

const api = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
type DomainTemplate = { domainId: string; domainName: string; verificationStatus: string; brandName: string; logoUrl: string | null; hasUploadedLogo?: boolean; canUploadLogo?: boolean; accentColor: string; footerText: string; customHtml: string; addresses: Array<{ localPart: string; displayName: string }> };
type Result<T> = { data?: T; message?: string; error?: { message?: string } };

function escapeMarkup(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

const starterCustomHtml = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style>
    body { margin: 0; background: #f3f5f8; color: #25324b; font-family: Arial, sans-serif; }
    .card { max-width: 600px; margin: 32px auto; padding: 36px; background: #fff; border-radius: 16px; }
    .brand { color: #4165e8; font-weight: 700; font-size: 13px; }
    h1 { margin: 24px 0 16px; font-size: 26px; line-height: 1.25; }
    .message { font-size: 16px; line-height: 1.8; }
    .footer { margin-top: 32px; padding-top: 18px; border-top: 1px solid #e7eaf0; color: #667085; font-size: 12px; }
    @media (max-width: 600px) { .card { margin: 10px; padding: 24px 20px; } h1 { font-size: 22px; } }
  </style>
</head>
<body>
  <main class="card">
    <div class="brand">{{brand_name}}</div>
    <h1>{{subject}}</h1>
    <div class="message">{{body}}</div>
    <div class="footer">{{footer}}</div>
  </main>
</body>
</html>`;

export function DomainTemplatePage({ domainId }: { domainId: string }) {
  const [template, setTemplate] = useState<DomainTemplate | null>(null);
  const [brandName, setBrandName] = useState("");
  const [logoUrl, setLogoUrl] = useState("");
  const [logoImageData, setLogoImageData] = useState<string | null | undefined>(undefined);
  const [previewDevice, setPreviewDevice] = useState<"desktop" | "mobile">("desktop");
  const [accentColor, setAccentColor] = useState("#4165e8");
  const [footerText, setFooterText] = useState("");
  const [customHtml, setCustomHtml] = useState("");
  const [previewAddress, setPreviewAddress] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const logoInput = useRef<HTMLInputElement>(null);
  const shownLogo = logoImageData || logoUrl || (template?.hasUploadedLogo ? template.logoUrl : null);
  const selectedPreviewAddress = template?.addresses.find(address => address.localPart === previewAddress) ?? template?.addresses[0];
  const senderName = selectedPreviewAddress?.displayName || selectedPreviewAddress?.localPart || "Your address";
  const senderEmail = selectedPreviewAddress ? `${selectedPreviewAddress.localPart}@${template?.domainName}` : `hello@${template?.domainName ?? "yourdomain.com"}`;
  const customHtmlPreview = (() => {
    if (!customHtml.trim()) return "";
    const replacements: Record<string, string> = {
      subject: "A thoughtful note for you",
      body: "<p style=\"margin:0 0 18px\">Hello there,</p><p style=\"margin:0\">Your message appears here with the domain’s shared visual identity.</p>",
      brand_name: escapeMarkup(brandName || template?.domainName || "Your brand"),
      sender_name: escapeMarkup(senderName),
      sender_address: escapeMarkup(senderEmail),
      logo_url: escapeMarkup(shownLogo || ""),
      footer: escapeMarkup(footerText || "Company name · Mailing address").replaceAll("\n", "<br>"),
      unsubscribe_url: "#unsubscribe-preview",
    };
    let html = customHtml.replace(/<!--[\s\S]*?-->/g, "")
      .replace(/<(script|iframe|object|embed|form|input|button|textarea|select|video|audio)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
      .replace(/<(script|iframe|object|embed|form|input|button|textarea|select|meta|base|video|audio)\b[^>]*\/?>/gi, "")
      .replace(/\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "")
      .replace(/\b(?:javascript|vbscript)\s*:/gi, "")
      .replace(/{{\s*(subject|body|brand_name|sender_name|sender_address|logo_url|footer|unsubscribe_url)\s*}}/gi, (_match, key: string) => replacements[key.toLowerCase()] ?? "");
    if (customHtml.includes("{{body}}") && /unsubscribe_url/i.test(customHtml) === false) html += `<p style=\"margin-top:28px;border-top:1px solid #e7eaf0;padding-top:16px;color:#667085;font-size:12px\">Unsubscribe preview</p>`;
    return /<html[\s>]/i.test(html) ? html : `<!doctype html><html><head><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"></head><body>${html}</body></html>`;
  })();
  const formattedHtmlPreview = (customHtml.trim() ? customHtml : starterCustomHtml).split(String.fromCharCode(92) + "n").join(String.fromCharCode(10));

  useEffect(() => {
    let active = true;
    fetch(`${api}/v1/domains/${encodeURIComponent(domainId)}/template`, { credentials: "include" })
      .then(async response => {
        const result = await response.json() as Result<DomainTemplate>;
        if (!response.ok || !result.data) throw new Error(result.error?.message ?? "Could not load this domain's email design.");
        if (!active) return;
        setTemplate(result.data); setBrandName(result.data.brandName); setLogoUrl(result.data.hasUploadedLogo ? "" : result.data.logoUrl ?? ""); setAccentColor(result.data.accentColor); setFooterText(result.data.footerText); setCustomHtml(result.data.customHtml ?? ""); setPreviewAddress(result.data.addresses[0]?.localPart ?? "");
      })
      .catch(cause => { if (active) setError(cause instanceof Error ? cause.message : "Could not load this domain's email design."); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [domainId]);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setSaving(true); setError(""); setNotice("");
    try {
      const response = await fetch(`${api}/v1/domains/${encodeURIComponent(domainId)}/template`, { method: "PATCH", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ brandName, logoUrl: logoUrl.trim(), ...(logoImageData !== undefined ? { logoImageData } : {}), accentColor, footerText, customHtml }) });
      const result = await response.json() as Result<DomainTemplate>;
      if (!response.ok || !result.data) throw new Error(result.error?.message ?? "Could not save this email design.");
      setTemplate(result.data); setLogoUrl(result.data.hasUploadedLogo ? "" : result.data.logoUrl ?? ""); setLogoImageData(undefined); setNotice(result.message ?? "Domain email design saved.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not save this email design."); }
    finally { setSaving(false); }
  }

  async function chooseLogo(file?: File) {
    if (!file) return;
    setError(""); setNotice("");
    if (!/^image\/(png|jpeg|webp)$/.test(file.type) || file.size > 1_000_000) {
      setError("Choose a PNG, JPG, or WebP logo smaller than 1 MB.");
      if (logoInput.current) logoInput.current.value = "";
      return;
    }
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error("Could not read that logo image."));
        reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("Could not read that logo image."));
        reader.readAsDataURL(file);
      });
      setLogoImageData(dataUrl); setLogoUrl("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not read that logo image."); }
    if (logoInput.current) logoInput.current.value = "";
  }

  return <>
    <div className="page-heading"><div><a className="template-back-link" href={`/app/domains/${domainId}/setup`}><ArrowLeft size={14}/> Back to guided setup</a><h1>{template?.domainName ?? "Domain profile"}</h1><p>Create one identity shared by this domain’s addresses and campaign emails.</p></div></div>
    {error && <p className="team-notice team-error" role="alert">{error}</p>}{notice && <p className="team-notice" role="status"><Check size={14}/>{notice}</p>}
    {loading ? <section className="app-card"><div className="app-loading"><span className="loading-orbit"/>Loading domain template…</div></section> : template && <div className="domain-template-layout">
      <section className="app-card domain-template-card"><div className="settings-section-heading"><span className="settings-icon account"><Palette size={18}/></span><div><span className="usage-section-kicker">SHARED DOMAIN IDENTITY</span><h2>Set up your domain profile</h2><p>This profile gives every address on {template.domainName} a shared brand. The sender name in each email comes from the address used to send it.</p></div></div>
        <form className="domain-template-form" onSubmit={save}><div className="settings-field"><label htmlFor="campaign-brand">Company or brand name</label><input id="campaign-brand" value={brandName} onChange={event => setBrandName(event.target.value)} minLength={2} maxLength={80} required autoComplete="organization"/><small>This is the shared company identity. The From name stays specific to the selected address.</small></div>
          <div className="settings-field"><label htmlFor="campaign-logo">Company logo</label><div className="template-logo-actions"><button type="button" className="button secondary" disabled={template.canUploadLogo === false} onClick={() => logoInput.current?.click()}>{logoImageData ? "Selected — change image" : template.hasUploadedLogo ? "Replace uploaded logo" : "Upload a logo"}</button>{(template.hasUploadedLogo || logoImageData) && <button type="button" className="button secondary" onClick={() => { setLogoImageData(null); setLogoUrl(""); setTemplate(current => current ? { ...current, hasUploadedLogo: false, logoUrl: null } : current); }}>Remove logo</button>}<input ref={logoInput} className="profile-file-input" type="file" accept="image/png,image/jpeg,image/webp" onChange={event => void chooseLogo(event.target.files?.[0])}/></div><small>{template.canUploadLogo === false ? "Image hosting needs WIDESIP_PUBLIC_URL set to your public HTTPS API address. You can still paste a hosted HTTPS image URL below." : "PNG, JPG, or WebP up to 1 MB. Widesip hosts your uploaded logo so recipients can load it."}</small><label className="template-logo-url-label" htmlFor="campaign-logo-url">Or use a logo already hosted publicly</label><input id="campaign-logo-url" type="url" inputMode="url" placeholder="https://yourdomain.com/logo.png" value={logoUrl} onChange={event => { setLogoUrl(event.target.value); if (event.target.value) setLogoImageData(null); }} maxLength={2000}/></div>
          <div className="settings-field"><label htmlFor="campaign-color">Accent color</label><div className="template-color-field"><input id="campaign-color" type="color" value={accentColor} onChange={event => setAccentColor(event.target.value)}/><code>{accentColor.toUpperCase()}</code></div></div>
          <div className="settings-field"><label htmlFor="campaign-footer">Footer text</label><textarea id="campaign-footer" value={footerText} onChange={event => setFooterText(event.target.value)} maxLength={500} rows={4} placeholder="Company name · Postal address · Why you're receiving this email"/><small>Include your organization’s mailing address for marketing email compliance.</small></div>
          <div className="settings-field custom-email-code-field"><div className="custom-email-code-heading"><div><label htmlFor="campaign-custom-html">Custom HTML design</label><small>Paste a responsive email design to replace Widesip’s default layout. Keep CSS inline when possible; most inboxes do not run JavaScript.</small></div><div className="custom-email-code-actions"><button type="button" className="button secondary" onClick={() => setCustomHtml(starterCustomHtml)}>Use starter code</button><button type="button" className="button secondary" onClick={() => setCustomHtml("")}>Use Widesip design</button></div></div><textarea id="campaign-custom-html" className="email-html-editor" value={customHtml} onChange={event => setCustomHtml(event.target.value)} maxLength={60_000} rows={18} spellCheck={false} autoCapitalize="off" autoCorrect="off" placeholder="Paste your HTML email design here, or choose Use starter code."/><small>Required placeholder: <code>{"{{body}}"}</code>. Optional: <code>{"{{subject}}"}</code>, <code>{"{{brand_name}}"}</code>, <code>{"{{sender_name}}"}</code>, <code>{"{{sender_address}}"}</code>, <code>{"{{logo_url}}"}</code>, <code>{"{{footer}}"}</code>. Campaigns also support <code>{"{{unsubscribe_url}}"}</code>; Widesip adds an unsubscribe link automatically if you leave that out. Active content such as scripts and forms is removed.</small></div>
          <div className="settings-form-actions"><button className="button" disabled={saving}>{saving ? "Saving design…" : "Save domain design"}<Save size={14}/></button></div>
        </form>
      </section>
      <aside className="domain-template-aside"><section className="app-card template-preview-card">
        <div className="template-preview-head"><div className="template-preview-label"><Image size={14}/> LIVE EMAIL PREVIEW</div><div className="template-preview-switch" role="group" aria-label="Preview size"><button type="button" className={previewDevice === "desktop" ? "active" : ""} onClick={() => setPreviewDevice("desktop")} aria-pressed={previewDevice === "desktop"}><Monitor size={13}/>Desktop</button><button type="button" className={previewDevice === "mobile" ? "active" : ""} onClick={() => setPreviewDevice("mobile")} aria-pressed={previewDevice === "mobile"}><Smartphone size={13}/>Mobile</button></div></div>
        {(template.addresses?.length ?? 0) > 1 && <div className="template-sender-picker"><label htmlFor="template-preview-address">Preview sender address</label><StyledSelect id="template-preview-address" ariaLabel="Preview sender address" value={selectedPreviewAddress?.localPart ?? ""} onValueChange={setPreviewAddress} options={(template.addresses ?? []).map(address => ({ value: address.localPart, label: `${address.displayName || address.localPart} <${address.localPart}@${template.domainName}>` }))}/></div>}
        <p className="template-sender-note">From <b>{senderName}</b> &lt;{senderEmail}&gt;</p>
        <div className={`template-preview-stage ${previewDevice}`}>{customHtml.trim() ? <iframe className="template-html-frame" title="Custom email design preview" sandbox="" srcDoc={customHtmlPreview}/> : <article className="template-preview"><div className="template-preview-top" style={{ backgroundColor: accentColor }}/><div className="template-preview-brand">{shownLogo ? <img src={shownLogo} alt=""/> : <span style={{ color: accentColor }}>{senderName.slice(0, 1).toUpperCase() || "W"}</span>}<b style={{ color: accentColor }}>{senderName}</b></div><small className="template-preview-company">{brandName || template.domainName}</small><h3>A thoughtful note for you</h3><p>Hello there,<br/><br/>Your message appears here with the domain’s shared visual identity.</p><div className="template-preview-footer">{footerText || "Your company name · Mailing address"}<br/><u>Unsubscribe</u></div></article>}</div>
        <small className="template-preview-caption">The address name appears as the sender. Campaign previews include unsubscribe; Widesip adds that link when needed.</small>
        <details className="template-html-source"><summary><Code2 size={14}/> View {customHtml.trim() ? "saved" : "starter"} responsive HTML</summary><pre><code>{formattedHtmlPreview}</code></pre></details>
      </section>
        <section className="app-card deliverability-card"><div className="deliverability-heading"><ShieldCheck size={16}/><b>Healthy sending habits</b></div><ul><li>Keep SPF and DKIM records verified for {template.domainName}.</li><li>Publish a DMARC policy for the domain and review reports.</li><li>Send campaigns only to people who opted in; remove bounces and complaints.</li><li>Keep the unsubscribe link visible. Widesip includes one-click unsubscribe headers.</li></ul><p>These steps improve trust signals but cannot guarantee inbox placement. Mailbox providers make the final spam decision.</p><a href="/app/domains">Review domain authentication <ExternalLink size={13}/></a></section></aside>
    </div>}
  </>;
}
