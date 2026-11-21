import express, { type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import { Pool } from "pg";
import { randomBytes, createHash, createHmac, timingSafeEqual, createCipheriv, createDecipheriv } from "node:crypto";
import { resolveTxt } from "node:dns/promises";
import { toNodeHandler, fromNodeHeaders } from "better-auth/node";
import { and, asc, count, desc, eq, gt, gte, ilike, inArray, like, lt, ne, or, sql } from "drizzle-orm";
import { auth } from "./auth.js";
import { getMailProvider, type MailDnsRecord, type ProviderDomain } from "./modules/mail/provider.js";
import { renderBrandedMessageHtml, sanitizeCustomEmailHtml } from "./modules/mail/campaign-template.js";
import { classifyInboundMessage, normalizeSenderAddress } from "./modules/mail/classification.js";
import { validateEmailAttachments } from "./modules/mail/attachments.js";
import { campaignRouter, handleCampaignEmailEvent } from "./modules/campaigns.js";
import { teamRouter } from "./modules/team.js";
import { campaignRecipients, campaigns, cloudflareConnections, cloudflareOAuthStates, contacts, db, domainEmailTemplates, domains, domainVerifications, emailAliases, mailboxAccess, mailboxes, messageCategoryRules, messageSenderProfiles, messages, rateLimits, sessions, users, workspaceInvitations, workspaceMembers, workspaces, workspaceSubscriptionLinks } from "@widesip/database";
import { aliasCreateSchema, composeEmailSchema, contactCreateSchema, contactUpdateSchema, domainCreateSchema, mailboxCreateSchema, sendTestEmailSchema, workspaceCreateSchema } from "@widesip/validation";

type AuthedRequest = Request & { userId?: string };
const app = express();
const eventStreamPool = new Pool({ connectionString: process.env.DATABASE_URL, max: 32, application_name: "widesip-events" });
const allowedOrigin = process.env.WEB_ORIGIN ?? "http://localhost:3000";
const verificationRecordName = "_widesip-verification";
const challengeLifetimeMs = 30 * 24 * 60 * 60 * 1000;
const usersWithPrivateSpaces = new Set<string>();
function escapeHtml(value: string) { return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;"); }
async function consumeRateLimit(key: string, max: number, windowMs: number) {
  const now = Date.now();
  const resetBefore = now - windowMs;
  const [entry] = await db.insert(rateLimits).values({ id: randomBytes(16).toString("hex"), key: `widesip:rl:${key}`, count: 1, lastRequest: now })
    .onConflictDoUpdate({
      target: rateLimits.key,
      set: {
        count: sql`case when ${rateLimits.lastRequest} <= ${resetBefore} then 1 else ${rateLimits.count} + 1 end`,
        lastRequest: sql`case when ${rateLimits.lastRequest} <= ${resetBefore} then ${now} else ${rateLimits.lastRequest} end`,
      },
    }).returning({ count: rateLimits.count });
  // Opportunistic cleanup keeps abandoned fingerprints from growing forever.
  if (Math.random() < 0.01) {
    await db.delete(rateLimits).where(and(like(rateLimits.key, "widesip:rl:%"), lt(rateLimits.lastRequest, now - 24 * 60 * 60 * 1000)));
  }
  return (entry?.count ?? max + 1) <= max;
}
function rateLimitFingerprint(scope: string, value: string) {
  return createHmac("sha256", process.env.BETTER_AUTH_SECRET ?? "widesip-local-rate-limit")
    .update(`${scope}:${value.trim().toLowerCase()}`).digest("hex");
}

// Apply security headers before any route can send a response. Keep the
// externally embedded newsletter form as the only frameable HTML endpoint;
// all API, auth, and other HTML responses deny framing.
app.use((req, res, next) => {
  const publicSignup = req.path.startsWith("/v1/subscribe/");
  const embeddedSignup = publicSignup && req.query.embed === "1";
  const cspNonce = randomBytes(18).toString("base64");
  res.locals.cspNonce = cspNonce;
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  res.setHeader("Cache-Control", "no-store");
  if (process.env.NODE_ENV === "production") res.setHeader("Strict-Transport-Security", "max-age=31536000");
  if (publicSignup) {
    // The form is intentionally embeddable by customer websites. It contains
    // no authenticated data; the high-entropy public subscription token only
    // identifies the target organization's signup list.
    res.setHeader("Content-Security-Policy", `default-src 'none'; style-src 'nonce-${cspNonce}'; script-src 'nonce-${cspNonce}'; form-action 'self'; base-uri 'none'; frame-ancestors ${embeddedSignup ? "*" : "'none'"}`);
  } else {
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  }
  next();
});

function subscriptionPage(token: string, state: "form" | "success" | "error" = "form", message = "", brandName = "Widesip", embedded = false, cspNonce = "") {
  const content = state === "success"
    ? `<div class="success-mark" aria-hidden="true">✓</div><span class="eyebrow">SUBSCRIPTION CONFIRMED</span><h1>You’re on the list.</h1><p>Thanks for subscribing to ${escapeHtml(brandName)} updates. You can close this page.</p>`
    : `<span class="eyebrow">${escapeHtml(brandName)} &nbsp;·&nbsp; NEWSLETTER</span><h1>Good things,<br>in your inbox.</h1><p>Thoughtful updates, new ideas, and occasional news from ${escapeHtml(brandName)}. Unsubscribe whenever you like.</p>${message ? `<div class="notice" role="alert">${escapeHtml(message)}</div>` : ""}<form method="post" action="/v1/subscribe/${token}${embedded ? "?embed=1" : ""}"><label>First name <input name="firstName" maxlength="100" autocomplete="given-name" required></label><label>Last name <input name="lastName" maxlength="100" autocomplete="family-name"></label><label>Email address <input name="email" type="email" maxlength="254" required autocomplete="email" placeholder="you@example.com"></label><label class="consent"><input type="checkbox" name="consent" value="yes" required><span>I agree to receive email updates. I can unsubscribe at any time.</span></label><div class="website-field" aria-hidden="true"><label>Leave this field empty<input name="website_url" tabindex="-1" autocomplete="off"></label></div><button type="submit">Join the list <span aria-hidden="true">→</span></button><small>We’ll use your email only for ${escapeHtml(brandName)} updates.</small></form>`;
  const embeddedCss = embedded ? ".embedded{min-height:auto;display:block;padding:8px;background:transparent}.embedded .card{width:100%;max-width:none;padding:25px;border:0;box-shadow:none}.embedded .brand-row{margin-bottom:22px}" : "";
  const completionMessage = embedded && state === "success" ? `<script nonce="${cspNonce}">try{parent.postMessage({type:"widesip:subscription-complete"},new URL(document.referrer).origin)}catch{}</script>` : "";
  const pageCss = `
    *{box-sizing:border-box}
    body{min-height:100vh;margin:0;padding:38px 20px;display:grid;place-items:center;background:radial-gradient(ellipse at 50% 0%,#e9edff 0,transparent 44%),#f4f6fb;color:#17243d;font:15px/1.5 Arial,Helvetica,sans-serif}
    .card{width:min(100%,500px);padding:38px 42px 35px;background:#fff;border:1px solid #e4e9f2;border-radius:20px;box-shadow:0 24px 70px #23365b12}
    .brand-row{display:flex;align-items:center;gap:10px;margin-bottom:34px}
    .mark{width:36px;height:36px;display:grid;place-items:center;border-radius:11px;background:#4d63e9;color:#fff;font-size:19px;font-weight:750;box-shadow:0 5px 12px #4d63e933}
    .brand-word{color:#182742;font-size:16px;font-weight:750;letter-spacing:-.45px}
    .eyebrow{display:inline-block;margin-bottom:10px;color:#6274d7;font-size:9px;font-weight:750;letter-spacing:.14em;text-transform:uppercase}
    .card h1{margin:0 0 12px;color:#17243d;font-size:34px;line-height:1.12;letter-spacing:-1.35px}
    .card>p{margin:0 0 27px;color:#748198;font-size:13px;line-height:1.75}
    .card form{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:15px 13px}
    .card form>label:not(.consent){display:grid;gap:7px;color:#364762;font-size:10px;font-weight:700}
    .card form>label:nth-of-type(3),.card form>.consent,.card form>button,.card form>small{grid-column:1/-1}
    .card input:not([type=checkbox]){width:100%;height:45px;padding:0 12px;border:1px solid #dfe5ef;border-radius:9px;background:#fff;color:#17243d;font:13px Arial,Helvetica,sans-serif;transition:border-color .15s,box-shadow .15s}
    .card input::placeholder{color:#a1aabb}
    .card input:focus{outline:0;border-color:#6275e9;box-shadow:0 0 0 3px #6275e91c}
    .consent{display:flex;gap:9px;align-items:flex-start;color:#748198;font-size:10px;line-height:1.55}
    .consent input{width:15px;height:15px;margin:1px 0 0;accent-color:#5269e8;flex:none}
    .card button{height:47px;display:flex;align-items:center;justify-content:center;gap:10px;border:0;border-radius:10px;background:#4d63e9;color:#fff;font-size:12px;font-weight:700;cursor:pointer;box-shadow:0 6px 16px #4d63e92b;transition:transform .15s,background .15s,box-shadow .15s}
    .card button:hover{transform:translateY(-1px);background:#3f55d8;box-shadow:0 9px 20px #4d63e938}
    .card button span{font-size:16px}
    .card form>small{color:#929db0;font-size:9px;line-height:1.55;text-align:center}
    .card-foot{margin:23px 0 0!important;padding-top:15px;border-top:1px solid #edf0f5;color:#a1a9b8!important;font-size:9px!important;line-height:1.5!important;text-align:center}
    .notice{margin:-9px 0 17px;padding:11px 12px;border:1px solid #f0d7d5;border-radius:9px;background:#fff8f7;color:#a34d48;font-size:11px;line-height:1.55}
    .success-mark{width:46px;height:46px;margin-bottom:20px;display:grid;place-items:center;border-radius:14px;background:#e9f7f0;color:#278663;font-size:24px;font-weight:bold}
    .website-field{position:absolute;left:-10000px;width:1px;height:1px;overflow:hidden}
    .embedded{min-height:auto;display:grid;padding:10px;background:transparent}
    .embedded .card{width:100%;max-width:none;padding:28px;border-radius:16px;box-shadow:none}
    .embedded .brand-row{margin-bottom:24px}
    @media(max-width:560px){body{padding:18px 14px}.card{padding:29px 23px;border-radius:16px}.card h1{font-size:29px}.card form{grid-template-columns:1fr}.card form>label{grid-column:1/-1}}
    ${embeddedCss}
  `;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>Subscribe - ${escapeHtml(brandName)}</title><style nonce="${cspNonce}">${pageCss}</style></head><body class="${embedded ? "embedded" : ""}"><main class="card"><div class="brand-row"><div class="mark" aria-hidden="true">w</div><span class="brand-word">widesip</span></div>${content}<p class="card-foot">A calmer way to stay in touch.</p></main>${completionMessage}</body></html>`;
}
function normalizedThreadSubject(subject: string) {
  return subject.trim().replace(/^(?:(?:re|fw|fwd)\s*:\s*)+/i, "").trim().toLowerCase() || "(no subject)";
}
function threadCounterparty(message: { direction: "inbound" | "outbound"; fromAddress: string; toAddresses: string[] }) {
  const source = message.direction === "inbound" ? message.fromAddress : message.toAddresses[0] ?? "";
  return source.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0].toLowerCase() ?? source.trim().toLowerCase();
}
function htmlToSafeText(html: string | null) {
  if (!html) return null;
  return html.replace(/<(script|style|head|title|noscript)[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<(br|hr|\/p|\/div|\/tr|\/li|\/h[1-6])\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">").replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/[ \t]+\n/g, "\n").replace(/\n[ \t]+/g, "\n").replace(/\n{3,}/g, "\n\n").trim().slice(0, 100_000);
}

app.use(cors({
  origin: allowedOrigin,
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "Idempotency-Key", "x-captcha-response"],
}));
// Better Auth must receive the raw request body before express.json consumes it.
app.all("/api/auth/*splat", toNodeHandler(auth));
// Webhook signature verification requires the untouched request bytes.
app.post("/v1/webhooks/resend", express.raw({ type: "application/json", limit: "2mb" }), async (req, res) => {
  const secret = process.env.RESEND_WEBHOOK_SECRET;
  const raw = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : "";
  const svixId = req.header("svix-id") ?? "";
  const svixTimestamp = req.header("svix-timestamp") ?? "";
  const signatures = req.header("svix-signature") ?? "";
  if (!secret || !raw || !svixId || !svixTimestamp || !signatures) return res.status(400).json({ success: false });
  const timestamp = Number(svixTimestamp);
  if (!Number.isFinite(timestamp) || Math.abs(Date.now() / 1000 - timestamp) > 300) return res.status(400).json({ success: false });
  const secretValue = secret.startsWith("whsec_") ? secret.slice(6) : secret;
  const expected = createHmac("sha256", Buffer.from(secretValue, "base64")).update(`${svixId}.${svixTimestamp}.${raw}`).digest();
  const valid = signatures.split(" ").some((entry) => {
    const [version, encoded] = entry.split(",", 2);
    if (version !== "v1" || !encoded) return false;
    try {
      const candidate = Buffer.from(encoded, "base64");
      return candidate.length === expected.length && timingSafeEqual(candidate, expected);
    } catch { return false; }
  });
  if (!valid) return res.status(401).json({ success: false });
  try {
    const event = JSON.parse(raw) as { type?: string; created_at?: string; data?: { email_id?: string; to?: string[]; cc?: string[]; bounce?: { message?: string }; tags?: Record<string, string> } };
    if (event.type !== "email.received") {
      const tracked = await handleCampaignEmailEvent({ type: event.type ?? "", created_at: event.created_at, data: event.data });
      return res.json({ success: true, tracked });
    }
    if (!event.data?.email_id) return res.json({ success: true, ignored: true });
    const provider = getMailProvider();
    const message = await provider.getReceivedMessage(event.data.email_id);
    const recipients = [...(message.to ?? event.data.to ?? []), ...(message.cc ?? event.data.cc ?? [])]
      .map((address) => address.toLowerCase().trim());
    if (!recipients.length) return res.json({ success: true, stored: 0 });
    const candidates = await db.select({ id: mailboxes.id, workspaceId: mailboxes.workspaceId, localPart: mailboxes.localPart, domainName: domains.domainName })
      .from(mailboxes).innerJoin(domains, eq(mailboxes.domainId, domains.id));
    const targetIds = new Set(candidates.filter((box) => recipients.includes(`${box.localPart}@${box.domainName}`.toLowerCase())).map((box) => box.id));
    const aliasMatches = await db.select({ mailboxId: emailAliases.mailboxId, localPart: emailAliases.localPart, domainName: domains.domainName })
      .from(emailAliases).innerJoin(domains, eq(emailAliases.domainId, domains.id))
      .where(eq(emailAliases.status, "active"));
    for (const alias of aliasMatches) {
      if (recipients.includes(`${alias.localPart}@${alias.domainName}`.toLowerCase())) targetIds.add(alias.mailboxId);
    }
    const targets = candidates.filter((box) => targetIds.has(box.id));
    // Resend's receiving endpoint accepts the domain message before this webhook
    // runs, so Widesip cannot reject it during SMTP. It must never auto-create
    // an address or store mail unless the recipient is an existing mailbox or
    // an active alias that routes to one.
    if (!targets.length) return res.json({ success: true, stored: 0, ignoredUnknownRecipients: recipients.length });
    const senderAddress = normalizeSenderAddress(message.from);
    const automaticCategory = classifyInboundMessage({ from: message.from, subject: message.subject, text: message.text, html: message.html });
    const senderRules = targets.length ? await db.select({ mailboxId: messageCategoryRules.mailboxId, category: messageCategoryRules.category })
      .from(messageCategoryRules).where(and(inArray(messageCategoryRules.mailboxId, targets.map(box => box.id)), eq(messageCategoryRules.senderAddress, senderAddress))) : [];
    const categoryByMailbox = new Map(senderRules.map(rule => [rule.mailboxId, rule.category]));
    for (const box of targets) {
      await db.insert(messages).values({
        workspaceId: box.workspaceId, mailboxId: box.id, direction: "inbound", provider: provider.id,
        providerMessageId: message.id, rfcMessageId: message.message_id ?? null,
        fromAddress: message.from, toAddresses: message.to ?? [],
        ccAddresses: message.cc ?? [], subject: message.subject?.trim() || "(no subject)",
        textBody: message.text ?? null, htmlBody: message.html ?? null,
        category: categoryByMailbox.get(box.id) ?? automaticCategory,
        receivedAt: message.created_at ? new Date(message.created_at) : new Date(),
      }).onConflictDoNothing();
    }
    return res.json({ success: true, stored: targets.length });
  } catch (error) {
    console.error("Inbound email webhook failed:", error instanceof Error ? error.message : "unknown error");
    return res.status(500).json({ success: false });
  }
});
app.use(express.json({ limit: "12mb" }));
app.use("/v1", (req: AuthedRequest, res, next) => {
  if (req.path.startsWith("/public/") || req.path.startsWith("/subscribe/") || req.path.startsWith("/subscribe-widget/") || req.path === "/webhooks/resend" || req.path === "/integrations/cloudflare/callback" || req.path === "/workspaces" && req.method === "GET" || req.path === "/account" || req.path.startsWith("/account/")) return next();
  return requireUser(req, res, () => requireVerifiedOrganizationDomain(req, res, next));
});
app.use(campaignRouter);
app.use(teamRouter);

async function requireUser(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
    if (!session) {
      res.status(401).json({ success: false, error: { code: "UNAUTHENTICATED", message: "Sign in to continue." } });
      return;
    }
    req.userId = session.user.id;
    // Personal workspaces are private by definition. Remove any legacy
    // memberships that may have been created before invitations were blocked
    // for personal spaces, before this request reaches a route handler.
    if (!usersWithPrivateSpaces.has(session.user.id)) {
      const sharedPersonal = await db.select({ id: workspaces.id }).from(workspaces)
        .innerJoin(workspaceMembers, eq(workspaceMembers.workspaceId, workspaces.id))
        .where(and(eq(workspaceMembers.userId, session.user.id), eq(workspaces.type, "personal"), ne(workspaces.ownerUserId, session.user.id)));
      if (sharedPersonal.length) {
        const ids = sharedPersonal.map(row => row.id);
        await db.transaction(async tx => {
          await tx.delete(mailboxAccess).where(and(eq(mailboxAccess.userId, session.user.id), inArray(mailboxAccess.workspaceId, ids)));
          await tx.delete(workspaceMembers).where(and(eq(workspaceMembers.userId, session.user.id), inArray(workspaceMembers.workspaceId, ids)));
        });
      }
      usersWithPrivateSpaces.add(session.user.id);
    }
    next();
  } catch (error) {
    next(error);
  }
}

app.get("/v1/security/sessions", requireUser, async (req: AuthedRequest, res, next) => {
  try {
    const headers=fromNodeHeaders(req.headers);
    const current=await auth.api.getSession({headers});
    const active=await db.select({id:sessions.id,createdAt:sessions.createdAt,updatedAt:sessions.updatedAt,expiresAt:sessions.expiresAt,ipAddress:sessions.ipAddress,userAgent:sessions.userAgent})
      .from(sessions).where(and(eq(sessions.userId,req.userId!),gt(sessions.expiresAt,new Date()))).orderBy(desc(sessions.createdAt));
    return res.json({success:true,data:active.map(session=>({...session,current:session.id===current?.session.id}))});
  } catch(error) { next(error); }
});

app.post("/v1/security/sessions/revoke-others", requireUser, async (req, res, next) => {
  try {
    const result=await auth.api.revokeOtherSessions({headers:fromNodeHeaders(req.headers)});
    return res.json({success:true,data:result});
  } catch(error) { next(error); }
});

app.post("/v1/security/sessions/:sessionId/revoke", requireUser, async (req: AuthedRequest, res, next) => {
  try {
    const sessionId=Array.isArray(req.params.sessionId)?req.params.sessionId[0]??"":req.params.sessionId;
    const [target]=await db.select({token:sessions.token}).from(sessions)
      .where(and(eq(sessions.id,sessionId),eq(sessions.userId,req.userId!))).limit(1);
    if(!target) return fail(res,404,"SESSION_NOT_FOUND","That session is no longer active.");
    const result=await auth.api.revokeSession({body:{token:target.token},headers:fromNodeHeaders(req.headers)});
    return res.json({success:true,data:result});
  } catch(error) { next(error); }
});

function fail(res: Response, status: number, code: string, message: string) {
  return res.status(status).json({ success: false, error: { code, message } });
}

async function workspaceRole(workspaceId: string, userId: string) {
  const [membership] = await db.select({ role: workspaceMembers.role }).from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId))).limit(1);
  return membership?.role ?? null;
}

async function memberCanUseMailbox(mailboxId: string, workspaceId: string, userId: string) {
  const [grant] = await db.select({ id: mailboxAccess.id }).from(mailboxAccess)
    .where(and(eq(mailboxAccess.mailboxId, mailboxId), eq(mailboxAccess.workspaceId, workspaceId), eq(mailboxAccess.userId, userId))).limit(1);
  return Boolean(grant);
}

async function requireVerifiedOrganizationDomain(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    let workspaceId = String(req.params.workspaceId ?? req.query.workspaceId ?? req.body?.workspaceId ?? "");
    const id = String(req.params.mailboxId ?? req.params.messageId ?? req.params.contactId ?? req.params.aliasId ?? req.params.domainId ?? req.params.campaignId ?? req.params.invitationId ?? "");
    if (!workspaceId && id) {
      if (req.params.mailboxId) {
        const [row] = await db.select({ workspaceId: mailboxes.workspaceId }).from(mailboxes).where(eq(mailboxes.id, id)).limit(1);
        workspaceId = row?.workspaceId ?? "";
      } else if (req.params.messageId) {
        const [row] = await db.select({ workspaceId: messages.workspaceId }).from(messages).where(eq(messages.id, id)).limit(1);
        workspaceId = row?.workspaceId ?? "";
      } else if (req.params.contactId) {
        const [row] = await db.select({ workspaceId: contacts.workspaceId }).from(contacts).where(eq(contacts.id, id)).limit(1);
        workspaceId = row?.workspaceId ?? "";
      } else if (req.params.aliasId) {
        const [row] = await db.select({ workspaceId: emailAliases.workspaceId }).from(emailAliases).where(eq(emailAliases.id, id)).limit(1);
        workspaceId = row?.workspaceId ?? "";
      } else if (req.params.domainId) {
        const [row] = await db.select({ workspaceId: domains.workspaceId }).from(domains).where(eq(domains.id, id)).limit(1);
        workspaceId = row?.workspaceId ?? "";
      } else if (req.params.campaignId) {
        const [row] = await db.select({ workspaceId: campaigns.workspaceId }).from(campaigns).where(eq(campaigns.id, id)).limit(1);
        workspaceId = row?.workspaceId ?? "";
      } else if (req.params.invitationId) {
        const [row] = await db.select({ workspaceId: workspaceInvitations.workspaceId }).from(workspaceInvitations).where(eq(workspaceInvitations.id, id)).limit(1);
        workspaceId = row?.workspaceId ?? "";
      }
    }
    if (!workspaceId) return next();
    const [access] = await db.select({ type: workspaces.type, role: workspaceMembers.role }).from(workspaces)
      .innerJoin(workspaceMembers, eq(workspaceMembers.workspaceId, workspaces.id))
      .where(and(eq(workspaces.id, workspaceId), eq(workspaceMembers.userId, req.userId!))).limit(1);
    if (!access) return fail(res, 404, "WORKSPACE_NOT_FOUND", "The workspace could not be found.");
    if (access.type === "personal") {
      const [teamAccess] = await db.select({ id: workspaces.id }).from(workspaces)
        .innerJoin(workspaceMembers, eq(workspaceMembers.workspaceId, workspaces.id))
        .where(and(eq(workspaceMembers.userId, req.userId!), eq(workspaces.type, "organization"))).limit(1);
      if (!teamAccess) return fail(res, 403, "TEAM_MEMBERSHIP_REQUIRED", "Join an organization team before accessing workspace features.");
    }
    if (access.type === "organization") {
      const [verified] = await db.select({ id: domains.id }).from(domains)
        .where(and(eq(domains.workspaceId, workspaceId), eq(domains.verificationStatus, "verified"))).limit(1);
      if (!verified && !req.path.startsWith("/domains")) return fail(res, 403, "DOMAIN_VERIFICATION_REQUIRED", "Verify an organization domain before using the rest of this workspace.");
    }
    return next();
  } catch (error) { return next(error); }
}

app.get("/v1/events/inbox", requireUser, async (req: AuthedRequest, res, next) => {
  const workspaceId = String(req.query.workspaceId ?? "");
  if (!workspaceId) return fail(res, 400, "WORKSPACE_REQUIRED", "Select a workspace.");
  let listener: import("pg").PoolClient | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  const close = () => {
    if (heartbeat) clearInterval(heartbeat);
    if (listener) {
      const client = listener;
      listener = null;
      client.removeAllListeners("notification");
      void client.query("UNLISTEN widesip_updates").catch(() => {}).finally(() => client.release());
    }
  };
  try {
    const [membership] = await db.select({ role: workspaceMembers.role }).from(workspaceMembers)
      .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, req.userId!))).limit(1);
    if (!membership) return fail(res, 404, "WORKSPACE_NOT_FOUND", "The workspace could not be found.");
    const allowedMailboxIds = membership.role === "member"
      ? (await db.select({ mailboxId: mailboxAccess.mailboxId }).from(mailboxAccess)
          .where(and(eq(mailboxAccess.workspaceId, workspaceId), eq(mailboxAccess.userId, req.userId!)))).map(row => row.mailboxId)
      : null;
    res.status(200).set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    res.flushHeaders();
    res.on("close", close);
    res.on("error", close);
    listener = await eventStreamPool.connect();
    if (res.destroyed) { close(); return; }
    await listener.query("LISTEN widesip_updates");
    if (res.destroyed) { close(); return; }
    listener.on("notification", notification => {
      if (notification.channel !== "widesip_updates" || !notification.payload) return;
      try {
        const event = JSON.parse(notification.payload) as { workspaceId?: string; mailboxId?: string; type?: string };
        if (event.workspaceId !== workspaceId || !event.mailboxId) return;
        if (allowedMailboxIds && !allowedMailboxIds.includes(event.mailboxId)) return;
        const eventName = event.type === "campaign" ? "campaign-update" : "inbox-update";
        res.write(`event: ${eventName}\ndata: ${JSON.stringify({ mailboxId: event.mailboxId })}\n\n`);
      } catch { /* Ignore malformed database notification payloads. */ }
    });
    heartbeat = setInterval(() => res.write(": keep-alive\n\n"), 25_000);
    // A request's `close` event can fire once the request body is consumed,
    // even though its streaming response is still open. Tie cleanup to the
    // response socket instead so the listener survives until the client leaves.
    res.write(`event: ready\ndata: ${JSON.stringify({ workspaceId })}\n\n`);
  } catch (error) {
    close();
    if (!res.headersSent) return next(error);
    res.end();
  }
});

function makeDnsVerification(domainName: string, tokenHash: string, expiresAt: Date, verifiedAt: Date | null) {
  return {
    type: "TXT" as const,
    name: verificationRecordName,
    hostname: `${verificationRecordName}.${domainName}`,
    value: `widesip-verification=${tokenHash}`,
    expiresAt,
    status: verifiedAt ? "verified" as const : "pending" as const,
  };
}

function newChallenge() {
  // The TXT value is a public proof-of-control challenge, not an account credential.
  return createHash("sha256").update(randomBytes(32)).digest("hex");
}

function isExpectedDnsMiss(error: unknown) {
  if (!error || typeof error !== "object" || !("code" in error)) return false;
  return ["ENODATA", "ENOTFOUND", "ETIMEOUT", "ESERVFAIL", "ECONNREFUSED"].includes(String(error.code));
}

type CloudflareDnsRecord = { id: string; type: string; name: string; content: string; priority?: number };

async function cloudflareRequest<T>(path: string, init: RequestInit = {}, authorizedToken?: string): Promise<T> {
  const token = authorizedToken ?? (process.env.NODE_ENV !== "production" ? process.env.CLOUDFLARE_API_TOKEN : undefined);
  if (!token) throw new Error("Connect this organization's Cloudflare account to automate DNS, or add the displayed DNS records manually.");
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
  const payload = await response.json().catch(() => ({})) as { success?: boolean; errors?: Array<{ message?: string }>; result?: T };
  if (!response.ok || !payload.success) throw new Error(payload.errors?.[0]?.message ?? `Cloudflare returned HTTP ${response.status}.`);
  return payload.result as T;
}

function cloudflareEncryptionKey() {
  const encoded = process.env.CLOUDFLARE_TOKEN_ENCRYPTION_KEY;
  if (!encoded) throw new Error("Cloudflare token encryption is not configured.");
  const key = Buffer.from(encoded, "base64");
  if (key.length !== 32) throw new Error("CLOUDFLARE_TOKEN_ENCRYPTION_KEY must be base64 for exactly 32 random bytes.");
  return key;
}
function encryptCloudflareSecret(value: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", cloudflareEncryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return `v1.${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${ciphertext.toString("base64url")}`;
}
function decryptCloudflareSecret(value: string) {
  const [version, iv, tag, ciphertext] = value.split(".");
  if (version !== "v1" || !iv || !tag || !ciphertext) throw new Error("Stored Cloudflare credential has an unsupported format.");
  const decipher = createDecipheriv("aes-256-gcm", cloudflareEncryptionKey(), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64url")), decipher.final()]).toString("utf8");
}
function cloudflareOAuthConfig() {
  const { CLOUDFLARE_OAUTH_CLIENT_ID: clientId, CLOUDFLARE_OAUTH_CLIENT_SECRET: clientSecret, CLOUDFLARE_OAUTH_REDIRECT_URI: redirectUri } = process.env;
  const scopes = (process.env.CLOUDFLARE_OAUTH_SCOPES ?? "").trim();
  if (!clientId || !clientSecret || !redirectUri || !scopes) return null;
  const encodedKey = process.env.CLOUDFLARE_TOKEN_ENCRYPTION_KEY;
  if (!encodedKey || Buffer.from(encodedKey, "base64").length !== 32) return null;
  const callback = new URL(redirectUri);
  if (process.env.NODE_ENV === "production" && callback.protocol !== "https:") throw new Error("Cloudflare OAuth redirect URI must use HTTPS in production.");
  return { clientId, clientSecret, redirectUri: callback.toString(), scopes };
}
async function cloudflareOAuthApi<T>(path: string, accessToken: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
  const payload = await response.json().catch(() => ({})) as { success?: boolean; errors?: Array<{ message?: string }>; result?: T };
  if (!response.ok || payload.success === false) throw new Error(payload.errors?.[0]?.message ?? `Cloudflare returned HTTP ${response.status}.`);
  return payload.result as T;
}
async function freshCloudflareAccessToken(domainId: string) {
  // Serialize refreshes across API replicas to prevent two requests consuming
  // a rotating refresh token at the same time.
  return db.transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`cloudflare:${domainId}`}))`);
    const [connection] = await tx.select().from(cloudflareConnections).where(eq(cloudflareConnections.domainId, domainId)).limit(1);
    if (!connection) return null;
    if (connection.accessTokenExpiresAt.getTime() > Date.now() + 60_000) return decryptCloudflareSecret(connection.accessTokenEncrypted);
    const config = cloudflareOAuthConfig();
    if (!config) throw new Error("Cloudflare OAuth is not configured.");
    const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: decryptCloudflareSecret(connection.refreshTokenEncrypted) });
    const response = await fetch("https://dash.cloudflare.com/oauth2/token", {
      method: "POST",
      headers: { Authorization: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64")}`, "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    const token = await response.json().catch(() => ({})) as { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string; error_description?: string };
    if (!response.ok || !token.access_token || !token.refresh_token) throw new Error(token.error_description ?? "Cloudflare authorization expired. Reconnect Cloudflare to continue.");
    await tx.update(cloudflareConnections).set({
      accessTokenEncrypted: encryptCloudflareSecret(token.access_token), refreshTokenEncrypted: encryptCloudflareSecret(token.refresh_token),
      accessTokenExpiresAt: new Date(Date.now() + Math.max(60, token.expires_in ?? 3600) * 1000), scopes: token.scope ?? connection.scopes, updatedAt: new Date(),
    }).where(eq(cloudflareConnections.id, connection.id));
    return token.access_token;
  });
}

app.post("/v1/domains/:domainId/cloudflare/connect", requireUser, async (req: AuthedRequest, res, next) => {
  try {
    const config = cloudflareOAuthConfig();
    if (!config) return fail(res, 503, "CLOUDFLARE_OAUTH_NOT_CONFIGURED", "Cloudflare connection is not configured yet. DNS records are still available for manual setup.");
    const [domain] = await db.select({ id: domains.id, workspaceId: domains.workspaceId, domainName: domains.domainName, verificationStatus: domains.verificationStatus, role: workspaceMembers.role, workspaceType: workspaces.type })
      .from(domains).innerJoin(workspaceMembers, eq(workspaceMembers.workspaceId, domains.workspaceId)).innerJoin(workspaces, eq(workspaces.id, domains.workspaceId))
      .where(and(eq(domains.id, String(req.params.domainId)), eq(workspaceMembers.userId, req.userId!))).limit(1);
    if (!domain) return fail(res, 404, "DOMAIN_NOT_FOUND", "The domain could not be found.");
    if (domain.workspaceType !== "organization") return fail(res, 403, "ORGANIZATION_REQUIRED", "Cloudflare automation is available for organization domains.");
    if (!["owner", "admin"].includes(domain.role)) return fail(res, 403, "FORBIDDEN", "Only an organization owner or admin can connect Cloudflare.");
    if (domain.verificationStatus !== "verified") return fail(res, 409, "DOMAIN_NOT_VERIFIED", "Verify this domain before connecting Cloudflare.");
    const state = randomBytes(32).toString("base64url");
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    await db.delete(cloudflareOAuthStates).where(lt(cloudflareOAuthStates.expiresAt, new Date()));
    await db.insert(cloudflareOAuthStates).values({
      stateHash: createHash("sha256").update(state).digest("hex"), workspaceId: domain.workspaceId, domainId: domain.id,
      userId: req.userId!, codeVerifierEncrypted: encryptCloudflareSecret(verifier), expiresAt: new Date(Date.now() + 10 * 60_000),
    });
    const authorize = new URL("https://dash.cloudflare.com/oauth2/auth");
    authorize.search = new URLSearchParams({ client_id: config.clientId, redirect_uri: config.redirectUri, response_type: "code", scope: config.scopes, state, code_challenge: challenge, code_challenge_method: "S256" }).toString();
    return res.json({ success: true, data: { authorizationUrl: authorize.toString() } });
  } catch (error) { next(error); }
});

app.get("/v1/domains/:domainId/cloudflare/status", requireUser, async (req: AuthedRequest, res, next) => {
  try {
    const [domain] = await db.select({ id: domains.id, workspaceId: domains.workspaceId, domainName: domains.domainName, cloudflareZoneId: domains.cloudflareZoneId, cloudflareZoneName: domains.cloudflareZoneName, role: workspaceMembers.role })
      .from(domains).innerJoin(workspaceMembers, eq(workspaceMembers.workspaceId, domains.workspaceId))
      .where(and(eq(domains.id, String(req.params.domainId)), eq(workspaceMembers.userId, req.userId!))).limit(1);
    if (!domain) return fail(res, 404, "DOMAIN_NOT_FOUND", "The domain could not be found.");
    const [connection] = await db.select({ updatedAt: cloudflareConnections.updatedAt }).from(cloudflareConnections).where(eq(cloudflareConnections.domainId, domain.id)).limit(1);
    return res.json({ success: true, data: { connected: Boolean(connection && domain.cloudflareZoneId), zoneName: domain.cloudflareZoneName, connectedAt: connection?.updatedAt ?? null, canManage: ["owner", "admin"].includes(domain.role), configured: Boolean(cloudflareOAuthConfig()) } });
  } catch (error) { next(error); }
});

app.get("/v1/integrations/cloudflare/callback", async (req, res) => {
  const web = (process.env.WEB_ORIGIN ?? "https://widesi.online").replace(/\/$/, "");
  const errorUrl = (code: string) => res.redirect(`${web}/app/domains?cloudflare=${encodeURIComponent(code)}`);
  try {
    const config = cloudflareOAuthConfig();
    const code = typeof req.query.code === "string" ? req.query.code : "";
    const state = typeof req.query.state === "string" ? req.query.state : "";
    if (!config || !code || !state || req.query.error) return errorUrl("failed");
    const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
    if (!session) return errorUrl("sign-in-required");
    const stateHash = createHash("sha256").update(state).digest("hex");
    const [pending] = await db.delete(cloudflareOAuthStates).where(and(eq(cloudflareOAuthStates.stateHash, stateHash), gt(cloudflareOAuthStates.expiresAt, new Date()), eq(cloudflareOAuthStates.userId, session.user.id))).returning();
    if (!pending) return errorUrl("expired");
    const verifier = decryptCloudflareSecret(pending.codeVerifierEncrypted);
    const body = new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: config.redirectUri, code_verifier: verifier });
    const tokenResponse = await fetch("https://dash.cloudflare.com/oauth2/token", {
      method: "POST", headers: { Authorization: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64")}`, "Content-Type": "application/x-www-form-urlencoded" }, body,
    });
    const token = await tokenResponse.json().catch(() => ({})) as { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string; error_description?: string };
    if (!tokenResponse.ok || !token.access_token || !token.refresh_token) {
      console.error("[cloudflare-oauth] Token exchange failed", { status: tokenResponse.status, detail: token.error_description });
      return errorUrl("failed");
    }
    type Zone = { id: string; name: string; status: string };
    const zones: Zone[] = [];
    for (let page = 1; page <= 10; page++) {
      const batch = await cloudflareOAuthApi<Zone[]>(`/zones?per_page=50&page=${page}`, token.access_token);
      zones.push(...batch);
      if (batch.length < 50) break;
    }
    const [domain] = await db.select({ id: domains.id, workspaceId: domains.workspaceId, domainName: domains.domainName, verificationStatus: domains.verificationStatus })
      .from(domains).where(and(eq(domains.id, pending.domainId), eq(domains.workspaceId, pending.workspaceId))).limit(1);
    if (!domain || domain.verificationStatus !== "verified") return errorUrl("domain-changed");
    const callbackRole = await workspaceRole(pending.workspaceId, session.user.id);
    if (!["owner", "admin"].includes(callbackRole ?? "")) return errorUrl("access-changed");
    const normalized = domain.domainName.toLowerCase();
    const zone = zones.filter(item => item.status === "active" && (normalized === item.name.toLowerCase() || normalized.endsWith(`.${item.name.toLowerCase()}`)))
      .sort((a, b) => b.name.length - a.name.length)[0];
    if (!zone) return errorUrl("zone-not-found");
    const now = new Date();
    await db.transaction(async tx => {
      await tx.insert(cloudflareConnections).values({
        workspaceId: pending.workspaceId, domainId: pending.domainId, connectedByUserId: session.user.id,
        accessTokenEncrypted: encryptCloudflareSecret(token.access_token!), refreshTokenEncrypted: encryptCloudflareSecret(token.refresh_token!),
        accessTokenExpiresAt: new Date(Date.now() + Math.max(60, token.expires_in ?? 3600) * 1000), scopes: token.scope ?? config.scopes, createdAt: now, updatedAt: now,
      }).onConflictDoUpdate({ target: cloudflareConnections.domainId, set: {
        connectedByUserId: session.user.id, accessTokenEncrypted: encryptCloudflareSecret(token.access_token!), refreshTokenEncrypted: encryptCloudflareSecret(token.refresh_token!),
        accessTokenExpiresAt: new Date(Date.now() + Math.max(60, token.expires_in ?? 3600) * 1000), scopes: token.scope ?? config.scopes, updatedAt: now,
      } });
      await tx.update(domains).set({ cloudflareZoneId: zone.id, cloudflareZoneName: zone.name }).where(eq(domains.id, domain.id));
    });
    return res.redirect(`${web}/app/domains/${encodeURIComponent(domain.id)}/setup?cloudflare=connected`);
  } catch (error) {
    console.error("[cloudflare-oauth] Callback failed", error instanceof Error ? error.message : "unknown error");
    return errorUrl("failed");
  }
});

function normalizedDnsName(name: string, zone: string) {
  const normalizedZone = zone.trim().replace(/\.$/, "").toLowerCase();
  const trimmed = name.trim().replace(/\.$/, "").toLowerCase();
  if (!trimmed || trimmed === "@" || trimmed === normalizedZone) return normalizedZone;
  return trimmed.endsWith(`.${normalizedZone}`) ? trimmed : `${trimmed}.${normalizedZone}`;
}

function comparableDnsValue(value: string) {
  return value.trim().replace(/^"(.*)"$/, "$1").replace(/\.$/, "").toLowerCase();
}

function emailAddressFromHeader(value: string) {
  const bracketed = value.match(/<([^<>]+)>/);
  return (bracketed?.[1] ?? value).trim().toLowerCase();
}

app.get("/health", (_req, res) => res.json({ success: true, data: { status: "ok" } }));
app.get("/ready", async (_req, res) => {
  const missing = process.env.NODE_ENV === "production"
    ? [
        ["RESEND_API_KEY", Boolean(process.env.RESEND_API_KEY)],
        ["RESEND_FROM", Boolean(process.env.RESEND_FROM && !/your[-_ ]verified[-_ ]domain|example\.com/i.test(process.env.RESEND_FROM))],
        ["RESEND_WEBHOOK_SECRET", Boolean(process.env.RESEND_WEBHOOK_SECRET)],
        ["WIDESIP_PUBLIC_URL", Boolean(process.env.WIDESIP_PUBLIC_URL?.startsWith("https://"))],
        ["CAMPAIGN_UNSUBSCRIBE_SECRET", Boolean(process.env.CAMPAIGN_UNSUBSCRIBE_SECRET && process.env.CAMPAIGN_UNSUBSCRIBE_SECRET.length >= 32)],
        ["CLOUDFLARE_OAUTH_CLIENT_ID", Boolean(process.env.CLOUDFLARE_OAUTH_CLIENT_ID)],
        ["CLOUDFLARE_OAUTH_CLIENT_SECRET", Boolean(process.env.CLOUDFLARE_OAUTH_CLIENT_SECRET)],
        ["CLOUDFLARE_OAUTH_REDIRECT_URI", Boolean(process.env.CLOUDFLARE_OAUTH_REDIRECT_URI?.startsWith("https://"))],
        ["CLOUDFLARE_OAUTH_SCOPES", Boolean(process.env.CLOUDFLARE_OAUTH_SCOPES?.trim())],
        ["CLOUDFLARE_TOKEN_ENCRYPTION_KEY", Boolean(process.env.CLOUDFLARE_TOKEN_ENCRYPTION_KEY && Buffer.from(process.env.CLOUDFLARE_TOKEN_ENCRYPTION_KEY, "base64").length === 32)],
      ].filter(([, configured]) => !configured).map(([name]) => name)
    : [];
  let database = "ok";
  try { await db.execute(sql`select 1`); }
  catch { database = "unavailable"; }
  const ready = database === "ok" && missing.length === 0;
  return res.status(ready ? 200 : 503).json({ success: ready, data: { status: ready ? "ready" : "not_ready", database, missing } });
});

app.get("/v1/workspaces", requireUser, async (req: AuthedRequest, res, next) => {
  try {
    const [profile] = await db.select({ onboardingComplete: users.onboardingComplete, accountType: users.accountType }).from(users).where(eq(users.id, req.userId!)).limit(1);
    if (!profile?.onboardingComplete) return fail(res, 403, "ONBOARDING_REQUIRED", "Complete your account setup before opening a workspace.");
    // Organization accounts start in their organization workspace. Personal
    // spaces are created for personal accounts and invitation recipients.
    if (profile.accountType === "personal") await db.transaction(async tx => {
      let [personal] = await tx.select({ id: workspaces.id }).from(workspaces)
        .where(and(eq(workspaces.ownerUserId, req.userId!), eq(workspaces.type, "personal"))).limit(1);
      if (!personal) {
        [personal] = await tx.insert(workspaces).values({ name: "My personal space", type: "personal", ownerUserId: req.userId! }).returning({ id: workspaces.id });
      }
      const [membership] = await tx.select({ id: workspaceMembers.id }).from(workspaceMembers)
        .where(and(eq(workspaceMembers.workspaceId, personal.id), eq(workspaceMembers.userId, req.userId!))).limit(1);
      if (!membership) await tx.insert(workspaceMembers).values({ workspaceId: personal.id, userId: req.userId!, role: "owner" });
    });
    const rows = await db.select({
      id: workspaces.id,
      name: workspaces.name,
      type: workspaces.type,
      role: workspaceMembers.role,
      createdAt: workspaces.createdAt,
    }).from(workspaceMembers)
      .innerJoin(workspaces, eq(workspaceMembers.workspaceId, workspaces.id))
      .where(eq(workspaceMembers.userId, req.userId!))
      .orderBy(asc(workspaces.createdAt));
    const withDomainStatus = await Promise.all(rows.map(async row => {
      if (row.type !== "organization") return { ...row, hasVerifiedDomain: true };
      const [verified] = await db.select({ id: domains.id }).from(domains)
        .where(and(eq(domains.workspaceId, row.id), eq(domains.verificationStatus, "verified"))).limit(1);
      return { ...row, hasVerifiedDomain: Boolean(verified) };
    }));
    res.json({ success: true, data: withDomainStatus });
  } catch (error) {
    next(error);
  }
});

app.post("/v1/workspaces", requireUser, async (req: AuthedRequest, res, next) => {
  const parsed = workspaceCreateSchema.safeParse(req.body);
  if (!parsed.success) return fail(res, 400, "INVALID_INPUT", "Enter a workspace name and type.");
  try {
    const [profile] = await db.select({ accountType: users.accountType, onboardingComplete: users.onboardingComplete }).from(users).where(eq(users.id, req.userId!)).limit(1);
    if (!profile?.onboardingComplete) return fail(res, 403, "ONBOARDING_REQUIRED", "Complete your account setup before creating a workspace.");
    if (parsed.data.type === "organization" && profile.accountType !== "organization") return fail(res, 403, "PERSONAL_ACCOUNT_CANNOT_CREATE_TEAM", "Personal accounts can join organization teams but cannot create them.");
    if (parsed.data.type === "personal") {
      const [existingPersonal] = await db.select({ id: workspaces.id }).from(workspaces)
        .where(and(eq(workspaces.ownerUserId, req.userId!), eq(workspaces.type, "personal"))).limit(1);
      if (existingPersonal) return fail(res, 409, "PERSONAL_WORKSPACE_EXISTS", "Your personal workspace already exists.");
    }
    const created = await db.transaction(async (tx) => {
      const [workspace] = await tx.insert(workspaces).values({
        name: parsed.data.name,
        type: parsed.data.type,
        ownerUserId: req.userId!,
      }).returning();
      await tx.insert(workspaceMembers).values({ workspaceId: workspace.id, userId: req.userId!, role: "owner" });
      return workspace;
    });
    res.status(201).json({ success: true, data: created });
  } catch (error) {
    next(error);
  }
});

app.get("/v1/account", requireUser, async (req: AuthedRequest, res, next) => {
  try {
    const [account] = await db.select({ id: users.id, name: users.name, email: users.email, emailVerified: users.emailVerified, image: users.image, accountType: users.accountType, dateOfBirth: users.dateOfBirth, organizationName: users.organizationName, onboardingComplete: users.onboardingComplete, createdAt: users.createdAt })
      .from(users).where(eq(users.id, req.userId!)).limit(1);
    if (!account) return fail(res, 404, "ACCOUNT_NOT_FOUND", "Your account could not be found.");
    return res.json({ success: true, data: account });
  } catch (error) { next(error); }
});

app.patch("/v1/account", requireUser, async (req: AuthedRequest, res, next) => {
  const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
  if (name.length < 2 || name.length > 80) return fail(res, 400, "INVALID_NAME", "Your name must be between 2 and 80 characters.");
  const imageProvided = Object.prototype.hasOwnProperty.call(req.body ?? {}, "image");
  const image = req.body?.image;
  if (imageProvided && image !== null && (typeof image !== "string" || !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(image) || Buffer.byteLength(image, "utf8") > 1_500_000)) {
    return fail(res, 400, "INVALID_PROFILE_IMAGE", "Choose a PNG, JPG, or WebP image smaller than 1 MB.");
  }
  try {
    const [updated] = await db.update(users).set({ name, ...(imageProvided ? { image } : {}), updatedAt: new Date() }).where(eq(users.id, req.userId!))
      .returning({ id: users.id, name: users.name, email: users.email, emailVerified: users.emailVerified, image: users.image, accountType: users.accountType, dateOfBirth: users.dateOfBirth, onboardingComplete: users.onboardingComplete, createdAt: users.createdAt });
    if (!updated) return fail(res, 404, "ACCOUNT_NOT_FOUND", "Your account could not be found.");
    return res.json({ success: true, data: updated, message: "Your account name was updated." });
  } catch (error) { next(error); }
});

app.post("/v1/account/complete-onboarding", requireUser, async (req: AuthedRequest, res, next) => {
  const dob = typeof req.body?.dateOfBirth === "string" ? req.body.dateOfBirth : "";
  const requestedType = req.body?.accountType;
  const organizationName = typeof req.body?.organizationName === "string" ? req.body.organizationName.trim() : "";
  const inviteToken = typeof req.body?.inviteToken === "string" ? req.body.inviteToken : "";
  const dobDate = /^\d{4}-\d{2}-\d{2}$/.test(dob) ? new Date(`${dob}T00:00:00.000Z`) : null;
  if (!dobDate || Number.isNaN(dobDate.getTime()) || dobDate.toISOString().slice(0, 10) !== dob || dob < "1900-01-01" || dobDate.getTime() > Date.now()) {
    return fail(res, 400, "INVALID_DATE_OF_BIRTH", "Enter a valid date of birth that is not in the future.");
  }
  if (requestedType !== "personal" && requestedType !== "organization") return fail(res, 400, "INVALID_ACCOUNT_TYPE", "Choose a personal or organization account.");
  if (requestedType === "organization" && (organizationName.length < 2 || organizationName.length > 80)) return fail(res, 400, "INVALID_ORGANIZATION_NAME", "Enter an organization name between 2 and 80 characters.");
  try {
    const outcome = await db.transaction(async tx => {
    const [person] = await tx.select({ id: users.id, name: users.name, email: users.email, emailVerified: users.emailVerified, accountType: users.accountType, dateOfBirth: users.dateOfBirth, organizationName: users.organizationName, onboardingComplete: users.onboardingComplete })
        .from(users).where(eq(users.id, req.userId!)).limit(1);
      if (!person) return { error: "ACCOUNT_NOT_FOUND" as const };
      if (!person.emailVerified) return { error: "EMAIL_NOT_VERIFIED" as const };
      if (person.onboardingComplete) {
        const [personal] = await tx.select({ id: workspaces.id }).from(workspaces).where(and(eq(workspaces.ownerUserId, person.id), eq(workspaces.type, "personal"))).limit(1);
        const [organization] = await tx.select({ id: workspaces.id }).from(workspaces).where(and(eq(workspaces.ownerUserId, person.id), eq(workspaces.type, "organization"))).orderBy(asc(workspaces.createdAt)).limit(1);
        return { completed: true as const, accountType: person.accountType, personalWorkspaceId: personal?.id ?? null, organizationWorkspaceId: organization?.id ?? null };
      }
      if (person.dateOfBirth && person.dateOfBirth !== dob) return { error: "SIGNUP_DETAILS_MISMATCH" as const };
      if (!inviteToken && person.dateOfBirth && person.accountType !== requestedType) return { error: "ACCOUNT_TYPE_LOCKED" as const };
      let accountType = requestedType;
      if (inviteToken) {
        const tokenHash = createHash("sha256").update(inviteToken).digest("hex");
        const [invitation] = await tx.select({ id: workspaceInvitations.id, email: workspaceInvitations.email, workspaceId: workspaceInvitations.workspaceId, status: workspaceInvitations.status, expiresAt: workspaceInvitations.expiresAt, workspaceType: workspaces.type })
          .from(workspaceInvitations).innerJoin(workspaces, eq(workspaces.id, workspaceInvitations.workspaceId)).where(eq(workspaceInvitations.tokenHash, tokenHash)).limit(1);
        if (!invitation || invitation.status !== "pending" || invitation.expiresAt <= new Date() || invitation.workspaceType !== "organization") return { error: "INVITATION_INVALID" as const };
        if (person.email.toLowerCase() !== invitation.email.toLowerCase()) return { error: "INVITATION_EMAIL_MISMATCH" as const };
        accountType = "personal";
      }
      let personalWorkspaceId: string | null = null;
      if (accountType === "personal") {
        const [personal] = await tx.select({ id: workspaces.id }).from(workspaces).where(and(eq(workspaces.ownerUserId, person.id), eq(workspaces.type, "personal"))).limit(1);
        personalWorkspaceId = personal?.id ?? null;
        if (!personalWorkspaceId) {
          const [created] = await tx.insert(workspaces).values({ name: person.name, type: "personal", ownerUserId: person.id }).returning({ id: workspaces.id });
          if (!created) throw new Error("Could not create the personal workspace.");
          personalWorkspaceId = created.id;
          await tx.insert(workspaceMembers).values({ workspaceId: created.id, userId: person.id, role: "owner" });
        }
      }
      let organizationWorkspaceId: string | null = null;
      if (accountType === "organization") {
        const [existingOrg] = await tx.select({ id: workspaces.id }).from(workspaces)
          .where(and(eq(workspaces.ownerUserId, person.id), eq(workspaces.type, "organization"))).orderBy(asc(workspaces.createdAt)).limit(1);
        if (existingOrg) organizationWorkspaceId = existingOrg.id;
        else {
          const [created] = await tx.insert(workspaces).values({ name: organizationName, type: "organization", ownerUserId: person.id }).returning({ id: workspaces.id });
          if (!created) throw new Error("Could not create the organization workspace.");
          organizationWorkspaceId = created.id;
          await tx.insert(workspaceMembers).values({ workspaceId: created.id, userId: person.id, role: "owner" });
        }
      }
      await tx.update(users).set({ accountType, dateOfBirth: dob, organizationName: null, onboardingComplete: true, updatedAt: new Date() }).where(eq(users.id, person.id));
      return { completed: true as const, accountType, personalWorkspaceId, organizationWorkspaceId };
    });
    if (outcome.error) {
      if (outcome.error === "INVITATION_EMAIL_MISMATCH") return fail(res, 403, outcome.error, "Sign in with the email address this invitation was sent to.");
      if (outcome.error === "INVITATION_INVALID") return fail(res, 404, outcome.error, "This invitation is invalid or expired.");
      if (outcome.error === "EMAIL_NOT_VERIFIED") return fail(res, 403, outcome.error, "Verify your email address before finishing account setup.");
      if (outcome.error === "ACCOUNT_TYPE_LOCKED") return fail(res, 403, outcome.error, "Your account type is fixed from signup and cannot be changed during workspace setup.");
      if (outcome.error === "SIGNUP_DETAILS_MISMATCH") return fail(res, 400, outcome.error, "Your date of birth must match the details entered during signup.");
      return fail(res, 404, outcome.error, "Your account could not be found.");
    }
    const activeWorkspaceId = outcome.accountType === "organization" ? outcome.organizationWorkspaceId : outcome.personalWorkspaceId;
    return res.json({ success: true, data: { ...outcome, activeWorkspaceId }, message: "Your account is ready." });
  } catch (error) { next(error); }
});

app.patch("/v1/workspaces/:workspaceId", requireUser, async (req: AuthedRequest, res, next) => {
  const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
  if (name.length < 2 || name.length > 80) return fail(res, 400, "INVALID_NAME", "Workspace name must be between 2 and 80 characters.");
  try {
    const [membership] = await db.select({ id: workspaceMembers.id, role: workspaceMembers.role })
      .from(workspaceMembers).where(and(eq(workspaceMembers.workspaceId, String(req.params.workspaceId)), eq(workspaceMembers.userId, req.userId!))).limit(1);
    if (!membership) return fail(res, 404, "WORKSPACE_NOT_FOUND", "The workspace could not be found.");
    if (membership.role !== "owner") return fail(res, 403, "FORBIDDEN", "Only the workspace owner can change its name.");
    const [updated] = await db.update(workspaces).set({ name, updatedAt: new Date() })
      .where(eq(workspaces.id, String(req.params.workspaceId))).returning({ id: workspaces.id, name: workspaces.name, type: workspaces.type });
    return res.json({ success: true, data: updated, message: "Workspace name updated." });
  } catch (error) { next(error); }
});

app.get("/v1/usage", requireUser, async (req: AuthedRequest, res, next) => {
  const workspaceId = String(req.query.workspaceId ?? "");
  if (!workspaceId) return fail(res, 400, "WORKSPACE_REQUIRED", "Select a workspace.");
  try {
    const role = await workspaceRole(workspaceId, req.userId!);
    if (!role) return fail(res, 404, "WORKSPACE_NOT_FOUND", "The workspace could not be found.");
    if (!["owner", "admin"].includes(role)) return fail(res, 403, "FORBIDDEN", "Usage and billing details are limited to workspace owners and admins.");

    const now = new Date();
    const periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const periodEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
    const [domainTotal, verifiedDomains, mailboxTotal, aliasTotal, contactTotal, campaignTotal, seatTotal, messageTotal, inboundMessages, outboundMessages, monthlyOutboundMessages, monthlyCampaignRecipients] = await Promise.all([
      db.select({ value: count() }).from(domains).where(eq(domains.workspaceId, workspaceId)),
      db.select({ value: count() }).from(domains).where(and(eq(domains.workspaceId, workspaceId), eq(domains.verificationStatus, "verified"))),
      db.select({ value: count() }).from(mailboxes).where(eq(mailboxes.workspaceId, workspaceId)),
      db.select({ value: count() }).from(emailAliases).where(eq(emailAliases.workspaceId, workspaceId)),
      db.select({ value: count() }).from(contacts).where(eq(contacts.workspaceId, workspaceId)),
      db.select({ value: count() }).from(campaigns).where(eq(campaigns.workspaceId, workspaceId)),
      db.select({ value: count() }).from(workspaceMembers).where(eq(workspaceMembers.workspaceId, workspaceId)),
      db.select({ value: count() }).from(messages).where(eq(messages.workspaceId, workspaceId)),
      db.select({ value: count() }).from(messages).where(and(eq(messages.workspaceId, workspaceId), eq(messages.direction, "inbound"))),
      db.select({ value: count() }).from(messages).where(and(eq(messages.workspaceId, workspaceId), eq(messages.direction, "outbound"))),
      db.select({ value: count() }).from(messages).where(and(eq(messages.workspaceId, workspaceId), eq(messages.direction, "outbound"), gte(messages.receivedAt, periodStart))),
      db.select({ value: count() }).from(campaignRecipients).innerJoin(campaigns, eq(campaignRecipients.campaignId, campaigns.id)).where(and(eq(campaigns.workspaceId, workspaceId), gte(campaignRecipients.sentAt, periodStart))),
    ]);
    const value = (rows: Array<{ value: number }>) => Number(rows[0]?.value ?? 0);
    return res.json({ success: true, data: {
      workspace: { id: workspaceId, role },
      period: { start: periodStart, end: periodEnd },
      billing: { configured: false, plan: "Development preview", status: "No paid subscription configured" },
      resources: {
        domains: { total: value(domainTotal), verified: value(verifiedDomains) },
        mailboxes: value(mailboxTotal), aliases: value(aliasTotal), contacts: value(contactTotal), campaigns: value(campaignTotal), teamSeats: value(seatTotal),
      },
      mail: {
        stored: value(messageTotal), received: value(inboundMessages), sent: value(outboundMessages),
        sentThisMonth: value(monthlyOutboundMessages) + value(monthlyCampaignRecipients),
        oneToOneSentThisMonth: value(monthlyOutboundMessages), campaignRecipientsThisMonth: value(monthlyCampaignRecipients),
      },
      limits: null,
    } });
  } catch (error) { next(error); }
});

app.get("/v1/contacts", requireUser, async (req: AuthedRequest, res, next) => {
  const workspaceId = String(req.query.workspaceId ?? "");
  const search = String(req.query.search ?? "").trim().slice(0, 120);
  if (!workspaceId) return fail(res, 400, "WORKSPACE_REQUIRED", "Select a workspace.");
  try {
    const role = await workspaceRole(workspaceId, req.userId!);
    if (!role) return fail(res, 404, "WORKSPACE_NOT_FOUND", "The workspace could not be found.");
    // Contacts are shared within this workspace. Personal workspaces remain isolated.
    const where = search
      ? and(eq(contacts.workspaceId, workspaceId), or(
          ilike(contacts.email, `%${search}%`), ilike(contacts.firstName, `%${search}%`),
          ilike(contacts.lastName, `%${search}%`), ilike(contacts.company, `%${search}%`),
        ))
      : eq(contacts.workspaceId, workspaceId);
    const rows = await db.select().from(contacts).where(where).orderBy(desc(contacts.createdAt)).limit(500);
    res.json({ success: true, data: rows });
  } catch (error) { next(error); }
});

app.get("/v1/workspaces/:workspaceId/subscription-link", requireUser, async (req: AuthedRequest, res, next) => {
  const workspaceId = String(req.params.workspaceId);
  try {
    const role = await workspaceRole(workspaceId, req.userId!);
    if (!role) return fail(res, 404, "WORKSPACE_NOT_FOUND", "The workspace could not be found.");
    const [workspace] = await db.select({ type: workspaces.type }).from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
    if (workspace?.type !== "organization") return fail(res, 403, "ORGANIZATION_REQUIRED", "Public contact collection forms are available for organization workspaces.");
    if (!(role === "owner" || role === "admin")) return fail(res, 403, "FORBIDDEN", "Only workspace owners and admins can manage contact collection links.");
    const publicUrl = process.env.WIDESIP_PUBLIC_URL?.replace(/\/$/, "");
    if (!publicUrl || !/^https:\/\//i.test(publicUrl)) return fail(res, 503, "PUBLIC_URL_NOT_CONFIGURED", "Set WIDESIP_PUBLIC_URL to your current public HTTPS tunnel URL in the root .env.");
    let [link] = await db.select({ token: workspaceSubscriptionLinks.token, updatedAt: workspaceSubscriptionLinks.updatedAt }).from(workspaceSubscriptionLinks).where(eq(workspaceSubscriptionLinks.workspaceId, workspaceId)).limit(1);
    if (!link) {
      const token = randomBytes(32).toString("base64url");
      [link] = await db.insert(workspaceSubscriptionLinks).values({ workspaceId, token }).returning({ token: workspaceSubscriptionLinks.token, updatedAt: workspaceSubscriptionLinks.updatedAt });
    }
    return res.json({ success: true, data: { url: `${publicUrl}/v1/subscribe/${link.token}`, updatedAt: link.updatedAt } });
  } catch (error) { next(error); }
});

app.post("/v1/workspaces/:workspaceId/subscription-link/regenerate", requireUser, async (req: AuthedRequest, res, next) => {
  const workspaceId = String(req.params.workspaceId);
  try {
    const role = await workspaceRole(workspaceId, req.userId!);
    if (!role) return fail(res, 404, "WORKSPACE_NOT_FOUND", "The workspace could not be found.");
    const [workspace] = await db.select({ type: workspaces.type }).from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
    if (workspace?.type !== "organization") return fail(res, 403, "ORGANIZATION_REQUIRED", "Public contact collection forms are available for organization workspaces.");
    if (!(role === "owner" || role === "admin")) return fail(res, 403, "FORBIDDEN", "Only workspace owners and admins can manage contact collection links.");
    const publicUrl = process.env.WIDESIP_PUBLIC_URL?.replace(/\/$/, "");
    if (!publicUrl || !/^https:\/\//i.test(publicUrl)) return fail(res, 503, "PUBLIC_URL_NOT_CONFIGURED", "Set WIDESIP_PUBLIC_URL to your current public HTTPS tunnel URL in the root .env.");
    const token = randomBytes(32).toString("base64url");
    const [link] = await db.insert(workspaceSubscriptionLinks).values({ workspaceId, token }).onConflictDoUpdate({ target: workspaceSubscriptionLinks.workspaceId, set: { token, updatedAt: new Date() } }).returning({ token: workspaceSubscriptionLinks.token, updatedAt: workspaceSubscriptionLinks.updatedAt });
    return res.json({ success: true, data: { url: `${publicUrl}/v1/subscribe/${link.token}`, updatedAt: link.updatedAt } });
  } catch (error) { next(error); }
});

app.get("/v1/subscribe-widget/:token.js", (req, res) => {
  const token = String(req.params.token);
  if (!/^[A-Za-z0-9_-]{40,50}$/.test(token)) return res.status(404).type("text").send("/* Invalid Widesip contact collection widget. */");
  const source = `(()=>{const script=document.currentScript;if(!script)return;const token=${JSON.stringify(token)};const origin=new URL(script.src).origin;const label=script.dataset.label||"Subscribe";const button=document.createElement("button");button.type="button";button.textContent=label;button.setAttribute("aria-haspopup","dialog");button.style.cssText="appearance:none;border:0;border-radius:9px;padding:12px 18px;background:#356ae6;color:#fff;font:600 14px Arial,Helvetica,sans-serif;cursor:pointer;box-shadow:0 5px 14px #356ae633";const parent=script.parentNode;if(parent)parent.insertBefore(button,script);let overlay=null,frame=null,subscribed=false;function close(){if(overlay){overlay.remove();overlay=null;frame=null}document.removeEventListener("keydown",onKey)}function onKey(event){if(event.key==="Escape")close()}button.addEventListener("click",()=>{if(subscribed||overlay)return;overlay=document.createElement("div");overlay.setAttribute("role","dialog");overlay.setAttribute("aria-modal","true");overlay.setAttribute("aria-label","Newsletter signup");overlay.style.cssText="position:fixed;inset:0;z-index:2147483000;display:grid;place-items:center;padding:16px;background:rgba(15,27,47,.58);backdrop-filter:blur(3px)";const panel=document.createElement("div");panel.style.cssText="position:relative;width:min(100%,520px);max-height:calc(100vh - 32px);overflow:auto;border-radius:18px;background:#fff;box-shadow:0 25px 90px rgba(10,20,40,.28)";const closeButton=document.createElement("button");closeButton.type="button";closeButton.textContent="×";closeButton.setAttribute("aria-label","Close signup");closeButton.style.cssText="position:absolute;top:10px;right:12px;z-index:1;width:36px;height:36px;border:0;border-radius:50%;background:#f1f4f8;color:#34445e;font:26px Arial,sans-serif;cursor:pointer";frame=document.createElement("iframe");frame.title="Newsletter signup form";frame.src=origin+"/v1/subscribe/"+token+"?embed=1";frame.referrerPolicy="strict-origin-when-cross-origin";frame.style.cssText="display:block;width:100%;height:min(620px,calc(100vh - 32px));border:0";closeButton.addEventListener("click",close);overlay.addEventListener("click",event=>{if(event.target===overlay)close()});panel.append(closeButton,frame);overlay.append(panel);document.body.append(overlay);document.addEventListener("keydown",onKey);closeButton.focus()});window.addEventListener("message",event=>{if(event.origin===origin&&frame&&event.source===frame.contentWindow&&event.data&&event.data.type==="widesip:subscription-complete"){subscribed=true;button.textContent="Subscribed"}})})();`;
  return res.type("application/javascript").set("Cache-Control", "no-store").send(source);
});

app.get("/v1/subscribe/:token", async (req, res) => {
  const token = String(req.params.token);
  if (!/^[A-Za-z0-9_-]{40,50}$/.test(token)) return res.status(404).type("html").send(subscriptionPage("", "error", "This signup link is invalid.", "Widesip", false, res.locals.cspNonce));
  const [link] = await db.select({ workspaceId: workspaceSubscriptionLinks.workspaceId, workspaceName: workspaces.name }).from(workspaceSubscriptionLinks).innerJoin(workspaces, eq(workspaces.id, workspaceSubscriptionLinks.workspaceId)).where(eq(workspaceSubscriptionLinks.token, token)).limit(1);
  if (!link) return res.status(404).type("html").send(subscriptionPage("", "error", "This signup link is no longer active.", "Widesip", false, res.locals.cspNonce));
  return res.type("html").send(subscriptionPage(token, "form", "", link.workspaceName, req.query.embed === "1", res.locals.cspNonce));
});

app.post("/v1/subscribe/:token", express.urlencoded({ extended: false, limit: "20kb" }), async (req, res) => {
  const token = String(req.params.token);
  const [link] = await db.select({ workspaceId: workspaceSubscriptionLinks.workspaceId, workspaceName: workspaces.name }).from(workspaceSubscriptionLinks).innerJoin(workspaces, eq(workspaces.id, workspaceSubscriptionLinks.workspaceId)).where(eq(workspaceSubscriptionLinks.token, token)).limit(1);
  if (!link) return res.status(404).type("html").send(subscriptionPage("", "error", "This signup link is no longer active.", "Widesip", false, res.locals.cspNonce));
  const ip = req.header("cf-connecting-ip")?.trim() || req.ip || "unknown";
  const embedded = req.query.embed === "1";
  if (!await consumeRateLimit(rateLimitFingerprint("public-signup", `${ip}|${token}`), 8, 60_000)) {
    return res.status(429).type("html").send(subscriptionPage(token, "error", "Please wait a minute before trying again.", link.workspaceName, embedded, res.locals.cspNonce));
  }
  if (String(req.body?.website_url ?? "").trim()) return res.type("html").send(subscriptionPage(token, "success", "", link.workspaceName, embedded, res.locals.cspNonce));
  const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
  const firstName = typeof req.body?.firstName === "string" ? req.body.firstName.trim().slice(0, 100) : "";
  const lastName = typeof req.body?.lastName === "string" ? req.body.lastName.trim().slice(0, 100) : "";
  if (!firstName || req.body?.consent !== "yes" || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).type("html").send(subscriptionPage(token, "error", "Enter your first name and a valid email address, then confirm your agreement to receive newsletter emails.", link.workspaceName, embedded, res.locals.cspNonce));
  }
  try {
    const now = new Date();
    await db.insert(contacts).values({ workspaceId: link.workspaceId, email, firstName: firstName || null, lastName: lastName || null, consentStatus: "subscribed", consentSource: "public_signup", consentAt: now })
      .onConflictDoUpdate({ target: [contacts.workspaceId, contacts.email], set: { firstName: firstName || null, lastName: lastName || null, consentStatus: "subscribed", consentSource: "public_signup", consentAt: now, unsubscribedAt: null, updatedAt: now } });
    return res.type("html").send(subscriptionPage(token, "success", "", link.workspaceName, embedded, res.locals.cspNonce));
  } catch (error) {
    console.error("Public newsletter signup failed:", error instanceof Error ? error.message : "unknown error");
    return res.status(500).type("html").send(subscriptionPage(token, "error", "We couldn’t save your subscription just now. Please try again.", link.workspaceName, embedded, res.locals.cspNonce));
  }
});

app.post("/v1/contacts", requireUser, async (req: AuthedRequest, res, next) => {
  const parsed = contactCreateSchema.safeParse(req.body);
  if (!parsed.success) return fail(res, 400, "INVALID_CONTACT", parsed.error.issues[0]?.message ?? "Check the contact details.");
  try {
    const role = await workspaceRole(parsed.data.workspaceId, req.userId!);
    if (!role) return fail(res, 404, "WORKSPACE_NOT_FOUND", "The workspace could not be found.");
    const [created] = await db.insert(contacts).values({
      workspaceId: parsed.data.workspaceId,
      email: parsed.data.email,
      firstName: parsed.data.firstName || null,
      lastName: parsed.data.lastName || null,
      company: parsed.data.company || null,
      consentStatus: parsed.data.consentStatus,
      consentSource: parsed.data.consentStatus === "subscribed" ? parsed.data.consentSource! : null,
      consentAt: parsed.data.consentStatus === "subscribed" ? new Date() : null,
    }).returning();
    res.status(201).json({ success: true, data: created });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "23505") return fail(res, 409, "CONTACT_EXISTS", "This email address is already in your contacts.");
    next(error);
  }
});

app.patch("/v1/contacts/:contactId", requireUser, async (req: AuthedRequest, res, next) => {
  const parsed = contactUpdateSchema.safeParse(req.body);
  if (!parsed.success) return fail(res, 400, "INVALID_CONTACT", parsed.error.issues[0]?.message ?? "Check the contact details.");
  try {
    const [access] = await db.select({ id: contacts.id, role: workspaceMembers.role }).from(contacts)
      .innerJoin(workspaceMembers, eq(workspaceMembers.workspaceId, contacts.workspaceId))
      .where(and(eq(contacts.id, String(req.params.contactId)), eq(workspaceMembers.userId, req.userId!))).limit(1);
    if (!access) return fail(res, 404, "CONTACT_NOT_FOUND", "The contact could not be found.");
    const [updated] = await db.update(contacts).set({
      ...(parsed.data.email !== undefined ? { email: parsed.data.email } : {}),
      ...(parsed.data.firstName !== undefined ? { firstName: parsed.data.firstName || null } : {}),
      ...(parsed.data.lastName !== undefined ? { lastName: parsed.data.lastName || null } : {}),
      ...(parsed.data.company !== undefined ? { company: parsed.data.company || null } : {}),
      updatedAt: new Date(),
    }).where(eq(contacts.id, access.id)).returning();
    res.json({ success: true, data: updated });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "23505") return fail(res, 409, "CONTACT_EXISTS", "Another contact already uses this email address.");
    next(error);
  }
});

app.delete("/v1/contacts/:contactId", requireUser, async (req: AuthedRequest, res, next) => {
  try {
    const [access] = await db.select({ id: contacts.id, role: workspaceMembers.role }).from(contacts)
      .innerJoin(workspaceMembers, eq(workspaceMembers.workspaceId, contacts.workspaceId))
      .where(and(eq(contacts.id, String(req.params.contactId)), eq(workspaceMembers.userId, req.userId!))).limit(1);
    if (!access) return fail(res, 404, "CONTACT_NOT_FOUND", "The contact could not be found.");
    await db.transaction(async (tx) => {
      await tx.delete(campaignRecipients).where(eq(campaignRecipients.contactId, access.id));
      await tx.delete(contacts).where(eq(contacts.id, access.id));
    });
    res.json({ success: true });
  } catch (error) { next(error); }
});

app.patch("/v1/contacts/:contactId/unsubscribe", requireUser, async (req: AuthedRequest, res, next) => {
  try {
    const [access] = await db.select({ id: contacts.id, role: workspaceMembers.role }).from(contacts)
      .innerJoin(workspaceMembers, eq(workspaceMembers.workspaceId, contacts.workspaceId))
      .where(and(eq(contacts.id, String(req.params.contactId)), eq(workspaceMembers.userId, req.userId!))).limit(1);
    if (!access) return fail(res, 404, "CONTACT_NOT_FOUND", "The contact could not be found.");
    const [updated] = await db.update(contacts).set({ consentStatus: "unsubscribed", unsubscribedAt: new Date(), updatedAt: new Date() })
      .where(eq(contacts.id, access.id)).returning();
    res.json({ success: true, data: updated });
  } catch (error) { next(error); }
});

app.get("/v1/domains", requireUser, async (req: AuthedRequest, res, next) => {
  const workspaceId = String(req.query.workspaceId ?? "");
  if (!workspaceId) return fail(res, 400, "WORKSPACE_REQUIRED", "Select a workspace.");
  try {
    const membership = await db.select({ role: workspaceMembers.role }).from(workspaceMembers)
      .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, req.userId!)))
      .limit(1);
    if (!membership.length) return fail(res, 404, "WORKSPACE_NOT_FOUND", "The workspace could not be found.");
    if (!["owner", "admin"].includes(membership[0].role)) return res.json({ success: true, data: [] });

    const rows = await db.select({
      id: domains.id,
      workspaceId: domains.workspaceId,
      domainName: domains.domainName,
      verificationStatus: domains.verificationStatus,
      mailStatus: domains.mailStatus,
      receivingEnabled: domains.receivingEnabled,
      sendingProvider: domains.sendingProvider,
      sendingProviderDomainId: domains.sendingProviderDomainId,
      resendDomainId: domains.resendDomainId,
      createdAt: domains.createdAt,
      tokenHash: domainVerifications.tokenHash,
      expiresAt: domainVerifications.expiresAt,
      verifiedAt: domainVerifications.verifiedAt,
    }).from(domains)
      .leftJoin(domainVerifications, eq(domainVerifications.domainId, domains.id))
      .where(eq(domains.workspaceId, workspaceId))
      .orderBy(asc(domains.createdAt));

    res.json({ success: true, data: rows.map((row) => ({
      id: row.id,
      workspaceId: row.workspaceId,
      domainName: row.domainName,
      verificationStatus: row.verificationStatus,
      mailStatus: row.mailStatus,
      receivingEnabled: row.receivingEnabled,
      sendingProviderConnected: Boolean(row.sendingProviderDomainId || row.resendDomainId),
      createdAt: row.createdAt,
      dnsVerification: row.tokenHash && row.expiresAt
        ? makeDnsVerification(row.domainName, row.tokenHash, row.expiresAt, row.verifiedAt)
        : null,
    })) });
  } catch (error) {
    next(error);
  }
});

app.get("/v1/domains/:domainId/template", requireUser, async (req: AuthedRequest, res, next) => {
  try {
    const [access] = await db.select({ id: domains.id, domainName: domains.domainName, verificationStatus: domains.verificationStatus, role: workspaceMembers.role })
      .from(domains).innerJoin(workspaceMembers, eq(workspaceMembers.workspaceId, domains.workspaceId))
      .where(and(eq(domains.id, String(req.params.domainId)), eq(workspaceMembers.userId, req.userId!))).limit(1);
    if (!access) return fail(res, 404, "DOMAIN_NOT_FOUND", "The domain could not be found.");
    if (!["owner", "admin"].includes(access.role)) return fail(res, 403, "FORBIDDEN", "Only workspace owners and admins can manage domain email templates.");
    const [saved] = await db.select().from(domainEmailTemplates).where(eq(domainEmailTemplates.domainId, access.id)).limit(1);
    const addresses = await db.select({ localPart: mailboxes.localPart, displayName: mailboxes.displayName })
      .from(mailboxes).where(eq(mailboxes.domainId, access.id)).orderBy(asc(mailboxes.createdAt));
    const publicUrl = process.env.WIDESIP_PUBLIC_URL?.replace(/\/$/, "");
    const logoUrl = saved?.logoImageData
      ? (publicUrl ? `${publicUrl}/v1/public/domains/${access.id}/logo` : null)
      : saved?.logoUrl ?? null;
    return res.json({ success: true, data: { domainId: access.id, brandName: saved?.brandName ?? access.domainName, accentColor: saved?.accentColor ?? "#4165e8", footerText: saved?.footerText ?? "", customHtml: saved?.customHtml ?? "", addresses, logoUrl, hasUploadedLogo: Boolean(saved?.logoImageData), canUploadLogo: Boolean(publicUrl), domainName: access.domainName, verificationStatus: access.verificationStatus } });
  } catch (error) { next(error); }
});

app.patch("/v1/domains/:domainId/template", requireUser, async (req: AuthedRequest, res, next) => {
  const brandName = typeof req.body?.brandName === "string" ? req.body.brandName.trim() : "";
  const accentColor = typeof req.body?.accentColor === "string" ? req.body.accentColor : "";
  const footerText = typeof req.body?.footerText === "string" ? req.body.footerText.trim() : "";
  const rawCustomHtml = typeof req.body?.customHtml === "string" ? req.body.customHtml : "";
  const customHtml = sanitizeCustomEmailHtml(rawCustomHtml);
  const logoUrl = req.body?.logoUrl === "" ? null : req.body?.logoUrl;
  const logoImage = req.body?.logoImageData;
  const imageProvided = Object.prototype.hasOwnProperty.call(req.body ?? {}, "logoImageData");
  if (brandName.length < 2 || brandName.length > 80) return fail(res, 400, "INVALID_BRAND_NAME", "Brand name must be between 2 and 80 characters.");
  if (!/^#[0-9a-f]{6}$/i.test(accentColor)) return fail(res, 400, "INVALID_ACCENT_COLOR", "Choose a valid six-digit hex color.");
  if (footerText.length > 500) return fail(res, 400, "INVALID_FOOTER", "Footer text cannot exceed 500 characters.");
  if (customHtml.length > 60_000) return fail(res, 400, "CUSTOM_TEMPLATE_TOO_LARGE", "Custom email HTML cannot exceed 60 KB.");
  if (customHtml.trim() && !/{{\s*body\s*}}/i.test(customHtml)) return fail(res, 400, "CUSTOM_TEMPLATE_BODY_REQUIRED", "Your custom design must include the {{body}} placeholder so the email message appears in the template.");
  if (logoUrl !== null && (typeof logoUrl !== "string" || logoUrl.length > 2000 || !/^https:\/\//i.test(logoUrl))) return fail(res, 400, "INVALID_LOGO_URL", "Logo must use a public HTTPS image URL.");
  if (imageProvided && logoImage !== null && (typeof logoImage !== "string" || !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(logoImage) || Buffer.byteLength(logoImage, "utf8") > 1_500_000)) return fail(res, 400, "INVALID_LOGO_IMAGE", "Choose a PNG, JPG, or WebP logo smaller than 1 MB.");
  if (typeof logoImage === "string" && !process.env.WIDESIP_PUBLIC_URL?.startsWith("https://")) return fail(res, 503, "PUBLIC_IMAGE_HOST_NOT_CONFIGURED", "Set WIDESIP_PUBLIC_URL to your public HTTPS API address before uploading a logo.");
  try {
    const [access] = await db.select({ id: domains.id, domainName: domains.domainName, role: workspaceMembers.role }).from(domains)
      .innerJoin(workspaceMembers, eq(workspaceMembers.workspaceId, domains.workspaceId))
      .where(and(eq(domains.id, String(req.params.domainId)), eq(workspaceMembers.userId, req.userId!))).limit(1);
    if (!access) return fail(res, 404, "DOMAIN_NOT_FOUND", "The domain could not be found.");
    if (!["owner", "admin"].includes(access.role)) return fail(res, 403, "FORBIDDEN", "Only workspace owners and admins can manage domain email templates.");
    const logoMimeType = typeof logoImage === "string" ? /^data:(image\/(?:png|jpeg|webp));base64,/.exec(logoImage)?.[1] ?? null : null;
    const logoImageData = typeof logoImage === "string" ? logoImage.split(",", 2)[1] : imageProvided ? null : undefined;
    const savedValues = { domainId: access.id, brandName, logoUrl: logoImage ? null : logoUrl, ...(imageProvided ? { logoImageData, logoMimeType } : {}), accentColor, footerText, customHtml, updatedAt: new Date() };
    const updateValues = { brandName, logoUrl: logoImage ? null : logoUrl, ...(imageProvided ? { logoImageData, logoMimeType } : {}), accentColor, footerText, customHtml, updatedAt: new Date() };
    await db.insert(domainEmailTemplates).values(savedValues)
      .onConflictDoUpdate({ target: domainEmailTemplates.domainId, set: updateValues });
    const publicUrl = process.env.WIDESIP_PUBLIC_URL?.replace(/\/$/, "");
    const finalLogoUrl = logoImage && publicUrl ? `${publicUrl}/v1/public/domains/${access.id}/logo` : logoUrl;
    const addresses = await db.select({ localPart: mailboxes.localPart, displayName: mailboxes.displayName })
      .from(mailboxes).where(eq(mailboxes.domainId, access.id)).orderBy(asc(mailboxes.createdAt));
    return res.json({ success: true, data: { domainId: access.id, domainName: access.domainName, brandName, logoUrl: finalLogoUrl, hasUploadedLogo: typeof logoImage === "string", canUploadLogo: Boolean(publicUrl), accentColor, footerText, customHtml, addresses }, message: "The domain email design was saved." });
  } catch (error) { next(error); }
});

app.get("/v1/public/domains/:domainId/logo", async (req, res, next) => {
  try {
    const [asset] = await db.select({ imageData: domainEmailTemplates.logoImageData, mimeType: domainEmailTemplates.logoMimeType })
      .from(domainEmailTemplates).where(eq(domainEmailTemplates.domainId, String(req.params.domainId))).limit(1);
    if (!asset?.imageData || !asset.mimeType) return res.sendStatus(404);
    const content = Buffer.from(asset.imageData, "base64");
    res.set({ "Content-Type": asset.mimeType, "Content-Length": String(content.length), "Cache-Control": "public, max-age=300", "X-Content-Type-Options": "nosniff" });
    return res.send(content);
  } catch (error) { next(error); }
});

app.post("/v1/domains", requireUser, async (req: AuthedRequest, res, next) => {
  const parsed = domainCreateSchema.safeParse(req.body);
  if (!parsed.success) return fail(res, 400, "INVALID_INPUT", parsed.error.issues[0]?.message ?? "Check the domain details.");
  try {
    const membership = await db.select({ role: workspaceMembers.role }).from(workspaceMembers)
      .where(and(eq(workspaceMembers.workspaceId, parsed.data.workspaceId), eq(workspaceMembers.userId, req.userId!)))
      .limit(1);
    if (!membership.length) return fail(res, 404, "WORKSPACE_NOT_FOUND", "The workspace could not be found.");
    if (!["owner", "admin"].includes(membership[0].role)) {
      return fail(res, 403, "FORBIDDEN", "You do not have permission to manage domains.");
    }

    const created = await db.transaction(async (tx) => {
      const [domain] = await tx.insert(domains).values({
        workspaceId: parsed.data.workspaceId,
        domainName: parsed.data.domainName,
      }).returning();
      const tokenHash = newChallenge();
      const expiresAt = new Date(Date.now() + challengeLifetimeMs);
      await tx.insert(domainVerifications).values({
        workspaceId: domain.workspaceId,
        domainId: domain.id,
        tokenHash,
        expiresAt,
      });
      return { ...domain, dnsVerification: makeDnsVerification(domain.domainName, tokenHash, expiresAt, null) };
    });
    res.status(201).json({ success: true, data: created });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "23505") {
      return fail(res, 409, "DOMAIN_EXISTS", "This domain is already connected to the workspace.");
    }
    next(error);
  }
});

app.post("/v1/domains/:domainId/verify", requireUser, async (req: AuthedRequest, res, next) => {
  try {
    const access = await db.select({
      id: domains.id,
      workspaceId: domains.workspaceId,
      domainName: domains.domainName,
      verificationStatus: domains.verificationStatus,
      role: workspaceMembers.role,
    }).from(domains)
      .innerJoin(workspaceMembers, eq(workspaceMembers.workspaceId, domains.workspaceId))
      .where(and(eq(domains.id, String(req.params.domainId)), eq(workspaceMembers.userId, req.userId!)))
      .limit(1);
    if (!access.length) return fail(res, 404, "DOMAIN_NOT_FOUND", "The domain could not be found.");
    const domain = access[0];
    if (!["owner", "admin"].includes(domain.role)) {
      return fail(res, 403, "FORBIDDEN", "You do not have permission to verify domains.");
    }
    if (domain.verificationStatus === "verified") {
      return res.json({ success: true, data: { verified: true, message: "Domain ownership is verified." } });
    }

    let [verification] = await db.select().from(domainVerifications)
      .where(and(eq(domainVerifications.domainId, domain.id), eq(domainVerifications.workspaceId, domain.workspaceId)))
      .limit(1);
    if (!verification || verification.expiresAt.getTime() <= Date.now()) {
      const tokenHash = newChallenge();
      const expiresAt = new Date(Date.now() + challengeLifetimeMs);
      if (verification) {
        [verification] = await db.update(domainVerifications).set({ tokenHash, expiresAt, verifiedAt: null })
          .where(eq(domainVerifications.id, verification.id)).returning();
      } else {
        [verification] = await db.insert(domainVerifications).values({
          workspaceId: domain.workspaceId,
          domainId: domain.id,
          tokenHash,
          expiresAt,
        }).returning();
      }
      return res.json({ success: true, data: {
        verified: false,
        dnsVerification: makeDnsVerification(domain.domainName, verification.tokenHash, verification.expiresAt, null),
        message: "A verification record was created or renewed. Add the TXT record, then check again.",
      } });
    }

    const dnsVerification = makeDnsVerification(domain.domainName, verification.tokenHash, verification.expiresAt, verification.verifiedAt);
    let records: string[][] = [];
    try {
      records = await resolveTxt(dnsVerification.hostname);
    } catch (error) {
      if (!isExpectedDnsMiss(error)) throw error;
    }
    const found = records.some((parts) => parts.join("") === dnsVerification.value);
    if (!found) {
      return res.json({ success: true, data: {
        verified: false,
        dnsVerification,
        message: "The TXT record was not found yet. Check the record name and value, then allow time for DNS propagation.",
      } });
    }

    const verifiedAt = new Date();
    await db.transaction(async (tx) => {
      await tx.update(domains).set({ verificationStatus: "verified" }).where(eq(domains.id, domain.id));
      await tx.update(domainVerifications).set({ verifiedAt }).where(eq(domainVerifications.id, verification.id));
    });
    res.json({ success: true, data: { verified: true, dnsVerification: { ...dnsVerification, status: "verified" }, message: "Domain ownership is verified." } });
  } catch (error) {
    next(error);
  }
});

app.post("/v1/domains/:domainId/mail-setup", requireUser, async (req: AuthedRequest, res, next) => {
  try {
    const [domain] = await db.select({
      id: domains.id, workspaceId: domains.workspaceId, domainName: domains.domainName,
      verificationStatus: domains.verificationStatus, sendingProvider: domains.sendingProvider,
      sendingProviderDomainId: domains.sendingProviderDomainId, resendDomainId: domains.resendDomainId,
      receivingEnabled: domains.receivingEnabled, cloudflareZoneId: domains.cloudflareZoneId,
      role: workspaceMembers.role,
    }).from(domains).innerJoin(workspaceMembers, eq(workspaceMembers.workspaceId, domains.workspaceId))
      .where(and(eq(domains.id, String(req.params.domainId)), eq(workspaceMembers.userId, req.userId!))).limit(1);
    if (!domain) return fail(res, 404, "DOMAIN_NOT_FOUND", "The domain could not be found.");
    if (!["owner", "admin"].includes(domain.role)) return fail(res, 403, "FORBIDDEN", "You do not have permission to set up mail for this domain.");
    if (domain.verificationStatus !== "verified") return fail(res, 409, "DOMAIN_NOT_VERIFIED", "Verify ownership of this domain first.");
    if (!process.env.RESEND_API_KEY) return fail(res, 503, "MAIL_TRANSPORT_NOT_CONFIGURED", "Widesip has not configured its mail delivery service on the server yet.");
    const provider = getMailProvider();
    const receivingSpecified = typeof req.body?.receiving === "boolean";
    let receivingEnabled = receivingSpecified ? req.body.receiving as boolean : domain.receivingEnabled;
    const existingProviderId = domain.sendingProviderDomainId ?? domain.resendDomainId;
    let providerDomain: ProviderDomain;
    if (existingProviderId) {
      providerDomain = await provider.getDomain(existingProviderId);
    } else {
      providerDomain = await provider.findDomain(domain.domainName) ?? await provider.createDomain(domain.domainName, receivingEnabled);
      await db.update(domains).set({ sendingProvider: provider.id, sendingProviderDomainId: providerDomain.id, resendDomainId: provider.id === "resend" ? providerDomain.id : null, mailStatus: "pending" }).where(eq(domains.id, domain.id));
    }
    if (receivingSpecified) {
      await provider.updateDomain(providerDomain.id, { sending: "enabled", receiving: receivingEnabled ? "enabled" : "disabled" });
      providerDomain = await provider.getDomain(providerDomain.id);
    }
    if (!receivingSpecified && ["enabled", "pending", "verified"].includes(providerDomain.capabilities?.receiving ?? "")) receivingEnabled = true;
    if (receivingEnabled && provider.id === "resend") {
      providerDomain = await provider.enableForge(providerDomain.id);
    }

    const zoneId = process.env.NODE_ENV === "production" ? domain.cloudflareZoneId : process.env.CLOUDFLARE_ZONE_ID;
    const oauthToken = process.env.NODE_ENV === "production" ? await freshCloudflareAccessToken(domain.id) : null;
    // Production writes are authorized by this workspace's OAuth grant and
    // the zone selected from the Cloudflare account that granted it.
    const canWriteDns = Boolean(zoneId && (oauthToken || (process.env.NODE_ENV !== "production" && process.env.CLOUDFLARE_API_TOKEN)));
    let dnsRecords = [...(providerDomain.records ?? [])].sort((left, right) => {
      const leftRootMx = left.type.toUpperCase() === "MX" && normalizedDnsName(left.name, domain.domainName) === domain.domainName;
      const rightRootMx = right.type.toUpperCase() === "MX" && normalizedDnsName(right.name, domain.domainName) === domain.domainName;
      return Number(rightRootMx) - Number(leftRootMx);
    });
    const applied: string[] = [];
    const conflicts: MailDnsRecord[] = [];
    if (canWriteDns) {
      for (const record of dnsRecords) {
        const type = record.type.toUpperCase();
        const name = normalizedDnsName(record.name, domain.domainName);
        const current = await cloudflareRequest<CloudflareDnsRecord[]>(`/zones/${encodeURIComponent(zoneId!)}/dns_records?type=${encodeURIComponent(type)}&name=${encodeURIComponent(name)}`, {}, oauthToken ?? undefined);
        const wantedValue = comparableDnsValue(record.value);
        const existingMatch = current.find((item) => comparableDnsValue(item.content) === wantedValue && (type !== "MX" || item.priority === (record.priority ?? 10)));
        if (existingMatch) { applied.push(`${type} ${name}`); continue; }
        // Never replace an existing root MX route. Exact matches above are safe,
        // including a verified test subdomain's own MX record.
        if (type === "MX" && name === domain.domainName && current.length > 0) {
          conflicts.push(record);
          continue;
        }
        const conflicting = current.find((item) => {
          if (type === "TXT") return record.value.toLowerCase().startsWith("v=spf1") && item.content.toLowerCase().startsWith("v=spf1");
          return type === "MX" || type === "CNAME";
        });
        if (conflicting) {
          return fail(res, 409, "DNS_RECORD_CONFLICT", `Cloudflare already has a conflicting ${type} record at ${name}. Widesip left it unchanged; review it before continuing.`);
        }
        const ttl = typeof record.ttl === "number" ? record.ttl : Number.parseInt(record.ttl ?? "1", 10) || 1;
        await cloudflareRequest<CloudflareDnsRecord>(`/zones/${encodeURIComponent(zoneId!)}/dns_records`, {
          method: "POST",
          body: JSON.stringify({ type, name, content: record.value, ttl, proxied: false, ...(type === "MX" ? { priority: record.priority ?? 10 } : {}) }),
        }, oauthToken ?? undefined);
        applied.push(`${type} ${name}`);
      }
      await provider.verifyDomain(providerDomain.id, receivingEnabled && provider.id === "resend" ? "forge" : undefined);
      providerDomain = await provider.getDomain(providerDomain.id);
      dnsRecords = [...(providerDomain.records ?? [])].sort((left, right) => {
        const leftRootMx = left.type.toUpperCase() === "MX" && normalizedDnsName(left.name, domain.domainName) === domain.domainName;
        const rightRootMx = right.type.toUpperCase() === "MX" && normalizedDnsName(right.name, domain.domainName) === domain.domainName;
        return Number(rightRootMx) - Number(leftRootMx);
      });
    }

    const active = providerDomain.status === "verified";
    const receivingMx = dnsRecords.find((record) => record.type.toUpperCase() === "MX" && normalizedDnsName(record.name, domain.domainName) === domain.domainName);
    const receivingMxAvailable = Boolean(receivingMx);
    await db.update(domains).set({ mailStatus: active ? "active" : "pending", receivingEnabled }).where(eq(domains.id, domain.id));
    res.json({ success: true, data: {
      status: providerDomain.status,
      receivingEnabled,
      receivingStatus: providerDomain.capabilities?.receiving ?? (receivingEnabled ? "enabled" : "disabled"),
      receivingMxAvailable,
      receivingMxStatus: receivingMx?.status ?? "unknown",
      domainId: providerDomain.id,
      dnsAutomated: canWriteDns,
      appliedRecords: applied,
      conflicts,
      records: dnsRecords,
      message: receivingEnabled && !receivingMxAvailable
        ? "The sending records are available, but Resend has not returned a receiving MX record. Incoming mail is not routed to Widesip yet."
        : active
        ? conflicts.length
          ? "Sending is verified. Widesip left your existing root MX records unchanged; replace them only if you want all mail for this domain routed to Widesip."
          : "Widesip verified this domain for sending."
        : canWriteDns
          ? conflicts.length
            ? "DNS records were added where safe. Widesip left your existing root MX records unchanged; replace them only if you want all mail for this domain routed to Widesip."
            : "DNS records were added where safe. The mail service is checking them; select Check mail DNS after a few minutes."
          : "Widesip supplied the DNS records. Add them in your DNS provider, then select Check mail DNS. Existing root MX records are not changed automatically.",
    } });
  } catch (error) {
    return fail(res, 502, "MAIL_SETUP_FAILED", error instanceof Error ? error.message : "Could not prepare mail delivery setup.");
  }
});

app.post("/v1/domains/:domainId/mail-setup/verify", requireUser, async (req: AuthedRequest, res, next) => {
  try {
    const [domain] = await db.select({
      id: domains.id, workspaceId: domains.workspaceId, sendingProvider: domains.sendingProvider,
      sendingProviderDomainId: domains.sendingProviderDomainId, resendDomainId: domains.resendDomainId,
      domainName: domains.domainName, receivingEnabled: domains.receivingEnabled,
      role: workspaceMembers.role,
    }).from(domains).innerJoin(workspaceMembers, eq(workspaceMembers.workspaceId, domains.workspaceId))
      .where(and(eq(domains.id, String(req.params.domainId)), eq(workspaceMembers.userId, req.userId!))).limit(1);
    if (!domain) return fail(res, 404, "DOMAIN_NOT_FOUND", "The domain could not be found.");
    if (!["owner", "admin"].includes(domain.role)) return fail(res, 403, "FORBIDDEN", "You do not have permission to check mail setup.");
    const providerDomainId = domain.sendingProviderDomainId ?? domain.resendDomainId;
    if (!providerDomainId) return fail(res, 409, "SENDING_NOT_STARTED", "Start sending setup first.");
    const provider = getMailProvider();
    const providerDomain = await provider.getDomain(providerDomainId);
    if (domain.receivingEnabled && provider.id === "resend") await provider.verifyDomain(providerDomainId, "forge");
    else if (providerDomain.status !== "verified") await provider.verifyDomain(providerDomainId);
    const checked = await provider.getDomain(providerDomainId);
    const active = checked.status === "verified";
    await db.update(domains).set({ mailStatus: active ? "active" : "pending" }).where(eq(domains.id, domain.id));
    const receivingEnabled = checked.capabilities?.receiving === "enabled" || checked.capabilities?.receiving === "verified" || checked.capabilities?.receiving === "pending";
    await db.update(domains).set({ mailStatus: active ? "active" : "pending", receivingEnabled }).where(eq(domains.id, domain.id));
    const records = checked.records ?? [];
    const receivingMx = records.find((record) => record.type.toUpperCase() === "MX" && normalizedDnsName(record.name, domain.domainName) === domain.domainName);
    res.json({ success: true, data: {
      status: checked.status,
      verified: active,
      receivingEnabled,
      receivingStatus: checked.capabilities?.receiving ?? "unknown",
      receivingMxAvailable: Boolean(receivingMx),
      receivingMxStatus: receivingMx?.status ?? "unknown",
      records,
      message: !receivingMx && receivingEnabled
        ? "Sending can be verified, but Resend has not returned a root receiving MX record for this domain yet. Incoming mail is not routed to Widesip."
        : active
          ? "Sending domain is verified. Check the receiving MX status separately before changing your current mail route."
          : "The mail service is still checking DNS. Allow a little time for the records to propagate, then check again.",
    } });
  } catch (error) {
    return fail(res, 502, "MAIL_STATUS_CHECK_FAILED", error instanceof Error ? error.message : "Could not check mail DNS status.");
  }
});

app.get("/v1/aliases", requireUser, async (req: AuthedRequest, res, next) => {
  const workspaceId = String(req.query.workspaceId ?? "");
  if (!workspaceId) return fail(res, 400, "WORKSPACE_REQUIRED", "Select a workspace.");
  try {
    const membership = await db.select({ role: workspaceMembers.role }).from(workspaceMembers)
      .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, req.userId!))).limit(1);
    if (!membership.length) return fail(res, 404, "WORKSPACE_NOT_FOUND", "The workspace could not be found.");
    if (!["owner", "admin"].includes(membership[0].role)) return fail(res, 403, "FORBIDDEN", "Alias settings are limited to workspace owners and admins.");
    const rows = await db.select({
      id: emailAliases.id, localPart: emailAliases.localPart, status: emailAliases.status,
      createdAt: emailAliases.createdAt, mailboxId: mailboxes.id, mailboxLocalPart: mailboxes.localPart,
      mailboxDisplayName: mailboxes.displayName, domainName: domains.domainName,
    }).from(emailAliases).innerJoin(domains, eq(emailAliases.domainId, domains.id))
      .innerJoin(mailboxes, eq(emailAliases.mailboxId, mailboxes.id))
      .where(eq(emailAliases.workspaceId, workspaceId)).orderBy(asc(emailAliases.createdAt));
    res.json({ success: true, data: rows.map((row) => ({
      ...row, address: `${row.localPart}@${row.domainName}`,
      mailboxAddress: `${row.mailboxLocalPart}@${row.domainName}`,
    })) });
  } catch (error) { next(error); }
});

app.post("/v1/aliases", requireUser, async (req: AuthedRequest, res, next) => {
  const parsed = aliasCreateSchema.safeParse(req.body);
  if (!parsed.success) return fail(res, 400, "INVALID_ALIAS", parsed.error.issues[0]?.message ?? "Check the alias details.");
  try {
    const [target] = await db.select({
      mailboxId: mailboxes.id, workspaceId: mailboxes.workspaceId, domainId: mailboxes.domainId,
      mailboxLocalPart: mailboxes.localPart, domainName: domains.domainName,
      verificationStatus: domains.verificationStatus, role: workspaceMembers.role,
    }).from(mailboxes).innerJoin(domains, eq(mailboxes.domainId, domains.id))
      .innerJoin(workspaceMembers, eq(workspaceMembers.workspaceId, mailboxes.workspaceId))
      .where(and(eq(mailboxes.id, parsed.data.mailboxId), eq(mailboxes.workspaceId, parsed.data.workspaceId), eq(workspaceMembers.userId, req.userId!))).limit(1);
    if (!target) return fail(res, 404, "MAILBOX_NOT_FOUND", "Choose a mailbox in this workspace.");
    if (!(["owner", "admin"].includes(target.role))) return fail(res, 403, "FORBIDDEN", "You do not have permission to manage aliases.");
    if (target.domainId !== parsed.data.domainId) return fail(res, 400, "ALIAS_DOMAIN_MISMATCH", "For now, aliases must use the same domain as their destination mailbox.");
    if (target.verificationStatus !== "verified") return fail(res, 409, "DOMAIN_NOT_VERIFIED", "Verify this domain before creating aliases.");
    const [mailboxConflict] = await db.select({ id: mailboxes.id }).from(mailboxes)
      .where(and(eq(mailboxes.domainId, target.domainId), eq(mailboxes.localPart, parsed.data.localPart))).limit(1);
    if (mailboxConflict) return fail(res, 409, "ADDRESS_IN_USE", "That address is already a mailbox on this domain.");
    const [created] = await db.insert(emailAliases).values({
      workspaceId: target.workspaceId, domainId: target.domainId, mailboxId: target.mailboxId,
      localPart: parsed.data.localPart,
    }).returning();
    res.status(201).json({ success: true, data: {
      ...created, address: `${created.localPart}@${target.domainName}`,
      mailboxAddress: `${target.mailboxLocalPart}@${target.domainName}`,
    } });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "23505") return fail(res, 409, "ADDRESS_IN_USE", "That alias address is already in use.");
    next(error);
  }
});

app.delete("/v1/aliases/:aliasId", requireUser, async (req: AuthedRequest, res, next) => {
  try {
    const [access] = await db.select({ id: emailAliases.id, role: workspaceMembers.role }).from(emailAliases)
      .innerJoin(workspaceMembers, eq(workspaceMembers.workspaceId, emailAliases.workspaceId))
      .where(and(eq(emailAliases.id, String(req.params.aliasId)), eq(workspaceMembers.userId, req.userId!))).limit(1);
    if (!access) return fail(res, 404, "ALIAS_NOT_FOUND", "The alias could not be found.");
    if (!(["owner", "admin"].includes(access.role))) return fail(res, 403, "FORBIDDEN", "You do not have permission to delete aliases.");
    await db.delete(emailAliases).where(eq(emailAliases.id, access.id));
    res.json({ success: true });
  } catch (error) { next(error); }
});

app.get("/v1/messages", requireUser, async (req: AuthedRequest, res, next) => {
  const workspaceId = String(req.query.workspaceId ?? "");
  const mailboxId = String(req.query.mailboxId ?? "");
  const search = String(req.query.search ?? "").trim().slice(0, 120);
  if (!workspaceId) return fail(res, 400, "WORKSPACE_REQUIRED", "Select a workspace.");
  try {
    const membership = await db.select({ role: workspaceMembers.role }).from(workspaceMembers)
      .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, req.userId!))).limit(1);
    if (!membership.length) return fail(res, 404, "WORKSPACE_NOT_FOUND", "The workspace could not be found.");
    let permittedMailboxIds: string[] | null = null;
    if (membership[0].role === "member") {
      const grants = await db.select({ mailboxId: mailboxAccess.mailboxId }).from(mailboxAccess)
        .where(and(eq(mailboxAccess.workspaceId, workspaceId), eq(mailboxAccess.userId, req.userId!)));
      permittedMailboxIds = grants.map(row => row.mailboxId);
    }
    if (mailboxId && permittedMailboxIds && !permittedMailboxIds.includes(mailboxId)) return fail(res, 404, "MAILBOX_NOT_FOUND", "The mailbox could not be found.");
    const filters = [eq(messages.workspaceId, workspaceId)];
    if (mailboxId) filters.push(eq(messages.mailboxId, mailboxId));
    if (permittedMailboxIds) filters.push(permittedMailboxIds.length ? inArray(messages.mailboxId, permittedMailboxIds) : eq(messages.mailboxId, "00000000-0000-0000-0000-000000000000"));
    if (search) filters.push(or(ilike(messages.subject, `%${search}%`), ilike(messages.fromAddress, `%${search}%`), ilike(messages.textBody, `%${search}%`), ilike(messages.htmlBody, `%${search}%`))!);
    const conditions = and(...filters);
    const rows = await db.select({
      id: messages.id, mailboxId: messages.mailboxId, fromAddress: messages.fromAddress,
      direction: messages.direction, toAddresses: messages.toAddresses, ccAddresses: messages.ccAddresses,
      inReplyToMessageId: messages.inReplyToMessageId, subject: messages.subject, textBody: messages.textBody, htmlBody: messages.htmlBody,
      category: messages.category, isRead: messages.isRead, isArchived: messages.isArchived, receivedAt: messages.receivedAt,
      mailboxAddress: mailboxes.localPart, domainName: domains.domainName,
    }).from(messages).innerJoin(mailboxes, eq(messages.mailboxId, mailboxes.id))
      .innerJoin(domains, eq(mailboxes.domainId, domains.id)).where(conditions)
      .orderBy(desc(messages.receivedAt)).limit(100);
    const senderAddresses = [...new Set(rows.filter(row => row.direction === "inbound").map(row => normalizeSenderAddress(row.fromAddress)))];
    const senderProfiles = senderAddresses.length ? await db.select({ senderAddress: messageSenderProfiles.senderAddress, displayName: messageSenderProfiles.displayName, profileImage: messageSenderProfiles.profileImage })
      .from(messageSenderProfiles).where(and(eq(messageSenderProfiles.workspaceId, workspaceId), inArray(messageSenderProfiles.senderAddress, senderAddresses))) : [];
    const senderProfileByAddress = new Map(senderProfiles.map(profile => [profile.senderAddress, profile]));
    res.json({ success: true, data: rows.map((row) => ({ ...row, senderProfile: row.direction === "inbound" ? senderProfileByAddress.get(normalizeSenderAddress(row.fromAddress)) ?? null : null, textBody: row.textBody ?? htmlToSafeText(row.htmlBody), htmlBody: undefined, mailboxAddress: `${row.mailboxAddress}@${row.domainName}` })) });
  } catch (error) { next(error); }
});

app.get("/v1/messages/:messageId/thread", requireUser, async (req: AuthedRequest, res, next) => {
  try {
    const [target] = await db.select({ id: messages.id, workspaceId: messages.workspaceId, mailboxId: messages.mailboxId, direction: messages.direction, fromAddress: messages.fromAddress, toAddresses: messages.toAddresses, subject: messages.subject, role: workspaceMembers.role, localPart: mailboxes.localPart, domainName: domains.domainName })
      .from(messages).innerJoin(workspaceMembers, eq(workspaceMembers.workspaceId, messages.workspaceId)).innerJoin(mailboxes, eq(mailboxes.id, messages.mailboxId)).innerJoin(domains, eq(domains.id, mailboxes.domainId))
      .where(and(eq(messages.id, String(req.params.messageId)), eq(workspaceMembers.userId, req.userId!))).limit(1);
    if (!target || (target.role === "member" && !(await memberCanUseMailbox(target.mailboxId, target.workspaceId, req.userId!)))) return fail(res, 404, "MESSAGE_NOT_FOUND", "The message could not be found.");
    const rows = await db.select({ id: messages.id, mailboxId: messages.mailboxId, fromAddress: messages.fromAddress, toAddresses: messages.toAddresses, ccAddresses: messages.ccAddresses, direction: messages.direction, subject: messages.subject, textBody: messages.textBody, htmlBody: messages.htmlBody, category: messages.category, isArchived: messages.isArchived, isRead: messages.isRead, receivedAt: messages.receivedAt, inReplyToMessageId: messages.inReplyToMessageId })
      .from(messages).where(and(eq(messages.workspaceId, target.workspaceId), eq(messages.mailboxId, target.mailboxId))).orderBy(asc(messages.receivedAt)).limit(500);
    const targetKey = `${normalizedThreadSubject(target.subject)}|${threadCounterparty(target)}`;
    const thread = rows.filter(row => row.id === target.id || `${normalizedThreadSubject(row.subject)}|${threadCounterparty(row)}` === targetKey);
    if (!thread.some(row => row.id === target.id)) return fail(res, 404, "MESSAGE_NOT_FOUND", "The message could not be found.");
    const inbound = thread.find(row => row.direction === "inbound");
    const senderEmail = inbound ? normalizeSenderAddress(inbound.fromAddress) : "";
    const [senderProfile] = senderEmail ? await db.select({ displayName: messageSenderProfiles.displayName, profileImage: messageSenderProfiles.profileImage })
      .from(messageSenderProfiles).where(and(eq(messageSenderProfiles.workspaceId, target.workspaceId), eq(messageSenderProfiles.senderAddress, senderEmail))).limit(1) : [];
    return res.json({ success: true, data: thread.map(row => ({ ...row, senderProfile: row.direction === "inbound" ? senderProfile ?? null : null, textBody: row.textBody ?? htmlToSafeText(row.htmlBody), htmlBody: undefined, mailboxAddress: `${target.localPart}@${target.domainName}` })) });
  } catch (error) { next(error); }
});

app.patch("/v1/messages/:messageId/sender-profile", requireUser, async (req: AuthedRequest, res, next) => {
  const image = req.body?.profileImage;
  const name = req.body?.displayName;
  if (image !== undefined && image !== null && (typeof image !== "string" || !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(image) || Buffer.byteLength(image, "utf8") > 1_500_000)) {
    return fail(res, 400, "INVALID_PROFILE_IMAGE", "Choose a PNG, JPG, or WebP image smaller than 1 MB.");
  }
  if (name !== undefined && (typeof name !== "string" || name.trim().length > 120)) return fail(res, 400, "INVALID_DISPLAY_NAME", "The sender name must be 120 characters or fewer.");
  if (image === undefined && name === undefined) return fail(res, 400, "PROFILE_REQUIRED", "Provide a sender name or photo to update.");
  try {
    const [access] = await db.select({ id: messages.id, workspaceId: messages.workspaceId, mailboxId: messages.mailboxId, fromAddress: messages.fromAddress, direction: messages.direction, role: workspaceMembers.role })
      .from(messages).innerJoin(workspaceMembers, eq(workspaceMembers.workspaceId, messages.workspaceId))
      .where(and(eq(messages.id, String(req.params.messageId)), eq(workspaceMembers.userId, req.userId!))).limit(1);
    if (!access || access.direction !== "inbound") return fail(res, 404, "MESSAGE_NOT_FOUND", "The sender could not be found.");
    if (access.role === "member" && !(await memberCanUseMailbox(access.mailboxId, access.workspaceId, req.userId!))) return fail(res, 404, "MESSAGE_NOT_FOUND", "The sender could not be found.");
    const senderAddress = normalizeSenderAddress(access.fromAddress);
    await db.insert(messageSenderProfiles).values({
      workspaceId: access.workspaceId, senderAddress,
      ...(name !== undefined ? { displayName: name.trim() || null } : {}),
      ...(image !== undefined ? { profileImage: image } : {}),
    }).onConflictDoUpdate({
      target: [messageSenderProfiles.workspaceId, messageSenderProfiles.senderAddress],
      set: { ...(name !== undefined ? { displayName: name.trim() || null } : {}), ...(image !== undefined ? { profileImage: image } : {}), updatedAt: new Date() },
    });
    const [profile] = await db.select({ displayName: messageSenderProfiles.displayName, profileImage: messageSenderProfiles.profileImage })
      .from(messageSenderProfiles).where(and(eq(messageSenderProfiles.workspaceId, access.workspaceId), eq(messageSenderProfiles.senderAddress, senderAddress))).limit(1);
    return res.json({ success: true, data: profile });
  } catch (error) { next(error); }
});

app.patch("/v1/messages/:messageId/read", requireUser, async (req: AuthedRequest, res, next) => {
  const isRead = req.body?.isRead;
  if (isRead !== undefined && typeof isRead !== "boolean") return fail(res, 400, "INVALID_READ_STATE", "Choose whether the message is read.");
  try {
    const access = await db.select({ id: messages.id, workspaceId: messages.workspaceId, mailboxId: messages.mailboxId, role: workspaceMembers.role }).from(messages)
      .innerJoin(workspaceMembers, eq(workspaceMembers.workspaceId, messages.workspaceId))
      .where(and(eq(messages.id, String(req.params.messageId)), eq(workspaceMembers.userId, req.userId!))).limit(1);
    if (!access.length) return fail(res, 404, "MESSAGE_NOT_FOUND", "The message could not be found.");
    if (access[0].role === "member" && !(await memberCanUseMailbox(access[0].mailboxId, access[0].workspaceId, req.userId!))) return fail(res, 404, "MESSAGE_NOT_FOUND", "The message could not be found.");
    await db.update(messages).set({ isRead: isRead ?? true }).where(eq(messages.id, String(req.params.messageId)));
    res.json({ success: true });
  } catch (error) { next(error); }
});

app.patch("/v1/messages/:messageId/archive", requireUser, async (req: AuthedRequest, res, next) => {
  if (typeof req.body?.isArchived !== "boolean") return fail(res, 400, "INVALID_ARCHIVE_STATE", "Choose whether the message is archived.");
  try {
    const [access] = await db.select({ id: messages.id, workspaceId: messages.workspaceId, mailboxId: messages.mailboxId, role: workspaceMembers.role }).from(messages)
      .innerJoin(workspaceMembers, eq(workspaceMembers.workspaceId, messages.workspaceId))
      .where(and(eq(messages.id, String(req.params.messageId)), eq(workspaceMembers.userId, req.userId!))).limit(1);
    if (!access) return fail(res, 404, "MESSAGE_NOT_FOUND", "The message could not be found.");
    if (access.role === "member" && !(await memberCanUseMailbox(access.mailboxId, access.workspaceId, req.userId!))) return fail(res, 404, "MESSAGE_NOT_FOUND", "The message could not be found.");
    await db.update(messages).set({ isArchived: req.body.isArchived }).where(eq(messages.id, access.id));
    res.json({ success: true, data: { isArchived: req.body.isArchived } });
  } catch (error) { next(error); }
});

app.patch("/v1/messages/:messageId/category", requireUser, async (req: AuthedRequest, res, next) => {
  const category = req.body?.category;
  if (!(category === "people" || category === "updates" || category === "promotions")) return fail(res, 400, "INVALID_CATEGORY", "Choose People, Updates, or Promotions.");
  try {
    const [access] = await db.select({ id: messages.id, workspaceId: messages.workspaceId, mailboxId: messages.mailboxId, fromAddress: messages.fromAddress, direction: messages.direction, role: workspaceMembers.role }).from(messages)
      .innerJoin(workspaceMembers, eq(workspaceMembers.workspaceId, messages.workspaceId))
      .where(and(eq(messages.id, String(req.params.messageId)), eq(workspaceMembers.userId, req.userId!))).limit(1);
    if (!access) return fail(res, 404, "MESSAGE_NOT_FOUND", "The message could not be found.");
    if (access.role === "member" && !(await memberCanUseMailbox(access.mailboxId, access.workspaceId, req.userId!))) return fail(res, 404, "MESSAGE_NOT_FOUND", "The message could not be found.");
    await db.update(messages).set({ category }).where(eq(messages.id, access.id));
    if (access.direction === "inbound") {
      await db.insert(messageCategoryRules).values({
        workspaceId: access.workspaceId,
        mailboxId: access.mailboxId,
        senderAddress: normalizeSenderAddress(access.fromAddress),
        category,
      }).onConflictDoUpdate({
        target: [messageCategoryRules.workspaceId, messageCategoryRules.mailboxId, messageCategoryRules.senderAddress],
        set: { category, updatedAt: new Date() },
      });
    }
    res.json({ success: true, data: { category } });
  } catch (error) { next(error); }
});

app.delete("/v1/messages/:messageId", requireUser, async (req: AuthedRequest, res, next) => {
  try {
    const [access] = await db.select({ id: messages.id, workspaceId: messages.workspaceId, mailboxId: messages.mailboxId, role: workspaceMembers.role }).from(messages)
      .innerJoin(workspaceMembers, eq(workspaceMembers.workspaceId, messages.workspaceId))
      .where(and(eq(messages.id, String(req.params.messageId)), eq(workspaceMembers.userId, req.userId!))).limit(1);
    if (!access) return fail(res, 404, "MESSAGE_NOT_FOUND", "The message could not be found.");
    if (access.role === "member" && !(await memberCanUseMailbox(access.mailboxId, access.workspaceId, req.userId!))) return fail(res, 404, "MESSAGE_NOT_FOUND", "The message could not be found.");
    await db.delete(messages).where(eq(messages.id, access.id));
    res.json({ success: true, message: "The Widesip copy of this message was deleted." });
  } catch (error) { next(error); }
});

app.post("/v1/mailboxes/:mailboxId/messages", requireUser, async (req: AuthedRequest, res, next) => {
  const parsed = composeEmailSchema.safeParse(req.body);
  if (!parsed.success) return fail(res, 400, "INVALID_MESSAGE", parsed.error.issues[0]?.message ?? "Check the message details.");
  let attachments: ReturnType<typeof validateEmailAttachments>;
  try { attachments = validateEmailAttachments(parsed.data.attachments); }
  catch (error) { return fail(res, 400, "INVALID_ATTACHMENT", error instanceof Error ? error.message : "Check the attachments."); }
  try {
    const [mailbox] = await db.select({
      id: mailboxes.id, workspaceId: mailboxes.workspaceId, localPart: mailboxes.localPart,
      displayName: mailboxes.displayName, domainName: domains.domainName, mailStatus: domains.mailStatus,
      domainId: domains.id, brandName: domainEmailTemplates.brandName, logoUrl: domainEmailTemplates.logoUrl,
      logoImageData: domainEmailTemplates.logoImageData, accentColor: domainEmailTemplates.accentColor,
      footerText: domainEmailTemplates.footerText, customHtml: domainEmailTemplates.customHtml,
      role: workspaceMembers.role,
    }).from(mailboxes).innerJoin(domains, eq(mailboxes.domainId, domains.id))
      .leftJoin(domainEmailTemplates, eq(domainEmailTemplates.domainId, domains.id))
      .innerJoin(workspaceMembers, eq(workspaceMembers.workspaceId, mailboxes.workspaceId))
      .where(and(eq(mailboxes.id, String(req.params.mailboxId)), eq(workspaceMembers.userId, req.userId!))).limit(1);
    if (!mailbox) return fail(res, 404, "MAILBOX_NOT_FOUND", "The mailbox could not be found.");
    if (mailbox.role === "member" && !(await memberCanUseMailbox(mailbox.id, mailbox.workspaceId, req.userId!))) return fail(res, 404, "MAILBOX_NOT_FOUND", "The mailbox could not be found.");
    if (mailbox.mailStatus !== "active") return fail(res, 409, "SENDING_NOT_READY", "Set up and verify sending for this domain first.");

    let recipient = parsed.data.recipient ?? "";
    let subject = parsed.data.subject ?? "";
    let replyMessage: { id: string; rfcMessageId: string | null; subject: string; fromAddress: string } | undefined;
    if (parsed.data.replyToMessageId) {
      [replyMessage] = await db.select({
        id: messages.id, rfcMessageId: messages.rfcMessageId, subject: messages.subject, fromAddress: messages.fromAddress,
      }).from(messages).innerJoin(workspaceMembers, eq(workspaceMembers.workspaceId, messages.workspaceId))
        .where(and(eq(messages.id, parsed.data.replyToMessageId), eq(messages.mailboxId, mailbox.id), eq(messages.direction, "inbound"), eq(workspaceMembers.userId, req.userId!))).limit(1);
      if (!replyMessage) return fail(res, 404, "REPLY_TARGET_NOT_FOUND", "The original inbox message could not be found.");
      recipient = emailAddressFromHeader(replyMessage.fromAddress);
      subject = /^re:/i.test(replyMessage.subject) ? replyMessage.subject : `Re: ${replyMessage.subject}`;
    }
    if (!recipient) return fail(res, 400, "INVALID_RECIPIENT", "Enter a valid recipient email address.");
    if (!await consumeRateLimit(rateLimitFingerprint("compose-send", req.userId!), 10, 60_000)) {
      return fail(res, 429, "SEND_LIMIT", "You can send up to ten messages per minute during this test period.");
    }

    const from = `${mailbox.displayName.replace(/[\r\n<>\"]/g, "").trim() || mailbox.localPart} <${mailbox.localPart}@${mailbox.domainName}>`;
    const publicUrl = process.env.WIDESIP_PUBLIC_URL?.replace(/\/$/, "");
    const html = renderBrandedMessageHtml({
      subject,
      body: parsed.data.text,
      template: {
        brandName: mailbox.brandName || mailbox.domainName,
        logoUrl: mailbox.logoImageData && publicUrl ? `${publicUrl}/v1/public/domains/${mailbox.domainId}/logo` : mailbox.logoUrl,
        accentColor: mailbox.accentColor || "#4165e8",
        footerText: mailbox.footerText || "",
        customHtml: mailbox.customHtml || "",
      },
      senderName: mailbox.displayName.trim() || mailbox.localPart,
      senderAddress: `${mailbox.localPart}@${mailbox.domainName}`,
    });
    const headers: Record<string, string> = {};
    if (replyMessage?.rfcMessageId) {
      headers["In-Reply-To"] = replyMessage.rfcMessageId;
      headers.References = replyMessage.rfcMessageId;
    }
    const result = await getMailProvider().send({
      from, to: [recipient], subject, text: parsed.data.text, html,
      ...(attachments.length ? { attachments: attachments.map(file => ({ filename: file.filename, content: file.content, content_type: file.contentType })) } : {}),
      ...(Object.keys(headers).length ? { headers } : {}),
    });
    const [saved] = await db.insert(messages).values({
      workspaceId: mailbox.workspaceId, mailboxId: mailbox.id, direction: "outbound",
      provider: getMailProvider().id, providerMessageId: result.id,
      inReplyToMessageId: replyMessage?.id ?? null,
      fromAddress: from, toAddresses: [recipient], subject, textBody: parsed.data.text,
      isRead: true, receivedAt: new Date(),
    }).returning({ id: messages.id });
    res.status(202).json({ success: true, data: { id: saved.id, providerMessageId: result.id, from, to: recipient, subject, message: "Widesip accepted the message for delivery." } });
  } catch (error) {
    console.error("Mailbox send failed:", error instanceof Error ? error.message : "unknown error");
    return fail(res, 502, "MESSAGE_SEND_FAILED", error instanceof Error ? error.message : "Widesip could not send this message.");
  }
});

app.get("/v1/mailboxes", requireUser, async (req: AuthedRequest, res, next) => {
  const workspaceId = String(req.query.workspaceId ?? "");
  if (!workspaceId) return fail(res, 400, "WORKSPACE_REQUIRED", "Select a workspace.");
  try {
    const membership = await db.select({ role: workspaceMembers.role }).from(workspaceMembers)
      .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, req.userId!))).limit(1);
    if (!membership.length) return fail(res, 404, "WORKSPACE_NOT_FOUND", "The workspace could not be found.");
    const grants = membership[0].role === "member"
      ? await db.select({ mailboxId: mailboxAccess.mailboxId }).from(mailboxAccess).where(and(eq(mailboxAccess.workspaceId, workspaceId), eq(mailboxAccess.userId, req.userId!)))
      : null;
    const allowedIds = grants?.map(grant => grant.mailboxId);
    const rows = await db.select({
      id: mailboxes.id, domainId: mailboxes.domainId, localPart: mailboxes.localPart,
      displayName: mailboxes.displayName, profileImage: mailboxes.profileImage, forwardingAddress: mailboxes.forwardingAddress,
      status: mailboxes.status, createdAt: mailboxes.createdAt, domainName: domains.domainName, mailStatus: domains.mailStatus,
      domainLogoUrl: domainEmailTemplates.logoUrl, domainLogoImageData: domainEmailTemplates.logoImageData,
    }).from(mailboxes).innerJoin(domains, eq(mailboxes.domainId, domains.id))
      .leftJoin(domainEmailTemplates, eq(domainEmailTemplates.domainId, domains.id))
      .where(allowedIds ? and(eq(mailboxes.workspaceId, workspaceId), allowedIds.length ? inArray(mailboxes.id, allowedIds) : eq(mailboxes.id, "00000000-0000-0000-0000-000000000000")) : eq(mailboxes.workspaceId, workspaceId)).orderBy(asc(mailboxes.createdAt));
    const publicUrl = process.env.WIDESIP_PUBLIC_URL?.replace(/\/$/, "");
    res.json({ success: true, data: rows.map((row) => ({ ...row, domainProfileImage: row.domainLogoImageData && publicUrl ? `${publicUrl}/v1/public/domains/${row.domainId}/logo` : row.domainLogoUrl, domainLogoImageData: undefined, forwardingAddress: membership[0].role === "member" ? null : row.forwardingAddress, address: `${row.localPart}@${row.domainName}` })) });
  } catch (error) { next(error); }
});

app.post("/v1/mailboxes", requireUser, async (req: AuthedRequest, res, next) => {
  const parsed = mailboxCreateSchema.safeParse(req.body);
  if (!parsed.success) return fail(res, 400, "INVALID_INPUT", parsed.error.issues[0]?.message ?? "Check the mailbox details.");
  try {
    const access = await db.select({ domainName: domains.domainName, verificationStatus: domains.verificationStatus, role: workspaceMembers.role })
      .from(domains).innerJoin(workspaceMembers, eq(workspaceMembers.workspaceId, domains.workspaceId))
      .where(and(eq(domains.id, parsed.data.domainId), eq(domains.workspaceId, parsed.data.workspaceId), eq(workspaceMembers.userId, req.userId!))).limit(1);
    if (!access.length) return fail(res, 404, "DOMAIN_NOT_FOUND", "The domain could not be found in this workspace.");
    if (!access[0].role || !["owner", "admin"].includes(access[0].role)) return fail(res, 403, "FORBIDDEN", "You do not have permission to create mailboxes.");
    if (access[0].verificationStatus !== "verified") return fail(res, 409, "DOMAIN_NOT_VERIFIED", "Verify this domain before creating an address.");
    const [created] = await db.insert(mailboxes).values({
      workspaceId: parsed.data.workspaceId, domainId: parsed.data.domainId,
      localPart: parsed.data.localPart, displayName: parsed.data.displayName,
      forwardingAddress: parsed.data.forwardingAddress || null,
    }).returning();
    res.status(201).json({ success: true, data: { ...created, address: `${created.localPart}@${access[0].domainName}` } });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "23505") {
      return fail(res, 409, "MAILBOX_EXISTS", "That address already exists for this domain.");
    }
    next(error);
  }
});

app.patch("/v1/mailboxes/:mailboxId/profile", requireUser, async (req: AuthedRequest, res, next) => {
  const image = req.body?.profileImage;
  if (image !== null && (typeof image !== "string" || !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(image) || Buffer.byteLength(image, "utf8") > 1_500_000)) {
    return fail(res, 400, "INVALID_PROFILE_IMAGE", "Choose a PNG, JPG, or WebP image smaller than 1 MB.");
  }
  try {
    const [access] = await db.select({ id: mailboxes.id, role: workspaceMembers.role }).from(mailboxes)
      .innerJoin(workspaceMembers, eq(workspaceMembers.workspaceId, mailboxes.workspaceId))
      .where(and(eq(mailboxes.id, String(req.params.mailboxId)), eq(workspaceMembers.userId, req.userId!))).limit(1);
    if (!access) return fail(res, 404, "MAILBOX_NOT_FOUND", "The mailbox could not be found.");
    if (!["owner", "admin"].includes(access.role)) return fail(res, 403, "FORBIDDEN", "Only workspace owners and admins can update this address profile.");
    const [updated] = await db.update(mailboxes).set({ profileImage: image, updatedAt: new Date() }).where(eq(mailboxes.id, access.id)).returning({ id: mailboxes.id, profileImage: mailboxes.profileImage });
    return res.json({ success: true, data: updated, message: image ? "Address profile photo updated." : "Address profile photo removed." });
  } catch (error) { next(error); }
});

app.post("/v1/mailboxes/:mailboxId/send-test", requireUser, async (req: AuthedRequest, res, next) => {
  const parsed = sendTestEmailSchema.safeParse(req.body);
  if (!parsed.success) return fail(res, 400, "INVALID_RECIPIENT", "Enter a valid address to receive the test email.");
  try {
    const [mailbox] = await db.select({
      id: mailboxes.id, localPart: mailboxes.localPart, displayName: mailboxes.displayName,
      domainName: domains.domainName, mailStatus: domains.mailStatus, role: workspaceMembers.role,
    }).from(mailboxes).innerJoin(domains, eq(mailboxes.domainId, domains.id))
      .innerJoin(workspaceMembers, eq(workspaceMembers.workspaceId, mailboxes.workspaceId))
      .where(and(eq(mailboxes.id, String(req.params.mailboxId)), eq(workspaceMembers.userId, req.userId!))).limit(1);
    if (!mailbox) return fail(res, 404, "MAILBOX_NOT_FOUND", "The mailbox could not be found.");
    if (!["owner", "admin"].includes(mailbox.role)) return fail(res, 403, "FORBIDDEN", "Only workspace owners and admins can send a test message.");
    if (mailbox.mailStatus !== "active") return fail(res, 409, "SENDING_NOT_READY", "Finish and verify sending setup for this domain first.");
    if (!await consumeRateLimit(rateLimitFingerprint("test-send", req.userId!), 3, 60_000)) {
      return fail(res, 429, "TEST_LIMIT", "You can send up to three test messages per minute.");
    }
    const address = `${mailbox.localPart}@${mailbox.domainName}`;
    const senderName = mailbox.displayName.replace(/[\r\n<>\"]/g, "").trim() || "Widesip";
    const result = await getMailProvider().send({
        from: `${senderName} <${address}>`,
        to: [parsed.data.recipient],
        subject: `A test message from ${address}`,
        text: `Your Widesip sending setup is working. This test was sent from ${address}.`,
    });
    res.status(202).json({ success: true, data: { id: result.id, to: parsed.data.recipient, from: address, message: "Widesip's mail service accepted the test message for delivery." } });
  } catch (error) {
    return fail(res, 502, "TEST_SEND_FAILED", error instanceof Error ? error.message : "Widesip could not send the test email.");
  }
});

app.use((error: unknown, req: Request, res: Response, _next: NextFunction) => {
  console.error(JSON.stringify({
    event: "request_error",
    method: req.method,
    path: req.path,
    message: error instanceof Error ? error.message : "unknown error",
    ...(process.env.NODE_ENV !== "production" && error instanceof Error ? { stack: error.stack } : {}),
  }));
  res.status(500).json({ success: false, error: { code: "INTERNAL_ERROR", message: "Something went wrong. Try again." } });
});

const port = Number(process.env.PORT ?? process.env.API_PORT ?? 4000);
app.listen(port, () => console.log(`Widesip API listening on ${port}`));
