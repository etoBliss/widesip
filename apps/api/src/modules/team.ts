import { createHash, randomBytes } from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import { fromNodeHeaders } from "better-auth/node";
import { and, desc, eq, gt, ilike, inArray } from "drizzle-orm";
import { auth } from "../auth.js";
import { db, domains, mailboxAccess, mailboxes, users, workspaceInvitations, workspaceMembers, workspaces } from "@widesip/database";
import { teamInvitationCreateSchema, teamMemberMailboxAccessSchema, teamMemberRoleSchema } from "@widesip/validation";
import { sendProductEmail } from "../email.js";

type AuthedRequest = Request & { userId?: string };
const router = express.Router();
const inviteLifetimeMs = 7 * 24 * 60 * 60 * 1000;
async function requireUser(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
    if (!session) return res.status(401).json({ success: false, error: { code: "UNAUTHENTICATED", message: "Sign in to continue." } });
    req.userId = session.user.id; next();
  } catch (error) { next(error); }
}
function fail(res: Response, status: number, code: string, message: string) { return res.status(status).json({ success: false, error: { code, message } }); }
function newInviteToken() { const token = randomBytes(32).toString("hex"); return { token, hash: createHash("sha256").update(token).digest("hex") }; }
function inviteUrl(token: string) { return `${(process.env.WEB_ORIGIN ?? "http://localhost:3000").replace(/\/$/, "")}/invite/${token}`; }
async function deliverInvite(email: string, workspaceName: string, role: string, mailboxAddresses: string[], url: string) {
  const mailboxText = role === "member" ? `\n\nMailbox access included: ${mailboxAddresses.length ? mailboxAddresses.join(", ") : "No mailboxes yet; the workspace owner can grant access later."}` : "";
  await sendProductEmail(email, `You're invited to ${workspaceName} on Widesip`, `You have been invited to join ${workspaceName} as a ${role}.${mailboxText}\n\nAccept the invitation: ${url}\n\nThis link expires in 7 days. If you were not expecting this invitation, you can ignore this message.`);
}
async function mailboxAddressesFor(ids: string[]) {
  if (!ids.length) return [];
  return db.select({ id: mailboxes.id, localPart: mailboxes.localPart, domainName: domains.domainName })
    .from(mailboxes).innerJoin(domains, eq(domains.id, mailboxes.domainId)).where(inArray(mailboxes.id, ids));
}
async function managerRole(workspaceId: string, userId: string) {
  const [membership] = await db.select({ role: workspaceMembers.role, type: workspaces.type, ownerUserId: workspaces.ownerUserId }).from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId))).limit(1);
  if (membership?.type !== "organization") return null;
  if (membership.role === "owner" && membership.ownerUserId !== userId) return null;
  return membership?.role ?? null;
}

router.get("/v1/team", requireUser, async (req: AuthedRequest, res, next) => {
  const workspaceId = String(req.query.workspaceId ?? "");
  if (!workspaceId) return fail(res, 400, "WORKSPACE_REQUIRED", "Select a workspace.");
  try {
    const [membership] = await db.select({ role: workspaceMembers.role, type: workspaces.type, ownerUserId: workspaces.ownerUserId })
      .from(workspaceMembers).innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
      .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, req.userId!))).limit(1);
    if (!membership || membership.role === "owner" && membership.ownerUserId !== req.userId) return fail(res, 404, "WORKSPACE_NOT_FOUND", "The workspace could not be found.");
    if (membership.type !== "organization") return fail(res, 403, "TEAM_WORKSPACE_REQUIRED", "Team management is available only in an organization workspace.");
    const role = membership.role;
    if (role === "member") {
      const [self] = await db.select({ userId: users.id, name: users.name, email: users.email, emailVerified: users.emailVerified, role: workspaceMembers.role, joinedAt: workspaceMembers.createdAt })
        .from(workspaceMembers).innerJoin(users, eq(workspaceMembers.userId, users.id))
        .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, req.userId!))).limit(1);
      return res.json({ success: true, data: { members: [{ ...self, mailboxIds: [] }], invitations: [], availableMailboxes: [], currentRole: role, currentUserId: req.userId } });
    }
    const members = await db.select({ userId: users.id, name: users.name, email: users.email, emailVerified: users.emailVerified, role: workspaceMembers.role, joinedAt: workspaceMembers.createdAt }).from(workspaceMembers).innerJoin(users, eq(workspaceMembers.userId, users.id)).where(eq(workspaceMembers.workspaceId, workspaceId)).orderBy(desc(workspaceMembers.createdAt));
    const invitations = ["owner", "admin"].includes(role) ? await db.select({ id: workspaceInvitations.id, email: workspaceInvitations.email, role: workspaceInvitations.role, status: workspaceInvitations.status, mailboxIds: workspaceInvitations.mailboxIds, expiresAt: workspaceInvitations.expiresAt, createdAt: workspaceInvitations.createdAt }).from(workspaceInvitations).where(eq(workspaceInvitations.workspaceId, workspaceId)).orderBy(desc(workspaceInvitations.createdAt)) : [];
    const availableMailboxes = await db.select({ id: mailboxes.id, address: mailboxes.localPart, domainName: domains.domainName }).from(mailboxes).innerJoin(domains, eq(domains.id, mailboxes.domainId)).where(eq(mailboxes.workspaceId, workspaceId)).orderBy(mailboxes.localPart);
    const grants = await db.select({ userId: mailboxAccess.userId, mailboxId: mailboxAccess.mailboxId }).from(mailboxAccess).where(eq(mailboxAccess.workspaceId, workspaceId));
    return res.json({ success: true, data: { members: members.map(member => ({ ...member, mailboxIds: grants.filter(g => g.userId === member.userId).map(g => g.mailboxId) })), invitations, availableMailboxes, currentRole: role, currentUserId: req.userId } });
  } catch (error) { next(error); }
});

router.post("/v1/team/invitations", requireUser, async (req: AuthedRequest, res, next) => {
  const parsed = teamInvitationCreateSchema.safeParse(req.body);
  if (!parsed.success) return fail(res, 400, "INVALID_INVITATION", parsed.error.issues[0]?.message ?? "Check the invitation details.");
  try {
    const role = await managerRole(parsed.data.workspaceId, req.userId!);
    if (!role) return fail(res, 404, "WORKSPACE_NOT_FOUND", "The workspace could not be found.");
    if (!["owner", "admin"].includes(role)) return fail(res, 403, "FORBIDDEN", "Only workspace owners and admins can invite people.");
    if (role === "admin" && parsed.data.role === "admin") return fail(res, 403, "FORBIDDEN", "Only the workspace owner can invite someone as an admin.");
    if (parsed.data.role === "member" && parsed.data.mailboxIds.length === 0) return fail(res, 400, "MAILBOX_REQUIRED", "Assign at least one mailbox to a workspace member.");
    if (parsed.data.role === "member" && parsed.data.mailboxIds.length) {
      const selected = await db.select({ id: mailboxes.id }).from(mailboxes).where(and(eq(mailboxes.workspaceId, parsed.data.workspaceId), inArray(mailboxes.id, parsed.data.mailboxIds)));
      if (selected.length !== new Set(parsed.data.mailboxIds).size) return fail(res, 400, "INVALID_MAILBOX_ACCESS", "Choose only mailboxes that belong to this workspace.");
    }
    const [workspace] = await db.select({ id: workspaces.id, name: workspaces.name, type: workspaces.type }).from(workspaces).where(eq(workspaces.id, parsed.data.workspaceId)).limit(1);
    if (!workspace || workspace.type !== "organization") return fail(res, 403, "PERSONAL_SPACE_PRIVATE", "Personal spaces cannot be shared as team workspaces.");
    const [existingMember] = await db.select({ id: workspaceMembers.id }).from(workspaceMembers).innerJoin(users, eq(workspaceMembers.userId, users.id)).where(and(eq(workspaceMembers.workspaceId, parsed.data.workspaceId), eq(users.email, parsed.data.email))).limit(1);
    if (existingMember) return fail(res, 409, "ALREADY_A_MEMBER", "That person is already in this workspace.");
    const [existingInvite] = await db.select({ id: workspaceInvitations.id, status: workspaceInvitations.status, expiresAt: workspaceInvitations.expiresAt }).from(workspaceInvitations).where(and(eq(workspaceInvitations.workspaceId, parsed.data.workspaceId), eq(workspaceInvitations.email, parsed.data.email))).orderBy(desc(workspaceInvitations.createdAt)).limit(1);
    if (existingInvite?.status === "pending" && existingInvite.expiresAt > new Date()) return fail(res, 409, "INVITE_EXISTS", "There is already an active invitation for this email address.");
    const { token, hash } = newInviteToken();
    const expiresAt = new Date(Date.now() + inviteLifetimeMs);
    const mailboxIds = parsed.data.role === "member" ? [...new Set(parsed.data.mailboxIds)] : [];
    const [created] = await db.insert(workspaceInvitations).values({ workspaceId: parsed.data.workspaceId, invitedByUserId: req.userId!, email: parsed.data.email, role: parsed.data.role, mailboxIds, tokenHash: hash, expiresAt }).returning({ id: workspaceInvitations.id });
    const url = inviteUrl(token);
    let emailSent = false;
    let emailMessage = "Share the invitation link with the teammate.";
    const selectedMailboxes = await mailboxAddressesFor(mailboxIds);
    const selectedAddresses = selectedMailboxes.map(row => `${row.localPart}@${row.domainName}`);
    try { await deliverInvite(parsed.data.email, workspace.name, parsed.data.role, selectedAddresses, url); emailSent = true; emailMessage = "Invitation email sent."; }
    catch (error) { emailMessage = error instanceof Error ? `Invitation saved, but email could not be sent: ${error.message}` : "Invitation saved, but email could not be sent."; }
    return res.status(201).json({ success: true, data: { id: created.id, email: parsed.data.email, role: parsed.data.role, expiresAt, inviteUrl: url, emailSent, message: emailMessage } });
  } catch (error) { next(error); }
});

router.post("/v1/team/invitations/:invitationId/resend", requireUser, async (req: AuthedRequest, res, next) => {
  try {
    const [invitation] = await db.select({ id: workspaceInvitations.id, workspaceId: workspaceInvitations.workspaceId, email: workspaceInvitations.email, role: workspaceInvitations.role, status: workspaceInvitations.status, mailboxIds: workspaceInvitations.mailboxIds }).from(workspaceInvitations).where(eq(workspaceInvitations.id, String(req.params.invitationId))).limit(1);
    if (!invitation) return fail(res, 404, "INVITATION_NOT_FOUND", "The invitation could not be found.");
    const role = await managerRole(invitation.workspaceId, req.userId!);
    if (!role) return fail(res, 404, "INVITATION_NOT_FOUND", "The invitation could not be found.");
    if (!["owner", "admin"].includes(role)) return fail(res, 403, "FORBIDDEN", "Only workspace owners and admins can resend invitations.");
    if (invitation.status !== "pending") return fail(res, 409, "INVITATION_NOT_PENDING", "Only pending invitations can be resent.");
    const [workspace] = await db.select({ name: workspaces.name }).from(workspaces).where(eq(workspaces.id, invitation.workspaceId)).limit(1);
    const { token, hash } = newInviteToken(); const expiresAt = new Date(Date.now() + inviteLifetimeMs);
    await db.update(workspaceInvitations).set({ tokenHash: hash, expiresAt }).where(eq(workspaceInvitations.id, invitation.id));
    const url = inviteUrl(token);
    const selectedMailboxes = await mailboxAddressesFor(invitation.mailboxIds ?? []);
    try { await deliverInvite(invitation.email, workspace.name, invitation.role, selectedMailboxes.map(row => `${row.localPart}@${row.domainName}`), url); }
    catch (error) { return res.status(502).json({ success: false, error: { code: "INVITE_EMAIL_FAILED", message: error instanceof Error ? error.message : "Could not send the invitation email." }, data: { inviteUrl: url, expiresAt } }); }
    return res.json({ success: true, data: { inviteUrl: url, expiresAt, message: "A new invitation link was sent. The previous link has been invalidated." } });
  } catch (error) { next(error); }
});

router.put("/v1/team/invitations/:invitationId/mailboxes", requireUser, async (req: AuthedRequest, res, next) => {
  const parsed = teamMemberMailboxAccessSchema.safeParse(req.body);
  if (!parsed.success) return fail(res, 400, "INVALID_MAILBOX_ACCESS", "Choose valid mailboxes.");
  try {
    const [invitation] = await db.select({ id: workspaceInvitations.id, workspaceId: workspaceInvitations.workspaceId, role: workspaceInvitations.role, status: workspaceInvitations.status })
      .from(workspaceInvitations).where(eq(workspaceInvitations.id, String(req.params.invitationId))).limit(1);
    if (!invitation) return fail(res, 404, "INVITATION_NOT_FOUND", "The invitation could not be found.");
    const actorRole = await managerRole(invitation.workspaceId, req.userId!);
    if (!actorRole) return fail(res, 404, "INVITATION_NOT_FOUND", "The invitation could not be found.");
    if (!["owner", "admin"].includes(actorRole)) return fail(res, 403, "FORBIDDEN", "Only workspace owners and admins can edit invitation access.");
    if (invitation.status !== "pending") return fail(res, 409, "INVITATION_NOT_PENDING", "Only pending invitations can be edited.");
    if (invitation.role !== "member") return fail(res, 409, "ROLE_HAS_FULL_ACCESS", "Admin invitations have workspace-wide access and do not use mailbox assignments.");
    const mailboxIds = [...new Set(parsed.data.mailboxIds)];
    if (!mailboxIds.length) return fail(res, 400, "MAILBOX_REQUIRED", "Assign at least one mailbox to a workspace member.");
    const selected = await db.select({ id: mailboxes.id }).from(mailboxes)
      .where(and(eq(mailboxes.workspaceId, invitation.workspaceId), inArray(mailboxes.id, mailboxIds)));
    if (selected.length !== mailboxIds.length) return fail(res, 400, "INVALID_MAILBOX_ACCESS", "Choose only mailboxes that belong to this workspace.");
    await db.update(workspaceInvitations).set({ mailboxIds }).where(eq(workspaceInvitations.id, invitation.id));
    return res.json({ success: true, data: { mailboxIds, message: "Invitation mailbox access updated. The new assignments will apply when they accept." } });
  } catch (error) { next(error); }
});

router.delete("/v1/team/invitations/:invitationId", requireUser, async (req: AuthedRequest, res, next) => {
  try {
    const [invitation] = await db.select({ id: workspaceInvitations.id, workspaceId: workspaceInvitations.workspaceId, status: workspaceInvitations.status }).from(workspaceInvitations).where(eq(workspaceInvitations.id, String(req.params.invitationId))).limit(1);
    if (!invitation) return fail(res, 404, "INVITATION_NOT_FOUND", "The invitation could not be found.");
    const actorRole = await managerRole(invitation.workspaceId, req.userId!);
    if (!actorRole) return fail(res, 404, "INVITATION_NOT_FOUND", "The invitation could not be found.");
    if (!["owner", "admin"].includes(actorRole)) return fail(res, 403, "FORBIDDEN", "Only workspace owners and admins can revoke invitations.");
    if (invitation.status !== "pending") return fail(res, 409, "INVITATION_NOT_PENDING", "Only pending invitations can be revoked.");
    await db.update(workspaceInvitations).set({ status: "revoked" }).where(eq(workspaceInvitations.id, invitation.id));
    return res.json({ success: true });
  } catch (error) { next(error); }
});

router.patch("/v1/team/members/:memberUserId", requireUser, async (req: AuthedRequest, res, next) => {
  const parsed = teamMemberRoleSchema.safeParse(req.body);
  if (!parsed.success) return fail(res, 400, "INVALID_ROLE", "Choose Admin or Member.");
  const workspaceId = String(req.query.workspaceId ?? "");
  if (!workspaceId) return fail(res, 400, "WORKSPACE_REQUIRED", "Select a workspace.");
  try {
    const actorRole = await managerRole(workspaceId, req.userId!);
    if (!actorRole) return fail(res, 404, "WORKSPACE_NOT_FOUND", "The workspace could not be found.");
    if (!["owner", "admin"].includes(actorRole)) return fail(res, 403, "FORBIDDEN", "Only workspace owners and admins can change roles.");
    const [target] = await db.select({ id: workspaceMembers.id, role: workspaceMembers.role }).from(workspaceMembers).where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, String(req.params.memberUserId)))).limit(1);
    if (!target) return fail(res, 404, "MEMBER_NOT_FOUND", "The workspace member could not be found.");
    if (target.role === "owner") return fail(res, 409, "OWNER_PROTECTED", "The workspace owner role cannot be changed here.");
    if (actorRole === "admin" && target.role !== "member") return fail(res, 403, "FORBIDDEN", "Admins can only manage members, not other administrators.");
    if (actorRole === "admin" && parsed.data.role !== "member") return fail(res, 403, "FORBIDDEN", "Only the workspace owner can promote someone to admin.");
    const [updated] = await db.update(workspaceMembers).set({ role: parsed.data.role }).where(eq(workspaceMembers.id, target.id)).returning({ userId: workspaceMembers.userId, role: workspaceMembers.role });
    await db.delete(mailboxAccess).where(and(eq(mailboxAccess.workspaceId, workspaceId), eq(mailboxAccess.userId, String(req.params.memberUserId))));
    return res.json({ success: true, data: updated });
  } catch (error) { next(error); }
});
router.post("/v1/team/transfer-ownership", requireUser, async (req: AuthedRequest, res, next) => {
  const workspaceId = typeof req.body?.workspaceId === "string" ? req.body.workspaceId : "";
  const newOwnerId = typeof req.body?.userId === "string" ? req.body.userId : "";
  if (!workspaceId || !newOwnerId) return fail(res, 400, "INVALID_TRANSFER", "Choose a workspace member to receive ownership.");
  try {
    const role = await managerRole(workspaceId, req.userId!);
    if (!role) return fail(res, 404, "WORKSPACE_NOT_FOUND", "The workspace could not be found.");
    if (role !== "owner") return fail(res, 403, "FORBIDDEN", "Only the current workspace owner can transfer ownership.");
    if (newOwnerId === req.userId) return fail(res, 400, "INVALID_TRANSFER", "Choose another member as the new owner.");
    const [target] = await db.select({ id: workspaceMembers.id, role: workspaceMembers.role }).from(workspaceMembers)
      .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, newOwnerId))).limit(1);
    if (!target) return fail(res, 404, "MEMBER_NOT_FOUND", "The new owner must already belong to this workspace.");
    await db.transaction(async tx => {
      await tx.update(workspaceMembers).set({ role: "admin" }).where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, req.userId!)));
      await tx.update(workspaceMembers).set({ role: "owner" }).where(eq(workspaceMembers.id, target.id));
      await tx.update(workspaces).set({ ownerUserId: newOwnerId, updatedAt: new Date() }).where(eq(workspaces.id, workspaceId));
    });
    return res.json({ success: true, data: { userId: newOwnerId, role: "owner", message: "Workspace ownership transferred. You are now an admin." } });
  } catch (error) { next(error); }
});
router.delete("/v1/team/members/:memberUserId", requireUser, async (req: AuthedRequest, res, next) => {
  const workspaceId = String(req.query.workspaceId ?? "");
  if (!workspaceId) return fail(res, 400, "WORKSPACE_REQUIRED", "Select a workspace.");
  try {
    const actorRole = await managerRole(workspaceId, req.userId!);
    if (!actorRole) return fail(res, 404, "WORKSPACE_NOT_FOUND", "The workspace could not be found.");
    if (!["owner", "admin"].includes(actorRole)) return fail(res, 403, "FORBIDDEN", "Only workspace owners and admins can remove members.");
    const [target] = await db.select({ id: workspaceMembers.id, role: workspaceMembers.role }).from(workspaceMembers).where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, String(req.params.memberUserId)))).limit(1);
    if (!target) return fail(res, 404, "MEMBER_NOT_FOUND", "The workspace member could not be found.");
    if (target.role === "owner") return fail(res, 409, "OWNER_PROTECTED", "The workspace owner cannot be removed.");
    if (actorRole === "admin" && target.role !== "member") return fail(res, 403, "FORBIDDEN", "Admins can only remove members, not other administrators.");
    await db.transaction(async tx => {
      await tx.delete(mailboxAccess).where(and(eq(mailboxAccess.workspaceId, workspaceId), eq(mailboxAccess.userId, String(req.params.memberUserId))));
      await tx.delete(workspaceMembers).where(eq(workspaceMembers.id, target.id));
    });
    return res.json({ success: true });
  } catch (error) { next(error); }
});

router.put("/v1/team/members/:memberUserId/mailboxes", requireUser, async (req: AuthedRequest, res, next) => {
  const parsed = teamMemberMailboxAccessSchema.safeParse(req.body);
  if (!parsed.success) return fail(res, 400, "INVALID_MAILBOX_ACCESS", "Choose valid mailboxes.");
  const workspaceId = String(req.query.workspaceId ?? "");
  if (!workspaceId) return fail(res, 400, "WORKSPACE_REQUIRED", "Select a workspace.");
  try {
    const actorRole = await managerRole(workspaceId, req.userId!);
    if (!actorRole) return fail(res, 404, "WORKSPACE_NOT_FOUND", "The workspace could not be found.");
    if (!["owner", "admin"].includes(actorRole)) return fail(res, 403, "FORBIDDEN", "Only workspace owners and admins can assign mailboxes.");
    const [target] = await db.select({ role: workspaceMembers.role }).from(workspaceMembers)
      .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, String(req.params.memberUserId)))).limit(1);
    if (!target || target.role !== "member") return fail(res, 404, "MEMBER_NOT_FOUND", "Choose a workspace member account.");
    const ids = [...new Set(parsed.data.mailboxIds)];
    const selected = ids.length ? await db.select({ id: mailboxes.id }).from(mailboxes).where(and(eq(mailboxes.workspaceId, workspaceId), inArray(mailboxes.id, ids))) : [];
    if (selected.length !== ids.length) return fail(res, 400, "INVALID_MAILBOX_ACCESS", "Choose only mailboxes that belong to this workspace.");
    await db.transaction(async tx => {
      await tx.delete(mailboxAccess).where(and(eq(mailboxAccess.workspaceId, workspaceId), eq(mailboxAccess.userId, String(req.params.memberUserId))));
      if (ids.length) await tx.insert(mailboxAccess).values(ids.map(mailboxId => ({ workspaceId, mailboxId, userId: String(req.params.memberUserId), grantedByUserId: req.userId! })));
    });
    return res.json({ success: true, data: { mailboxIds: ids, message: "Mailbox access updated." } });
  } catch (error) { next(error); }
});

router.get("/v1/my/invitations", requireUser, async (req: AuthedRequest, res, next) => {
  try {
    const [person] = await db.select({ email: users.email }).from(users).where(eq(users.id, req.userId!)).limit(1);
    if (!person) return fail(res, 404, "USER_NOT_FOUND", "Your account could not be found.");
    const invitations = await db.select({ id: workspaceInvitations.id, email: workspaceInvitations.email, role: workspaceInvitations.role, status: workspaceInvitations.status, expiresAt: workspaceInvitations.expiresAt, createdAt: workspaceInvitations.createdAt, workspaceId: workspaceInvitations.workspaceId, workspaceName: workspaces.name })
      .from(workspaceInvitations).innerJoin(workspaces, eq(workspaces.id, workspaceInvitations.workspaceId))
      .where(and(ilike(workspaceInvitations.email, person.email), eq(workspaces.type, "organization"), eq(workspaceInvitations.status, "pending"), gt(workspaceInvitations.expiresAt, new Date())))
      .orderBy(desc(workspaceInvitations.createdAt));
    return res.json({ success: true, data: invitations });
  } catch (error) { next(error); }
});

router.post("/v1/my/invitations/:invitationId/accept", requireUser, async (req: AuthedRequest, res, next) => {
  try {
    const [person] = await db.select({ id: users.id, email: users.email, emailVerified: users.emailVerified, onboardingComplete: users.onboardingComplete }).from(users).where(eq(users.id, req.userId!)).limit(1);
    if (!person || !person.emailVerified) return fail(res, 403, "EMAIL_NOT_VERIFIED", "Verify your account email before joining a workspace.");
    if (!person.onboardingComplete) return fail(res, 403, "ONBOARDING_REQUIRED", "Finish setting up your personal account before accepting this invitation.");
    const result = await db.transaction(async tx => {
      const [invitation] = await tx.select().from(workspaceInvitations).where(and(eq(workspaceInvitations.id, String(req.params.invitationId)), eq(workspaceInvitations.status, "pending"), gt(workspaceInvitations.expiresAt, new Date()))).limit(1);
      if (!invitation) return { error: "INVITATION_INVALID" as const };
      const [workspace] = await tx.select({ type: workspaces.type }).from(workspaces).where(eq(workspaces.id, invitation.workspaceId)).limit(1);
      if (workspace?.type !== "organization") return { error: "PERSONAL_SPACE_PRIVATE" as const };
      if (person.email.toLowerCase() !== invitation.email.toLowerCase()) return { error: "EMAIL_MISMATCH" as const };
      const [existing] = await tx.select({ id: workspaceMembers.id }).from(workspaceMembers).where(and(eq(workspaceMembers.workspaceId, invitation.workspaceId), eq(workspaceMembers.userId, person.id))).limit(1);
      if (!existing) await tx.insert(workspaceMembers).values({ workspaceId: invitation.workspaceId, userId: person.id, role: invitation.role });
      if (invitation.role === "member" && invitation.mailboxIds?.length) {
        const valid = await tx.select({ id: mailboxes.id }).from(mailboxes).where(and(eq(mailboxes.workspaceId, invitation.workspaceId), inArray(mailboxes.id, invitation.mailboxIds)));
        for (const mailbox of valid) await tx.insert(mailboxAccess).values({ workspaceId: invitation.workspaceId, mailboxId: mailbox.id, userId: person.id, grantedByUserId: invitation.invitedByUserId }).onConflictDoNothing();
      }
      await tx.update(workspaceInvitations).set({ status: "accepted", acceptedAt: new Date() }).where(eq(workspaceInvitations.id, invitation.id));
      return { workspaceId: invitation.workspaceId };
    });
    if ("error" in result) { const code = result.error ?? "INVITATION_INVALID"; const forbidden = code === "EMAIL_MISMATCH" || code === "PERSONAL_SPACE_PRIVATE"; return fail(res, forbidden ? 403 : 404, code, code === "EMAIL_MISMATCH" ? "Sign in with the invited email address to accept this invitation." : code === "PERSONAL_SPACE_PRIVATE" ? "Personal workspaces cannot be joined by another account." : "This invitation is invalid or expired."); }
    return res.json({ success: true, data: { workspaceId: result.workspaceId, message: "You joined the workspace." } });
  } catch (error) { next(error); }
});

router.get("/v1/invitations/:token", async (req, res, next) => {
  try {
    const hash = createHash("sha256").update(String(req.params.token)).digest("hex");
    const [row] = await db.select({ id: workspaceInvitations.id, email: workspaceInvitations.email, role: workspaceInvitations.role, status: workspaceInvitations.status, expiresAt: workspaceInvitations.expiresAt, workspaceName: workspaces.name, workspaceType: workspaces.type }).from(workspaceInvitations).innerJoin(workspaces, eq(workspaceInvitations.workspaceId, workspaces.id)).where(eq(workspaceInvitations.tokenHash, hash)).limit(1);
    if (!row || row.workspaceType !== "organization" || row.status !== "pending" || row.expiresAt <= new Date()) return fail(res, 404, "INVITATION_INVALID", "This invitation link is invalid, expired, or has already been used.");
    return res.json({ success: true, data: { email: row.email, role: row.role, workspaceName: row.workspaceName, expiresAt: row.expiresAt } });
  } catch (error) { next(error); }
});
router.post("/v1/invitations/:token/accept", requireUser, async (req: AuthedRequest, res, next) => {
  try {
    const hash = createHash("sha256").update(String(req.params.token)).digest("hex");
    const [person] = await db.select({ id: users.id, email: users.email, emailVerified: users.emailVerified, onboardingComplete: users.onboardingComplete }).from(users).where(eq(users.id, req.userId!)).limit(1);
    if (!person || !person.emailVerified) return fail(res, 403, "EMAIL_NOT_VERIFIED", "Verify the invited email address before joining the workspace.");
    if (!person.onboardingComplete) return fail(res, 403, "ONBOARDING_REQUIRED", "Finish setting up your personal account before accepting this invitation.");
    const result = await db.transaction(async tx => {
      const [invitation] = await tx.select().from(workspaceInvitations).where(and(eq(workspaceInvitations.tokenHash, hash), eq(workspaceInvitations.status, "pending"), gt(workspaceInvitations.expiresAt, new Date()))).limit(1);
      if (!invitation) return { error: "INVITATION_INVALID" as const };
      const [workspace] = await tx.select({ type: workspaces.type }).from(workspaces).where(eq(workspaces.id, invitation.workspaceId)).limit(1);
      if (workspace?.type !== "organization") return { error: "PERSONAL_SPACE_PRIVATE" as const };
      if (person.email.toLowerCase() !== invitation.email.toLowerCase()) return { error: "EMAIL_MISMATCH" as const };
      const [existing] = await tx.select({ id: workspaceMembers.id }).from(workspaceMembers).where(and(eq(workspaceMembers.workspaceId, invitation.workspaceId), eq(workspaceMembers.userId, person.id))).limit(1);
      if (!existing) await tx.insert(workspaceMembers).values({ workspaceId: invitation.workspaceId, userId: person.id, role: invitation.role });
      if (invitation.role === "member" && invitation.mailboxIds?.length) {
        const valid = await tx.select({ id: mailboxes.id }).from(mailboxes).where(and(eq(mailboxes.workspaceId, invitation.workspaceId), inArray(mailboxes.id, invitation.mailboxIds)));
        for (const mailbox of valid) await tx.insert(mailboxAccess).values({ workspaceId: invitation.workspaceId, mailboxId: mailbox.id, userId: person.id, grantedByUserId: invitation.invitedByUserId }).onConflictDoNothing();
      }
      await tx.update(workspaceInvitations).set({ status: "accepted", acceptedAt: new Date() }).where(eq(workspaceInvitations.id, invitation.id));
      return { workspaceId: invitation.workspaceId };
    });
    if ("error" in result) { const code = result.error ?? "INVITATION_INVALID"; const forbidden = code === "EMAIL_MISMATCH" || code === "PERSONAL_SPACE_PRIVATE"; return fail(res, forbidden ? 403 : 404, code, code === "EMAIL_MISMATCH" ? "Sign in with the invited email address to accept this invitation." : code === "PERSONAL_SPACE_PRIVATE" ? "Personal workspaces cannot be joined by another account." : "This invitation is invalid or expired."); }
    return res.json({ success: true, data: { workspaceId: result.workspaceId, message: "You joined the workspace." } });
  } catch (error) { next(error); }
});

export const teamRouter = router;
