import { bigint, boolean, date, index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { jsonb } from "drizzle-orm/pg-core";

export const users = pgTable("user", {
  id: text("id").primaryKey(), name: text("name").notNull(), email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false), image: text("image"),
  accountType: text("account_type", { enum: ["personal", "organization"] }).notNull().default("personal"),
  dateOfBirth: date("date_of_birth", { mode: "string" }), organizationName: text("organization_name"), onboardingComplete: boolean("onboarding_complete").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(), updatedAt: timestamp("updated_at").notNull().defaultNow(),
});
export const sessions = pgTable("session", {
  id: text("id").primaryKey(), expiresAt: timestamp("expires_at").notNull(), token: text("token").notNull().unique(),
  createdAt: timestamp("created_at").notNull().defaultNow(), updatedAt: timestamp("updated_at").notNull().defaultNow(),
  ipAddress: text("ip_address"), userAgent: text("user_agent"), userId: text("user_id").notNull().references(()=>users.id,{onDelete:"cascade"}),
});
export const accounts = pgTable("account", {
  id: text("id").primaryKey(), accountId: text("account_id").notNull(), providerId: text("provider_id").notNull(),
  userId: text("user_id").notNull().references(()=>users.id,{onDelete:"cascade"}), accessToken: text("access_token"), refreshToken: text("refresh_token"),
  idToken: text("id_token"), accessTokenExpiresAt: timestamp("access_token_expires_at"), refreshTokenExpiresAt: timestamp("refresh_token_expires_at"),
  scope: text("scope"), password: text("password"), createdAt: timestamp("created_at").notNull().defaultNow(), updatedAt: timestamp("updated_at").notNull().defaultNow(),
});
export const verifications = pgTable("verification", {
  id: text("id").primaryKey(), identifier: text("identifier").notNull(), value: text("value").notNull(), expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").defaultNow(), updatedAt: timestamp("updated_at").defaultNow(),
});
export const rateLimits = pgTable("rate_limit", {
  // Better Auth generates opaque string IDs for database-backed rate limits.
  id: text("id").primaryKey(),
  key: text("key").notNull().unique(),
  count: integer("count").notNull(),
  lastRequest: bigint("last_request", { mode: "number" }).notNull(),
});
export const loginAttemptLocks = pgTable("login_attempt_locks", {
  emailHash: text("email_hash").primaryKey(),
  failedAttempts: integer("failed_attempts").notNull().default(0),
  lockedUntil: timestamp("locked_until"),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});
export const workspaces = pgTable("workspaces", {
  id: uuid("id").defaultRandom().primaryKey(), name: text("name").notNull(), type: text("type",{enum:["personal","organization"]}).notNull(),
  ownerUserId: text("owner_user_id").notNull().references(()=>users.id), createdAt: timestamp("created_at").notNull().defaultNow(), updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, t=>[index("workspaces_owner_created_idx").on(t.ownerUserId,t.createdAt)]);
export const workspaceMembers = pgTable("workspace_members", {
  id: uuid("id").defaultRandom().primaryKey(), workspaceId: uuid("workspace_id").notNull().references(()=>workspaces.id,{onDelete:"cascade"}),
  userId: text("user_id").notNull().references(()=>users.id,{onDelete:"cascade"}), role: text("role",{enum:["owner","admin","member"]}).notNull().default("member"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
},t=>[uniqueIndex("workspace_members_unique").on(t.workspaceId,t.userId),index("workspace_members_user_idx").on(t.userId)]);
export const workspaceInvitations = pgTable("workspace_invitations", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  invitedByUserId: text("invited_by_user_id").notNull().references(() => users.id),
  email: text("email").notNull(),
  role: text("role", { enum: ["admin", "member"] }).notNull().default("member"),
  mailboxIds: jsonb("mailbox_ids").$type<string[]>().notNull().default([]),
  tokenHash: text("token_hash").notNull().unique(),
  status: text("status", { enum: ["pending", "accepted", "revoked", "expired"] }).notNull().default("pending"),
  expiresAt: timestamp("expires_at").notNull(),
  acceptedAt: timestamp("accepted_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, t => [
  index("workspace_invitations_workspace_status_idx").on(t.workspaceId, t.status),
  index("workspace_invitations_email_idx").on(t.email),
]);
export const contacts = pgTable("contacts", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  email: text("email").notNull(),
  firstName: text("first_name"),
  lastName: text("last_name"),
  company: text("company"),
  consentStatus: text("consent_status", { enum: ["unknown", "subscribed", "unsubscribed"] }).notNull().default("unknown"),
  consentSource: text("consent_source"),
  consentAt: timestamp("consent_at"),
  unsubscribedAt: timestamp("unsubscribed_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, t => [
  uniqueIndex("contacts_workspace_email_unique").on(t.workspaceId, t.email),
  index("contacts_workspace_created_idx").on(t.workspaceId, t.createdAt),
]);
export const workspaceSubscriptionLinks = pgTable("workspace_subscription_links", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().unique().references(() => workspaces.id, { onDelete: "cascade" }),
  token: text("token").notNull().unique(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, t => [index("workspace_subscription_links_workspace_idx").on(t.workspaceId)]);
export const domains = pgTable("domains", {
  id: uuid("id").defaultRandom().primaryKey(), workspaceId: uuid("workspace_id").notNull().references(()=>workspaces.id,{onDelete:"cascade"}),
  domainName: text("domain_name").notNull(), verificationStatus: text("verification_status",{enum:["pending","verified","failed"]}).notNull().default("pending"),
  mailStatus: text("mail_status",{enum:["not_configured","pending","active","conflict"]}).notNull().default("not_configured"),
  receivingEnabled: boolean("receiving_enabled").notNull().default(false),
  // Provider-neutral references let Widesip change delivery vendors without
  // changing a customer's domain or mailbox records.
  sendingProvider: text("sending_provider"),
  sendingProviderDomainId: text("sending_provider_domain_id"),
  // Retained while existing local installations migrate to the generic fields.
  resendDomainId: text("resend_domain_id"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
},t=>[uniqueIndex("domains_workspace_name_unique").on(t.workspaceId,t.domainName),index("domains_workspace_created_idx").on(t.workspaceId,t.createdAt)]);
export const domainEmailTemplates = pgTable("domain_email_templates", {
  id: uuid("id").defaultRandom().primaryKey(),
  domainId: uuid("domain_id").notNull().unique().references(() => domains.id, { onDelete: "cascade" }),
  brandName: text("brand_name").notNull().default(""),
  logoUrl: text("logo_url"),
  logoImageData: text("logo_image_data"),
  logoMimeType: text("logo_mime_type"),
  accentColor: text("accent_color").notNull().default("#4165e8"),
  footerText: text("footer_text").notNull().default(""),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});
export const domainVerifications = pgTable("domain_verifications", {
  id: uuid("id").defaultRandom().primaryKey(), workspaceId: uuid("workspace_id").notNull().references(()=>workspaces.id,{onDelete:"cascade"}),
  domainId: uuid("domain_id").notNull().references(()=>domains.id,{onDelete:"cascade"}), tokenHash: text("token_hash").notNull(),
  expiresAt: timestamp("expires_at").notNull(), verifiedAt: timestamp("verified_at"), createdAt: timestamp("created_at").notNull().defaultNow(),
},t=>[uniqueIndex("domain_verifications_domain_unique").on(t.domainId),index("domain_verifications_workspace_idx").on(t.workspaceId)]);

// Addresses are stored separately from delivery configuration. A mailbox is only
// marked active after DNS/provider setup has actually been completed.
export const mailboxes = pgTable("mailboxes", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  domainId: uuid("domain_id").notNull().references(() => domains.id, { onDelete: "cascade" }),
  localPart: text("local_part").notNull(),
  displayName: text("display_name").notNull(),
  profileImage: text("profile_image"),
  forwardingAddress: text("forwarding_address"),
  status: text("status", { enum: ["pending", "active", "paused"] }).notNull().default("pending"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, t => [
  uniqueIndex("mailboxes_domain_local_part_unique").on(t.domainId, t.localPart),
  index("mailboxes_workspace_created_idx").on(t.workspaceId, t.createdAt),
]);

export const mailboxAccess = pgTable("mailbox_access", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  mailboxId: uuid("mailbox_id").notNull().references(() => mailboxes.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  grantedByUserId: text("granted_by_user_id").notNull().references(() => users.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, t => [uniqueIndex("mailbox_access_mailbox_user_unique").on(t.mailboxId, t.userId), index("mailbox_access_user_idx").on(t.userId)]);

export const campaigns = pgTable("campaigns", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  mailboxId: uuid("mailbox_id").notNull().references(() => mailboxes.id, { onDelete: "cascade" }),
  createdByUserId: text("created_by_user_id").notNull().references(() => users.id),
  name: text("name").notNull(),
  subject: text("subject").notNull(),
  body: text("body").notNull(),
  audienceMode: text("audience_mode", { enum: ["all_opted_in", "selected"] }).notNull().default("all_opted_in"),
  audienceContactIds: jsonb("audience_contact_ids").$type<string[]>().notNull().default([]),
  manualRecipients: jsonb("manual_recipients").$type<Array<{ email: string; name: string }>>().notNull().default([]),
  manualConsentConfirmed: boolean("manual_consent_confirmed").notNull().default(false),
  attachments: jsonb("attachments").$type<Array<{ filename: string; contentType: string; content: string }>>().notNull().default([]),
  status: text("status", { enum: ["draft", "scheduled", "sending", "sent", "partial", "failed", "canceled"] }).notNull().default("draft"),
  recipientCount: integer("recipient_count").notNull().default(0),
  scheduledAt: timestamp("scheduled_at"),
  sentAt: timestamp("sent_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, t => [index("campaigns_workspace_created_idx").on(t.workspaceId, t.createdAt)]);
export const campaignRecipients = pgTable("campaign_recipients", {
  id: uuid("id").defaultRandom().primaryKey(),
  campaignId: uuid("campaign_id").notNull().references(() => campaigns.id, { onDelete: "cascade" }),
  contactId: uuid("contact_id").references(() => contacts.id),
  email: text("email").notNull(),
  recipientName: text("recipient_name"),
  consentSource: text("consent_source"),
  consentAt: timestamp("consent_at"),
  status: text("status", { enum: ["queued", "scheduled", "sent", "delivered", "delivery_delayed", "bounced", "complained", "suppressed", "unsubscribed", "failed", "canceled"] }).notNull().default("queued"),
  providerMessageId: text("provider_message_id"),
  error: text("error"),
  sentAt: timestamp("sent_at"),
  deliveredAt: timestamp("delivered_at"),
  bouncedAt: timestamp("bounced_at"),
  complainedAt: timestamp("complained_at"),
  lastEventAt: timestamp("last_event_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, t => [
  uniqueIndex("campaign_recipients_campaign_contact_unique").on(t.campaignId, t.contactId),
  index("campaign_recipients_campaign_status_idx").on(t.campaignId, t.status),
  index("campaign_recipients_provider_message_idx").on(t.providerMessageId),
]);
export const campaignTemplates = pgTable("campaign_templates", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  createdByUserId: text("created_by_user_id").notNull().references(() => users.id),
  name: text("name").notNull(),
  subject: text("subject").notNull(),
  body: text("body").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, t => [
  uniqueIndex("campaign_templates_workspace_name_unique").on(t.workspaceId, t.name),
  index("campaign_templates_workspace_created_idx").on(t.workspaceId, t.createdAt),
]);

// An alias is an alternate recipient address that delivers into a mailbox;
// it does not create a second mailbox or inbox.
export const emailAliases = pgTable("email_aliases", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  domainId: uuid("domain_id").notNull().references(() => domains.id, { onDelete: "cascade" }),
  mailboxId: uuid("mailbox_id").notNull().references(() => mailboxes.id, { onDelete: "cascade" }),
  localPart: text("local_part").notNull(),
  status: text("status", { enum: ["active", "paused"] }).notNull().default("active"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, t => [
  uniqueIndex("email_aliases_domain_local_part_unique").on(t.domainId, t.localPart),
  index("email_aliases_workspace_created_idx").on(t.workspaceId, t.createdAt),
  index("email_aliases_mailbox_idx").on(t.mailboxId),
]);

// Inbound messages belong to the addressed Widesip mailbox. Provider IDs make
// webhook retries idempotent while keeping the message store provider-neutral.
export const messages = pgTable("messages", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  mailboxId: uuid("mailbox_id").notNull().references(() => mailboxes.id, { onDelete: "cascade" }),
  direction: text("direction", { enum: ["inbound", "outbound"] }).notNull().default("inbound"),
  provider: text("provider").notNull(),
  providerMessageId: text("provider_message_id").notNull(),
  rfcMessageId: text("rfc_message_id"),
  inReplyToMessageId: text("in_reply_to_message_id"),
  fromAddress: text("from_address").notNull(),
  toAddresses: jsonb("to_addresses").$type<string[]>().notNull().default([]),
  ccAddresses: jsonb("cc_addresses").$type<string[]>().notNull().default([]),
  subject: text("subject").notNull().default("(no subject)"),
  textBody: text("text_body"),
  htmlBody: text("html_body"),
  category: text("category", { enum: ["people", "updates", "promotions"] }).notNull().default("people"),
  isRead: boolean("is_read").notNull().default(false),
  isArchived: boolean("is_archived").notNull().default(false),
  receivedAt: timestamp("received_at").notNull().defaultNow(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, t => [
  uniqueIndex("messages_provider_mailbox_unique").on(t.provider, t.providerMessageId, t.mailboxId),
  index("messages_mailbox_received_idx").on(t.mailboxId, t.receivedAt),
  index("messages_workspace_received_idx").on(t.workspaceId, t.receivedAt),
]);

// A user's category correction teaches Widesip how to classify future mail
// from this sender in this mailbox. It is scoped to the workspace and mailbox.
export const messageCategoryRules = pgTable("message_category_rules", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  mailboxId: uuid("mailbox_id").notNull().references(() => mailboxes.id, { onDelete: "cascade" }),
  senderAddress: text("sender_address").notNull(),
  category: text("category", { enum: ["people", "updates", "promotions"] }).notNull(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, t => [
  uniqueIndex("message_category_rules_sender_unique").on(t.workspaceId, t.mailboxId, t.senderAddress),
  index("message_category_rules_mailbox_idx").on(t.mailboxId),
]);

// Optional workspace-managed sender details. Email providers do not expose a
// sender's private Google profile photo to Widesip, so this is a local photo.
export const messageSenderProfiles = pgTable("message_sender_profiles", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  senderAddress: text("sender_address").notNull(),
  displayName: text("display_name"),
  profileImage: text("profile_image"),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, t => [
  uniqueIndex("message_sender_profiles_sender_unique").on(t.workspaceId, t.senderAddress),
  index("message_sender_profiles_workspace_idx").on(t.workspaceId),
]);
