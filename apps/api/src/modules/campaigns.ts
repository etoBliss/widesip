import { createHmac, timingSafeEqual } from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import { fromNodeHeaders } from "better-auth/node";
import { and, asc, desc, eq, inArray, isNull, notExists, or, sql } from "drizzle-orm";
import { auth } from "../auth.js";
import { campaignRecipients, campaigns, campaignTemplates, contacts, db, domainEmailTemplates, domains, mailboxAccess, mailboxes, workspaceMembers } from "@widesip/database";
import { campaignCreateSchema, campaignTemplateCreateSchema, campaignUpdateSchema } from "@widesip/validation";
import { getMailProvider } from "./mail/provider.js";
import { renderCampaignHtml } from "./mail/campaign-template.js";
import { personalizeCampaignText, validateEmailAttachments } from "./mail/attachments.js";

type AuthedRequest = Request & { userId?: string };
const router = express.Router();
const MAX_LOCAL_RECIPIENTS = 25;
const MAX_SCHEDULE_MS = 30 * 24 * 60 * 60 * 1000;

async function requireUser(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
    if (!session) return res.status(401).json({ success: false, error: { code: "UNAUTHENTICATED", message: "Sign in to continue." } });
    req.userId = session.user.id;
    next();
  } catch (error) { next(error); }
}
function fail(res: Response, status: number, code: string, message: string) {
  return res.status(status).json({ success: false, error: { code, message } });
}
async function canUseMailbox(userId: string, workspaceId: string, role: string, mailboxId: string) {
  if (role === "owner" || role === "admin") return true;
  const [grant] = await db.select({ id: mailboxAccess.id }).from(mailboxAccess)
    .where(and(eq(mailboxAccess.userId, userId), eq(mailboxAccess.workspaceId, workspaceId), eq(mailboxAccess.mailboxId, mailboxId))).limit(1);
  return Boolean(grant);
}
function scheduleError(value: string | null | undefined) {
  if (!value) return null;
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) return "Choose a valid scheduled send time.";
  if (time < Date.now() + 5 * 60 * 1000) return "Choose a send time at least five minutes from now.";
  if (time > Date.now() + MAX_SCHEDULE_MS) return "Resend supports scheduled sends up to 30 days ahead.";
  return null;
}
function tokenFor(contactId: string) {
  const secret = process.env.CAMPAIGN_UNSUBSCRIBE_SECRET;
  if (!secret || secret.length < 32) throw new Error("Campaign unsubscribe secret is not configured.");
  return `${contactId}.${createHmac("sha256", secret).update(contactId).digest("hex")}`;
}
function tokenForRecipient(recipientId: string) {
  const secret = process.env.CAMPAIGN_UNSUBSCRIBE_SECRET;
  if (!secret || secret.length < 32) throw new Error("Campaign unsubscribe secret is not configured.");
  return `r.${recipientId}.${createHmac("sha256", secret).update(`recipient:${recipientId}`).digest("hex")}`;
}
function recipientFromToken(token: string) {
  const [prefix, id, signature, extra] = token.split(".");
  const secret = process.env.CAMPAIGN_UNSUBSCRIBE_SECRET;
  if (!secret || prefix !== "r" || !id || !signature || extra || !/^[a-f0-9-]{36}$/i.test(id) || !/^[a-f0-9]{64}$/i.test(signature)) return null;
  const expected = createHmac("sha256", secret).update(`recipient:${id}`).digest();
  const candidate = Buffer.from(signature, "hex");
  return candidate.length === expected.length && timingSafeEqual(candidate, expected) ? id : null;
}
function recipientUnsubscribePage(token: string) {
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Email preferences - Widesip</title><style>body{font:16px Arial,sans-serif;background:#f5f7fb;color:#10233f;display:grid;place-items:center;min-height:100vh;margin:0}.card{background:white;border:1px solid #e5eaf2;border-radius:14px;padding:32px;max-width:440px}p{color:#64748b;line-height:1.6}button{background:#356ae6;color:white;border:0;padding:12px 16px;border-radius:8px;font-weight:bold;cursor:pointer}</style></head><body><main class="card"><h1>Email preferences</h1><p>Confirm to stop marketing messages from this Widesip workspace.</p><form method="post" action="/v1/unsubscribe/${encodeURIComponent(token)}"><button>Unsubscribe</button></form></main></body></html>`;
}
function contactFromToken(token: string) {
  const [contactId, signature, extra] = token.split(".");
  const secret = process.env.CAMPAIGN_UNSUBSCRIBE_SECRET;
  if (!secret || !contactId || !signature || extra || !/^[a-f0-9-]{36}$/i.test(contactId) || !/^[a-f0-9]{64}$/i.test(signature)) return null;
  const expected = createHmac("sha256", secret).update(contactId).digest();
  const candidate = Buffer.from(signature, "hex");
  return candidate.length === expected.length && timingSafeEqual(candidate, expected) ? contactId : null;
}
function unsubscribePage(message: string) {
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Email preferences - Widesip</title><style>body{font:16px Arial,sans-serif;background:#f5f7fb;color:#10233f;display:grid;place-items:center;min-height:100vh;margin:0}.card{background:white;border:1px solid #e5eaf2;border-radius:14px;padding:32px;max-width:440px;box-shadow:0 16px 50px #10233f12}h1{font-size:24px}p{color:#64748b;line-height:1.6}</style></head><body><main class="card"><h1>Email preferences</h1><p>${message}</p><p>You can close this page now.</p></main></body></html>`;
}
router.get("/v1/unsubscribe/:token", async (req, res) => {
  const token = String(req.params.token);
  if (recipientFromToken(token)) return res.type("html").send(recipientUnsubscribePage(token));
  const id = contactFromToken(token);
  if (!id) return res.status(400).type("html").send(unsubscribePage("This unsubscribe link is invalid."));
  return res.type("html").send(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Email preferences - Widesip</title><style>body{font:16px Arial,sans-serif;background:#f5f7fb;color:#10233f;display:grid;place-items:center;min-height:100vh;margin:0}.card{background:white;border:1px solid #e5eaf2;border-radius:14px;padding:32px;max-width:440px}p{color:#64748b;line-height:1.6}button{background:#356ae6;color:white;border:0;padding:12px 16px;border-radius:8px;font-weight:bold;cursor:pointer}</style></head><body><main class="card"><h1>Unsubscribe from emails?</h1><p>Confirm to stop marketing emails from this Widesip workspace. This will not affect messages you receive for other reasons.</p><form method="post" action="/v1/unsubscribe/${encodeURIComponent(String(req.params.token))}"><button>Unsubscribe</button></form></main></body></html>`);
});
router.post("/v1/unsubscribe/:token", async (req, res) => {
  const token = String(req.params.token);
  const recipientId = recipientFromToken(token);
  if (recipientId) {
    const [recipient] = await db.select({ id: campaignRecipients.id, contactId: campaignRecipients.contactId }).from(campaignRecipients).where(eq(campaignRecipients.id, recipientId)).limit(1);
    if (!recipient) return res.status(404).type("html").send(unsubscribePage("This recipient record was not found."));
    await db.update(campaignRecipients).set({ status: "unsubscribed", lastEventAt: new Date() }).where(eq(campaignRecipients.id, recipient.id));
    if (recipient.contactId) await db.update(contacts).set({ consentStatus: "unsubscribed", unsubscribedAt: new Date(), updatedAt: new Date() }).where(eq(contacts.id, recipient.contactId));
    return res.type("html").send(unsubscribePage("You have been unsubscribed successfully."));
  }
  const id = contactFromToken(token);
  if (!id) return res.status(400).type("html").send(unsubscribePage("This unsubscribe link is invalid."));
  const [updated] = await db.update(contacts).set({ consentStatus: "unsubscribed", unsubscribedAt: new Date(), updatedAt: new Date() }).where(eq(contacts.id, id)).returning({ id: contacts.id });
  if (!updated) return res.status(404).type("html").send(unsubscribePage("This contact was not found."));
  return res.type("html").send(unsubscribePage("You have been unsubscribed successfully."));
});
router.patch("/v1/contacts/:contactId/consent", requireUser, async (req: AuthedRequest, res, next) => {
  const consentSource = typeof req.body?.consentSource === "string" ? req.body.consentSource.trim() : "";
  if (!consentSource || consentSource.length > 120) return fail(res, 400, "INVALID_CONSENT", "Record how this contact explicitly agreed to receive emails.");
  try {
    const [access] = await db.select({ id: contacts.id, role: workspaceMembers.role }).from(contacts).innerJoin(workspaceMembers, eq(workspaceMembers.workspaceId, contacts.workspaceId)).where(and(eq(contacts.id, String(req.params.contactId)), eq(workspaceMembers.userId, req.userId!))).limit(1);
    if (!access) return fail(res, 404, "CONTACT_NOT_FOUND", "The contact could not be found.");
    const [updated] = await db.update(contacts).set({ consentStatus: "subscribed", consentSource, consentAt: new Date(), unsubscribedAt: null, updatedAt: new Date() }).where(eq(contacts.id, access.id)).returning();
    return res.json({ success: true, data: updated });
  } catch (error) { next(error); }
});

router.get("/v1/campaign-templates", requireUser, async (req: AuthedRequest, res, next) => {
  const workspaceId = String(req.query.workspaceId ?? "");
  if (!workspaceId) return fail(res, 400, "WORKSPACE_REQUIRED", "Select a workspace.");
  try {
    const [member] = await db.select({ role: workspaceMembers.role }).from(workspaceMembers).where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, req.userId!))).limit(1);
    if (!member) return fail(res, 404, "WORKSPACE_NOT_FOUND", "The workspace could not be found.");
    // Campaign templates are shared workspace resources available to all members.
    const rows = await db.select().from(campaignTemplates).where(eq(campaignTemplates.workspaceId, workspaceId)).orderBy(desc(campaignTemplates.createdAt));
    return res.json({ success: true, data: rows });
  } catch (error) { next(error); }
});
router.post("/v1/campaign-templates", requireUser, async (req: AuthedRequest, res, next) => {
  const parsed = campaignTemplateCreateSchema.safeParse(req.body);
  if (!parsed.success) return fail(res, 400, "INVALID_TEMPLATE", parsed.error.issues[0]?.message ?? "Check the template details.");
  try {
    const [member] = await db.select({ role: workspaceMembers.role }).from(workspaceMembers).where(and(eq(workspaceMembers.workspaceId, parsed.data.workspaceId), eq(workspaceMembers.userId, req.userId!))).limit(1);
    if (!member) return fail(res, 404, "WORKSPACE_NOT_FOUND", "The workspace could not be found.");
    const [created] = await db.insert(campaignTemplates).values({ ...parsed.data, createdByUserId: req.userId! }).returning();
    return res.status(201).json({ success: true, data: created });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "23505") return fail(res, 409, "TEMPLATE_EXISTS", "A template with that name already exists.");
    next(error);
  }
});
router.delete("/v1/campaign-templates/:templateId", requireUser, async (req: AuthedRequest, res, next) => {
  try {
    const [row] = await db.select({ id: campaignTemplates.id, role: workspaceMembers.role }).from(campaignTemplates).innerJoin(workspaceMembers, eq(workspaceMembers.workspaceId, campaignTemplates.workspaceId)).where(and(eq(campaignTemplates.id, String(req.params.templateId)), eq(workspaceMembers.userId, req.userId!))).limit(1);
    if (!row) return fail(res, 404, "TEMPLATE_NOT_FOUND", "The template could not be found.");
    await db.delete(campaignTemplates).where(eq(campaignTemplates.id, row.id));
    return res.json({ success: true });
  } catch (error) { next(error); }
});

router.get("/v1/campaigns", requireUser, async (req: AuthedRequest, res, next) => {
  const workspaceId = String(req.query.workspaceId ?? "");
  if (!workspaceId) return fail(res, 400, "WORKSPACE_REQUIRED", "Select a workspace.");
  try {
    const [member] = await db.select({ role: workspaceMembers.role }).from(workspaceMembers).where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, req.userId!))).limit(1);
    if (!member) return fail(res, 404, "WORKSPACE_NOT_FOUND", "The workspace could not be found.");
    const memberMailboxIds = member.role === "owner" || member.role === "admin" ? null : (await db.select({ mailboxId: mailboxAccess.mailboxId }).from(mailboxAccess).where(and(eq(mailboxAccess.workspaceId, workspaceId), eq(mailboxAccess.userId, req.userId!)))).map(row => row.mailboxId);
    const rows = memberMailboxIds && !memberMailboxIds.length ? [] : await db.select({ id: campaigns.id, workspaceId: campaigns.workspaceId, mailboxId: campaigns.mailboxId, name: campaigns.name, subject: campaigns.subject, body: campaigns.body, audienceMode: campaigns.audienceMode, audienceContactIds: campaigns.audienceContactIds, manualRecipients: campaigns.manualRecipients, manualConsentConfirmed: campaigns.manualConsentConfirmed, attachments: campaigns.attachments, status: campaigns.status, recipientCount: campaigns.recipientCount, scheduledAt: campaigns.scheduledAt, sentAt: campaigns.sentAt, createdAt: campaigns.createdAt, localPart: mailboxes.localPart, domainName: domains.domainName }).from(campaigns).innerJoin(mailboxes, eq(campaigns.mailboxId, mailboxes.id)).innerJoin(domains, eq(mailboxes.domainId, domains.id)).where(memberMailboxIds ? and(eq(campaigns.workspaceId, workspaceId), inArray(campaigns.mailboxId, memberMailboxIds)) : eq(campaigns.workspaceId, workspaceId)).orderBy(desc(campaigns.createdAt)).limit(100);
    const recipientRows = rows.length ? await db.select({ campaignId: campaignRecipients.campaignId, email: campaignRecipients.email, status: campaignRecipients.status, error: campaignRecipients.error }).from(campaignRecipients).innerJoin(campaigns, eq(campaignRecipients.campaignId, campaigns.id)).where(and(eq(campaigns.workspaceId, workspaceId), inArray(campaignRecipients.campaignId, rows.map(row => row.id)))) : [];
    const stats = new Map<string, Record<string, number>>();
    const issues = new Map<string, Array<{ email: string; status: string; error: string | null }>>();
    for (const item of recipientRows) {
      const current = stats.get(item.campaignId) ?? {};
      current[item.status] = (current[item.status] ?? 0) + 1;
      stats.set(item.campaignId, current);
      if (["bounced", "complained", "suppressed", "failed"].includes(item.status)) {
        const currentIssues = issues.get(item.campaignId) ?? [];
        currentIssues.push({ email: item.email, status: item.status, error: item.error });
        issues.set(item.campaignId, currentIssues);
      }
    }
    return res.json({ success: true, data: rows.map(row => ({ ...row, attachments: row.attachments.map(({ filename, contentType }) => ({ filename, contentType })), fromAddress: `${row.localPart}@${row.domainName}`, recipientStats: stats.get(row.id) ?? {}, recipientIssues: issues.get(row.id) ?? [] })) });
  } catch (error) { next(error); }
});
router.get("/v1/campaigns/:campaignId", requireUser, async (req: AuthedRequest, res, next) => {
  try {
    const [row] = await db.select({ campaign: campaigns, role: workspaceMembers.role }).from(campaigns)
      .innerJoin(workspaceMembers, eq(workspaceMembers.workspaceId, campaigns.workspaceId))
      .where(and(eq(campaigns.id, String(req.params.campaignId)), eq(workspaceMembers.userId, req.userId!))).limit(1);
    if (!row) return fail(res, 404, "CAMPAIGN_NOT_FOUND", "The campaign could not be found.");
    if (!(await canUseMailbox(req.userId!, row.campaign.workspaceId, row.role, row.campaign.mailboxId))) return fail(res, 404, "CAMPAIGN_NOT_FOUND", "The campaign could not be found.");
    return res.json({ success: true, data: row.campaign });
  } catch (error) { next(error); }
});
router.get("/v1/campaigns/:campaignId/recipients", requireUser, async (req: AuthedRequest, res, next) => {
  try {
    const [campaign] = await db.select({ workspaceId: campaigns.workspaceId, mailboxId: campaigns.mailboxId, role: workspaceMembers.role }).from(campaigns)
      .innerJoin(workspaceMembers, eq(workspaceMembers.workspaceId, campaigns.workspaceId))
      .where(and(eq(campaigns.id, String(req.params.campaignId)), eq(workspaceMembers.userId, req.userId!))).limit(1);
    if (!campaign) return fail(res, 404, "CAMPAIGN_NOT_FOUND", "The campaign could not be found.");
    if (!(await canUseMailbox(req.userId!, campaign.workspaceId, campaign.role, campaign.mailboxId))) return fail(res, 404, "CAMPAIGN_NOT_FOUND", "The campaign could not be found.");
    const rows = await db.select({ id: campaignRecipients.id, email: campaignRecipients.email, recipientName: campaignRecipients.recipientName, status: campaignRecipients.status, error: campaignRecipients.error, sentAt: campaignRecipients.sentAt, deliveredAt: campaignRecipients.deliveredAt, lastEventAt: campaignRecipients.lastEventAt }).from(campaignRecipients).where(eq(campaignRecipients.campaignId, String(req.params.campaignId))).orderBy(asc(campaignRecipients.createdAt));
    return res.json({ success: true, data: rows });
  } catch (error) { next(error); }
});
router.post("/v1/campaigns", requireUser, async (req: AuthedRequest, res, next) => {
  const parsed = campaignCreateSchema.safeParse(req.body);
  if (!parsed.success) return fail(res, 400, "INVALID_CAMPAIGN", parsed.error.issues[0]?.message ?? "Check the campaign details.");
  let attachments;
  try { attachments = validateEmailAttachments(parsed.data.attachments); }
  catch (error) { return fail(res, 400, "INVALID_ATTACHMENT", error instanceof Error ? error.message : "Check the attachments."); }
  const timingIssue = scheduleError(parsed.data.scheduledAt);
  if (timingIssue) return fail(res, 400, "INVALID_SCHEDULE", timingIssue);
  try {
    const [mailbox] = await db.select({ id: mailboxes.id, mailStatus: domains.mailStatus, role: workspaceMembers.role }).from(mailboxes).innerJoin(domains, eq(mailboxes.domainId, domains.id)).innerJoin(workspaceMembers, eq(workspaceMembers.workspaceId, mailboxes.workspaceId)).where(and(eq(mailboxes.id, parsed.data.mailboxId), eq(mailboxes.workspaceId, parsed.data.workspaceId), eq(workspaceMembers.userId, req.userId!))).limit(1);
    if (!mailbox) return fail(res, 404, "MAILBOX_NOT_FOUND", "Choose a mailbox in this workspace.");
    if (!(await canUseMailbox(req.userId!, parsed.data.workspaceId, mailbox.role, mailbox.id))) return fail(res, 403, "MAILBOX_ACCESS_REQUIRED", "You can only create campaigns from an address assigned to you.");
    if (mailbox.mailStatus !== "active") return fail(res, 409, "SENDING_NOT_READY", "Choose a mailbox whose domain has completed sending setup.");
    const [created] = await db.insert(campaigns).values({ ...parsed.data, attachments, scheduledAt: parsed.data.scheduledAt ? new Date(parsed.data.scheduledAt) : null, createdByUserId: req.userId! }).returning();
    return res.status(201).json({ success: true, data: created });
  } catch (error) { next(error); }
});
router.patch("/v1/campaigns/:campaignId", requireUser, async (req: AuthedRequest, res, next) => {
  const parsed = campaignUpdateSchema.safeParse(req.body);
  if (!parsed.success) return fail(res, 400, "INVALID_CAMPAIGN", parsed.error.issues[0]?.message ?? "Check the campaign details.");
  const timingIssue = scheduleError(parsed.data.scheduledAt);
  if (timingIssue) return fail(res, 400, "INVALID_SCHEDULE", timingIssue);
  let attachments;
  try { attachments = validateEmailAttachments(parsed.data.attachments); }
  catch (error) { return fail(res, 400, "INVALID_ATTACHMENT", error instanceof Error ? error.message : "Check the attachments."); }
  try {
    const [existing] = await db.select({ id: campaigns.id, mailboxId: campaigns.mailboxId, workspaceId: campaigns.workspaceId, status: campaigns.status, role: workspaceMembers.role }).from(campaigns).innerJoin(workspaceMembers, eq(workspaceMembers.workspaceId, campaigns.workspaceId)).where(and(eq(campaigns.id, String(req.params.campaignId)), eq(workspaceMembers.userId, req.userId!))).limit(1);
    if (!existing) return fail(res, 404, "CAMPAIGN_NOT_FOUND", "The campaign could not be found.");
    if (!(await canUseMailbox(req.userId!, existing.workspaceId, existing.role, existing.mailboxId))) return fail(res, 404, "CAMPAIGN_NOT_FOUND", "The campaign could not be found.");
    if (existing.status !== "draft") return fail(res, 409, "CAMPAIGN_NOT_EDITABLE", "Only a draft can be edited. Cancel a scheduled campaign before changing it.");
    const [mailbox] = await db.select({ id: mailboxes.id, mailStatus: domains.mailStatus }).from(mailboxes).innerJoin(domains, eq(mailboxes.domainId, domains.id)).where(and(eq(mailboxes.id, parsed.data.mailboxId), eq(mailboxes.workspaceId, existing.workspaceId))).limit(1);
    if (!mailbox || mailbox.mailStatus !== "active") return fail(res, 409, "SENDING_NOT_READY", "Choose an active sending mailbox in this workspace.");
    if (!(await canUseMailbox(req.userId!, existing.workspaceId, existing.role, mailbox.id))) return fail(res, 403, "MAILBOX_ACCESS_REQUIRED", "You can only move a campaign to an address assigned to you.");
    const [updated] = await db.update(campaigns).set({ mailboxId: mailbox.id, name: parsed.data.name, subject: parsed.data.subject, body: parsed.data.body, audienceMode: parsed.data.audienceMode, audienceContactIds: parsed.data.audienceContactIds, manualRecipients: parsed.data.manualRecipients, manualConsentConfirmed: parsed.data.manualConsentConfirmed, attachments, scheduledAt: parsed.data.scheduledAt ? new Date(parsed.data.scheduledAt) : null, updatedAt: new Date() }).where(eq(campaigns.id, existing.id)).returning();
    return res.json({ success: true, data: updated });
  } catch (error) { next(error); }
});
router.post("/v1/campaigns/:campaignId/send", requireUser, async (req: AuthedRequest, res, next) => {
  try {
    const [campaign] = await db.select({ id: campaigns.id, workspaceId: campaigns.workspaceId, mailboxId: campaigns.mailboxId, name: campaigns.name, subject: campaigns.subject, body: campaigns.body, audienceMode: campaigns.audienceMode, audienceContactIds: campaigns.audienceContactIds, manualRecipients: campaigns.manualRecipients, manualConsentConfirmed: campaigns.manualConsentConfirmed, attachments: campaigns.attachments, status: campaigns.status, scheduledAt: campaigns.scheduledAt, role: workspaceMembers.role, localPart: mailboxes.localPart, displayName: mailboxes.displayName, domainId: domains.id, domainName: domains.domainName, mailStatus: domains.mailStatus, brandName: domainEmailTemplates.brandName, logoUrl: domainEmailTemplates.logoUrl, logoImageData: domainEmailTemplates.logoImageData, accentColor: domainEmailTemplates.accentColor, footerText: domainEmailTemplates.footerText }).from(campaigns).innerJoin(workspaceMembers, eq(workspaceMembers.workspaceId, campaigns.workspaceId)).innerJoin(mailboxes, eq(mailboxes.id, campaigns.mailboxId)).innerJoin(domains, eq(domains.id, mailboxes.domainId)).leftJoin(domainEmailTemplates, eq(domainEmailTemplates.domainId, domains.id)).where(and(eq(campaigns.id, String(req.params.campaignId)), eq(workspaceMembers.userId, req.userId!))).limit(1);
    if (!campaign) return fail(res, 404, "CAMPAIGN_NOT_FOUND", "The campaign could not be found.");
    if (!(await canUseMailbox(req.userId!, campaign.workspaceId, campaign.role, campaign.mailboxId))) return fail(res, 404, "CAMPAIGN_NOT_FOUND", "The campaign could not be found.");
    if (campaign.status !== "draft") return fail(res, 409, "CAMPAIGN_ALREADY_SENT", "Only a draft campaign can be sent.");
    if (campaign.mailStatus !== "active") return fail(res, 409, "SENDING_NOT_READY", "The sending mailbox is not ready.");
    const timingIssue = scheduleError(campaign.scheduledAt?.toISOString());
    if (timingIssue) return fail(res, 400, "INVALID_SCHEDULE", timingIssue);
    const publicUrl = process.env.WIDESIP_PUBLIC_URL?.replace(/\/$/, "");
    const secret = process.env.CAMPAIGN_UNSUBSCRIBE_SECRET;
    if (!publicUrl || !/^https:\/\//i.test(publicUrl) || !secret || secret.length < 32) return fail(res, 503, "UNSUBSCRIBE_NOT_CONFIGURED", "Set WIDESIP_PUBLIC_URL to your HTTPS local tunnel and add a 32-character CAMPAIGN_UNSUBSCRIBE_SECRET in the root .env before sending.");
    const priorSuppression = notExists(db.select({ id: campaignRecipients.id }).from(campaignRecipients).where(and(eq(campaignRecipients.contactId, contacts.id), or(eq(campaignRecipients.status, "bounced"), eq(campaignRecipients.status, "complained"), eq(campaignRecipients.status, "suppressed"), eq(campaignRecipients.status, "unsubscribed")))));
    let eligible: Array<{ id: string | null; email: string; name: string; consentSource: string | null; consentAt: Date | null }> = [];
    if (campaign.audienceMode === "selected") {
      if (!campaign.audienceContactIds.length && !campaign.manualRecipients.length) return fail(res, 409, "EMPTY_AUDIENCE", "Select at least one opted-in contact or add a direct recipient.");
      if (campaign.audienceContactIds.length) {
        eligible = await db.select({ id: contacts.id, email: contacts.email, name: sql<string>`trim(concat_ws(' ', ${contacts.firstName}, ${contacts.lastName}))`, consentSource: contacts.consentSource, consentAt: contacts.consentAt })
          .from(contacts).where(and(eq(contacts.workspaceId, campaign.workspaceId), inArray(contacts.id, campaign.audienceContactIds), eq(contacts.consentStatus, "subscribed"), isNull(contacts.unsubscribedAt), priorSuppression));
        if (eligible.length !== campaign.audienceContactIds.length) return fail(res, 409, "AUDIENCE_CHANGED", "One or more selected contacts are no longer opted in or are suppressed. Review the audience before sending.");
      }
    } else if (campaign.audienceMode === "all_opted_in") {
      eligible = await db.select({ id: contacts.id, email: contacts.email, name: sql<string>`trim(concat_ws(' ', ${contacts.firstName}, ${contacts.lastName}))`, consentSource: contacts.consentSource, consentAt: contacts.consentAt }).from(contacts)
        .where(and(eq(contacts.workspaceId, campaign.workspaceId), eq(contacts.consentStatus, "subscribed"), isNull(contacts.unsubscribedAt), priorSuppression)).orderBy(asc(contacts.createdAt)).limit(MAX_LOCAL_RECIPIENTS + 1);
    }
    const direct = campaign.manualRecipients.map(recipient => ({ id: null, email: recipient.email.trim().toLowerCase(), name: recipient.name, consentSource: "manual_consent_confirmation", consentAt: new Date() }));
    if (direct.length && !campaign.manualConsentConfirmed) return fail(res, 409, "CONSENT_CONFIRMATION_REQUIRED", "Confirm that each manually entered recipient agreed to receive this campaign.");
    const seen = new Set(eligible.map(recipient => recipient.email.toLowerCase()));
    for (const recipient of direct) if (!seen.has(recipient.email)) { eligible.push(recipient); seen.add(recipient.email); }
    if (!eligible.length) return fail(res, 409, "NO_SUBSCRIBED_CONTACTS", "Choose opted-in contacts or add recipients who have agreed to receive this campaign.");
    if (eligible.length > MAX_LOCAL_RECIPIENTS) return fail(res, 409, "LOCAL_SEND_CAP", `Local campaign sending is capped at ${MAX_LOCAL_RECIPIENTS} total recipients.`);
    const reserved = await db.transaction(async tx => {
      const [locked] = await tx.update(campaigns).set({ status: "sending", recipientCount: eligible.length, updatedAt: new Date() }).where(and(eq(campaigns.id, campaign.id), eq(campaigns.status, "draft"))).returning({ id: campaigns.id });
      if (!locked) return false;
      await tx.insert(campaignRecipients).values(eligible.map(contact => ({ campaignId: campaign.id, contactId: contact.id, email: contact.email, recipientName: contact.name || null, consentSource: contact.consentSource, consentAt: contact.consentAt })));
      return true;
    });
    if (!reserved) return fail(res, 409, "CAMPAIGN_ALREADY_SENT", "This campaign is already being processed.");
    const isScheduled = Boolean(campaign.scheduledAt);
    const fromAddress = `${campaign.localPart}@${campaign.domainName}`;
    const safeName = campaign.displayName.replace(/[\r\n<>\"]/g, "").trim() || "Widesip";
    const from = `${safeName} <${fromAddress}>`;
    let accepted = 0;
    for (let index = 0; index < eligible.length; index++) {
      const contact = eligible[index];
      const recipientRow = await db.select({ id: campaignRecipients.id }).from(campaignRecipients).where(and(eq(campaignRecipients.campaignId, campaign.id), eq(campaignRecipients.email, contact.email))).limit(1).then(rows => rows[0]);
      if (!recipientRow) continue;
      const unsubscribeUrl = `${publicUrl}/v1/unsubscribe/${encodeURIComponent(tokenForRecipient(recipientRow.id))}`;
      try {
        const template = { brandName: campaign.brandName || safeName, logoUrl: campaign.logoImageData ? `${publicUrl}/v1/public/domains/${campaign.domainId}/logo` : campaign.logoUrl, accentColor: campaign.accentColor || "#4165e8", footerText: campaign.footerText || "" };
        const textFooter = campaign.footerText ? `\n\n${campaign.footerText}` : "";
        const personalizedSubject = personalizeCampaignText(campaign.subject, contact);
        const personalizedBody = personalizeCampaignText(campaign.body, contact);
        const result = await getMailProvider().send({ from, to: [contact.email], subject: personalizedSubject, text: `${personalizedBody}${textFooter}\n\n-\nUnsubscribe from these emails: ${unsubscribeUrl}`, html: renderCampaignHtml({ subject: personalizedSubject, body: personalizedBody, unsubscribeUrl, template }), headers: { "List-Unsubscribe": `<${unsubscribeUrl}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" }, attachments: campaign.attachments.map(file => ({ filename: file.filename, content: file.content, content_type: file.contentType })), tags: [{ name: "campaign_id", value: campaign.id }, { name: "recipient_id", value: recipientRow.id }], ...(campaign.scheduledAt ? { scheduledAt: campaign.scheduledAt.toISOString() } : {}) });
        await db.update(campaignRecipients).set({ status: isScheduled ? "scheduled" : "sent", providerMessageId: result.id, sentAt: isScheduled ? null : new Date() }).where(eq(campaignRecipients.id, recipientRow.id));
        accepted++;
      } catch (error) {
        await db.update(campaignRecipients).set({ status: "failed", error: error instanceof Error ? error.message.slice(0, 500) : "Delivery request failed." }).where(eq(campaignRecipients.id, recipientRow.id));
      }
    }
    const status = accepted === eligible.length ? (isScheduled ? "scheduled" : "sent") : accepted ? "partial" : "failed";
    await db.update(campaigns).set({ status, sentAt: isScheduled ? null : new Date(), updatedAt: new Date() }).where(eq(campaigns.id, campaign.id));
    return res.status(202).json({ success: true, data: { accepted, failed: eligible.length - accepted, status, message: isScheduled ? `${accepted} emails were accepted for scheduled delivery.` : `${accepted} of ${eligible.length} messages were accepted by the mail provider.` } });
  } catch (error) { next(error); }
});
router.post("/v1/campaigns/:campaignId/cancel-schedule", requireUser, async (req: AuthedRequest, res, next) => {
  try {
    const [campaign] = await db.select({ id: campaigns.id, workspaceId: campaigns.workspaceId, mailboxId: campaigns.mailboxId, status: campaigns.status, scheduledAt: campaigns.scheduledAt, role: workspaceMembers.role }).from(campaigns).innerJoin(workspaceMembers, eq(workspaceMembers.workspaceId, campaigns.workspaceId)).where(and(eq(campaigns.id, String(req.params.campaignId)), eq(workspaceMembers.userId, req.userId!))).limit(1);
    if (!campaign) return fail(res, 404, "CAMPAIGN_NOT_FOUND", "The campaign could not be found.");
    if (!(await canUseMailbox(req.userId!, campaign.workspaceId, campaign.role, campaign.mailboxId))) return fail(res, 404, "CAMPAIGN_NOT_FOUND", "The campaign could not be found.");
    if (!["scheduled", "partial"].includes(campaign.status) || !campaign.scheduledAt) return fail(res, 409, "NOT_SCHEDULED", "This campaign has no scheduled emails to cancel.");
    const allRows = await db.select().from(campaignRecipients).where(eq(campaignRecipients.campaignId, campaign.id));
    const queued = allRows.filter(row => row.status === "scheduled");
    const safeToReturnToDraft = allRows.every(row => ["scheduled", "canceled", "failed"].includes(row.status));
    const canceledIds: string[] = [];
    const errors: string[] = [];
    for (const row of queued) {
      if (!row.providerMessageId) { errors.push(row.email); continue; }
      try { await getMailProvider().cancelScheduled(row.providerMessageId); canceledIds.push(row.id); }
      catch { errors.push(row.email); }
    }
    if (canceledIds.length) await db.update(campaignRecipients).set({ status: "canceled", lastEventAt: new Date() }).where(and(eq(campaignRecipients.campaignId, campaign.id), inArray(campaignRecipients.id, canceledIds)));
    if (errors.length) {
      await db.update(campaigns).set({ status: "partial", updatedAt: new Date() }).where(eq(campaigns.id, campaign.id));
      return fail(res, 502, "CANCEL_PARTIAL", "Some scheduled messages could not be canceled. Check Resend before editing.");
    }
    if (!safeToReturnToDraft) {
      await db.update(campaigns).set({ status: "partial", updatedAt: new Date() }).where(eq(campaigns.id, campaign.id));
      return res.json({ success: true, data: { message: "Canceled the remaining queued messages. Some recipients were already processed, so this campaign remains locked to prevent duplicate sends." } });
    }
    await db.delete(campaignRecipients).where(eq(campaignRecipients.campaignId, campaign.id));
    await db.update(campaigns).set({ status: "draft", recipientCount: 0, sentAt: null, updatedAt: new Date() }).where(eq(campaigns.id, campaign.id));
    return res.json({ success: true, data: { message: "Scheduled emails canceled. The campaign is a draft again and can be edited." } });
  } catch (error) { next(error); }
});

export async function handleCampaignEmailEvent(event: { type: string; created_at?: string; data?: { email_id?: string; bounce?: { message?: string }; to?: string[]; tags?: Record<string, string> } }) {
  const emailId = event.data?.email_id;
  const statusByEvent: Record<string, "sent" | "delivered" | "delivery_delayed" | "bounced" | "complained" | "suppressed"> = {
    "email.sent": "sent", "email.delivered": "delivered", "email.delivery_delayed": "delivery_delayed",
    "email.bounced": "bounced", "email.complained": "complained", "email.suppressed": "suppressed",
  };
  const status = statusByEvent[event.type];
  if (!status || !emailId) return false;
  let [row] = await db.select({ id: campaignRecipients.id, campaignId: campaignRecipients.campaignId, contactId: campaignRecipients.contactId, lastEventAt: campaignRecipients.lastEventAt }).from(campaignRecipients).where(eq(campaignRecipients.providerMessageId, emailId)).limit(1);
  if (!row && event.data?.tags?.recipient_id && event.data.tags.campaign_id) {
    [row] = await db.select({ id: campaignRecipients.id, campaignId: campaignRecipients.campaignId, contactId: campaignRecipients.contactId, lastEventAt: campaignRecipients.lastEventAt }).from(campaignRecipients).where(and(eq(campaignRecipients.id, event.data.tags.recipient_id), eq(campaignRecipients.campaignId, event.data.tags.campaign_id))).limit(1);
  }
  if (!row) return false;
  const eventAt = event.created_at && Number.isFinite(Date.parse(event.created_at)) ? new Date(event.created_at) : new Date();
  if (row.lastEventAt && eventAt < row.lastEventAt) return true;
  await db.update(campaignRecipients).set({
    status, lastEventAt: eventAt,
    ...(status === "sent" ? { sentAt: eventAt } : {}),
    ...(status === "delivered" ? { deliveredAt: eventAt } : {}),
    ...(status === "bounced" ? { bouncedAt: eventAt, error: event.data?.bounce?.message?.slice(0, 500) ?? "The recipient mail server rejected this message." } : {}),
    ...(status === "complained" ? { complainedAt: eventAt, error: "The recipient reported this message as spam." } : {}),
    ...(status === "suppressed" ? { error: "The mail provider suppressed this recipient." } : {}),
  }).where(eq(campaignRecipients.id, row.id));
  const [campaign] = await db.select({ status: campaigns.status }).from(campaigns).where(eq(campaigns.id, row.campaignId)).limit(1);
  if (!campaign) return true;
  if (campaign.status === "scheduled" && status === "sent") await db.update(campaigns).set({ status: "sending", sentAt: eventAt, updatedAt: new Date() }).where(eq(campaigns.id, row.campaignId));
  const recipientStates = await db.select({ status: campaignRecipients.status }).from(campaignRecipients).where(eq(campaignRecipients.campaignId, row.campaignId));
  const terminal = new Set(["delivered", "bounced", "complained", "suppressed", "failed", "canceled"]);
  if (recipientStates.length && recipientStates.every(item => terminal.has(item.status))) {
    const good = recipientStates.filter(item => item.status === "delivered").length;
    await db.update(campaigns).set({ status: good === recipientStates.length ? "sent" : good ? "partial" : "failed", sentAt: new Date(), updatedAt: new Date() }).where(eq(campaigns.id, row.campaignId));
  }
  return true;
}

export const campaignRouter = router;
