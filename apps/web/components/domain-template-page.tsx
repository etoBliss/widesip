"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowLeft, Check, Code2, ExternalLink, Image, Monitor, Palette, Save, ShieldCheck, Smartphone } from "lucide-react";

const api = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
type DomainTemplate = { domainId: string; domainName: string; verificationStatus: string; brandName: string; logoUrl: string | null; hasUploadedLogo?: boolean; canUploadLogo?: boolean; accentColor: string; footerText: string };
type Result<T> = { data?: T; message?: string; error?: { message?: string } };

function escapeMarkup(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

export function DomainTemplatePage({ domainId }: { domainId: string }) {
  const [template, setTemplate] = useState<DomainTemplate | null>(null);
  const [brandName, setBrandName] = useState("");
  const [logoUrl, setLogoUrl] = useState("");
  const [logoImageData, setLogoImageData] = useState<string | null | undefined>(undefined);
  const [previewDevice, setPreviewDevice] = useState<"desktop" | "mobile">("desktop");
  const [accentColor, setAccentColor] = useState("#4165e8");
  const [footerText, setFooterText] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const logoInput = useRef<HTMLInputElement>(null);
  const shownLogo = logoImageData || logoUrl || (template?.hasUploadedLogo ? template.logoUrl : null);
  const htmlPreview = `<!doctype html>\n<html lang="en">\n<head>\n  <meta charset="utf-8">\n  <meta name="viewport" content="width=device-width,initial-scale=1">\n  <style>@media(max-width:600px){.email-card{width:100%!important}.email-pad{padding:22px 18px!important}}</style>\n</head>\n<body style="margin:0;background:#f4f6fa;font-family:Arial,sans-serif;color:#25324b">\n  <table role="presentation" width="100%"><tr><td align="center" style="padding:24px 10px">\n    <table class="email-card" role="presentation" width="600" style="max-width:600px;background:#fff;border-radius:14px;overflow:hidden">\n      <tr><td style="height:5px;background:${accentColor}"></td></tr>\n      <tr><td class="email-pad" style="padding:28px 32px">${shownLogo ? `<img src="${escapeMarkup(shownLogo)}" alt="${escapeMarkup(brandName)}" width="48" height="48" style="object-fit:contain">` : ""}<p style="color:${accentColor};font-weight:bold">${escapeMarkup(brandName || template?.domainName || "Your brand")}</p><h1 style="font-size:22px">A note from ${escapeMarkup(brandName || template?.domainName || "your team")}</h1></td></tr>\n      <tr><td class="email-pad" style="padding:0 32px 30px;line-height:1.7">Your message appears here with the domain’s shared visual identity.</td></tr>\n      <tr><td class="email-pad" style="padding:20px 32px;border-top:1px solid #edf0f4;color:#667085;font-size:12px">${escapeMarkup(footerText || "Company name · Mailing address")}</td></tr>\n    </table>\n  </td></tr></table>\n</body>\n</html>`;
  const formattedHtmlPreview = htmlPreview.split(String.fromCharCode(92) + "n").join(String.fromCharCode(10));

  useEffect(() => {
    let active = true;
    fetch(`${api}/v1/domains/${encodeURIComponent(domainId)}/template`, { credentials: "include" })
      .then(async response => {
        const result = await response.json() as Result<DomainTemplate>;
        if (!response.ok || !result.data) throw new Error(result.error?.message ?? "Could not load this domain's email design.");
        if (!active) return;
        setTemplate(result.data); setBrandName(result.data.brandName); setLogoUrl(result.data.hasUploadedLogo ? "" : result.data.logoUrl ?? ""); setAccentColor(result.data.accentColor); setFooterText(result.data.footerText);
      })
      .catch(cause => { if (active) setError(cause instanceof Error ? cause.message : "Could not load this domain's email design."); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [domainId]);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setSaving(true); setError(""); setNotice("");
    try {
      const response = await fetch(`${api}/v1/domains/${encodeURIComponent(domainId)}/template`, { method: "PATCH", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ brandName, logoUrl: logoUrl.trim(), ...(logoImageData !== undefined ? { logoImageData } : {}), accentColor, footerText }) });
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
      <section className="app-card domain-template-card"><div className="settings-section-heading"><span className="settings-icon account"><Palette size={18}/></span><div><span className="usage-section-kicker">SHARED DOMAIN IDENTITY</span><h2>Set up your domain profile</h2><p>This profile is the default identity for every address on {template.domainName}. Individual addresses can still use their own override image.</p></div></div>
        <form className="domain-template-form" onSubmit={save}><div className="settings-field"><label htmlFor="campaign-brand">Brand or company name</label><input id="campaign-brand" value={brandName} onChange={event => setBrandName(event.target.value)} minLength={2} maxLength={80} required autoComplete="organization"/><small>Shown across messages sent from addresses on this domain and in campaigns.</small></div>
          <div className="settings-field"><label htmlFor="campaign-logo">Company logo</label><div className="template-logo-actions"><button type="button" className="button secondary" disabled={template.canUploadLogo === false} onClick={() => logoInput.current?.click()}>{logoImageData ? "Selected — change image" : template.hasUploadedLogo ? "Replace uploaded logo" : "Upload a logo"}</button>{(template.hasUploadedLogo || logoImageData) && <button type="button" className="button secondary" onClick={() => { setLogoImageData(null); setLogoUrl(""); setTemplate(current => current ? { ...current, hasUploadedLogo: false, logoUrl: null } : current); }}>Remove logo</button>}<input ref={logoInput} className="profile-file-input" type="file" accept="image/png,image/jpeg,image/webp" onChange={event => void chooseLogo(event.target.files?.[0])}/></div><small>{template.canUploadLogo === false ? "Image hosting needs WIDESIP_PUBLIC_URL set to your public HTTPS API address. You can still paste a hosted HTTPS image URL below." : "PNG, JPG, or WebP up to 1 MB. Widesip hosts your uploaded logo so recipients can load it."}</small><label className="template-logo-url-label" htmlFor="campaign-logo-url">Or use a logo already hosted publicly</label><input id="campaign-logo-url" type="url" inputMode="url" placeholder="https://yourdomain.com/logo.png" value={logoUrl} onChange={event => { setLogoUrl(event.target.value); if (event.target.value) setLogoImageData(null); }} maxLength={2000}/></div>
          <div className="settings-field"><label htmlFor="campaign-color">Accent color</label><div className="template-color-field"><input id="campaign-color" type="color" value={accentColor} onChange={event => setAccentColor(event.target.value)}/><code>{accentColor.toUpperCase()}</code></div></div>
          <div className="settings-field"><label htmlFor="campaign-footer">Footer text</label><textarea id="campaign-footer" value={footerText} onChange={event => setFooterText(event.target.value)} maxLength={500} rows={4} placeholder="Company name · Postal address · Why you're receiving this email"/><small>Include your organization’s mailing address for marketing email compliance.</small></div>
          <div className="settings-form-actions"><button className="button" disabled={saving}>{saving ? "Saving design…" : "Save domain design"}<Save size={14}/></button></div>
        </form>
      </section>
      <aside className="domain-template-aside"><section className="app-card template-preview-card"><div className="template-preview-head"><div className="template-preview-label"><Image size={14}/> LIVE EMAIL PREVIEW</div><div className="template-preview-switch" role="group" aria-label="Preview size"><button type="button" className={previewDevice === "desktop" ? "active" : ""} onClick={() => setPreviewDevice("desktop")} aria-pressed={previewDevice === "desktop"}><Monitor size={13}/>Desktop</button><button type="button" className={previewDevice === "mobile" ? "active" : ""} onClick={() => setPreviewDevice("mobile")} aria-pressed={previewDevice === "mobile"}><Smartphone size={13}/>Mobile</button></div></div><div className={`template-preview-stage ${previewDevice}`}><article className="template-preview"><div className="template-preview-top" style={{ backgroundColor: accentColor }}/><div className="template-preview-brand">{shownLogo ? <img src={shownLogo} alt=""/> : <span style={{ color: accentColor }}>{brandName.slice(0, 1).toUpperCase() || "W"}</span>}<b style={{ color: accentColor }}>{brandName || template.domainName}</b></div><h3>A note from {brandName || template.domainName}</h3><p>Your campaign content will appear here. Keep your message readable, useful, and expected by the people receiving it.</p><div className="template-preview-footer">{footerText || "Your company name · Mailing address"}<br/><u>Unsubscribe</u></div></article></div><small className="template-preview-caption">Campaign preview includes its unsubscribe link. Direct messages use this same brand style without that campaign footer link.</small><details className="template-html-source"><summary><Code2 size={14}/> View responsive HTML mockup</summary><pre><code>{formattedHtmlPreview}</code></pre></details></section>
        <section className="app-card deliverability-card"><div className="deliverability-heading"><ShieldCheck size={16}/><b>Healthy sending habits</b></div><ul><li>Keep SPF and DKIM records verified for {template.domainName}.</li><li>Publish a DMARC policy for the domain and review reports.</li><li>Send campaigns only to people who opted in; remove bounces and complaints.</li><li>Keep the unsubscribe link visible. Widesip includes one-click unsubscribe headers.</li></ul><p>These steps improve trust signals but cannot guarantee inbox placement. Mailbox providers make the final spam decision.</p><a href="/app/domains">Review domain authentication <ExternalLink size={13}/></a></section></aside>
    </div>}
  </>;
}
