import { z } from "zod";
export const workspaceCreateSchema=z.object({name:z.string().trim().min(2).max(80),type:z.enum(["personal","organization"])});
export const domainCreateSchema=z.object({workspaceId:z.string().uuid(),domainName:z.string().trim().toLowerCase().max(253).regex(/^(?=.{1,253}$)(?!-)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i,"Enter a valid domain such as example.com.")});
export const mailboxCreateSchema=z.object({workspaceId:z.string().uuid(),domainId:z.string().uuid(),localPart:z.string().trim().toLowerCase().min(1).max(64).regex(/^[a-z0-9](?:[a-z0-9._+-]*[a-z0-9])?$/,"Use letters, numbers, dots, plus signs, underscores or hyphens."),displayName:z.string().trim().min(1).max(80),forwardingAddress:z.union([z.string().trim().email().max(254),z.literal("")]).optional()});
export const aliasCreateSchema=z.object({workspaceId:z.string().uuid(),domainId:z.string().uuid(),mailboxId:z.string().uuid(),localPart:z.string().trim().toLowerCase().min(1).max(64).regex(/^[a-z0-9](?:[a-z0-9._+-]*[a-z0-9])?$/,"Use letters, numbers, dots, plus signs, underscores or hyphens.")});
export const contactCreateSchema=z.object({
  workspaceId:z.string().uuid(),
  email:z.string().trim().toLowerCase().email().max(254),
  firstName:z.string().trim().max(100).optional().default(""),
  lastName:z.string().trim().max(100).optional().default(""),
  company:z.string().trim().max(160).optional().default(""),
  consentStatus:z.enum(["unknown","subscribed"]).default("unknown"),
  consentSource:z.string().trim().max(120).optional(),
}).superRefine((value,ctx)=>{
  if(value.consentStatus==="subscribed"&&!value.consentSource)ctx.addIssue({code:"custom",path:["consentSource"],message:"Record how the contact agreed to receive email."});
});
export const contactUpdateSchema=z.object({
  email:z.string().trim().toLowerCase().email().max(254).optional(),
  firstName:z.string().trim().max(100).optional(),
  lastName:z.string().trim().max(100).optional(),
  company:z.string().trim().max(160).optional(),
}).refine((value)=>Object.keys(value).length>0,"Provide at least one contact detail to update.");
const mailAttachmentSchema=z.object({filename:z.string().trim().min(1).max(180),contentType:z.string().trim().min(1).max(120),content:z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/).max(9_000_000)});
const campaignRecipientSchema=z.object({email:z.string().trim().toLowerCase().email().max(254),name:z.string().trim().max(120).default("")});
export const campaignCreateSchema=z.object({
  workspaceId:z.string().uuid(),
  mailboxId:z.string().uuid(),
  name:z.string().trim().min(1).max(120),
  subject:z.string().trim().min(1).max(200),
  body:z.string().trim().min(1).max(100000),
  audienceMode:z.enum(["all_opted_in","selected"]).default("all_opted_in"),
  audienceContactIds:z.array(z.string().uuid()).max(100).default([]),
  manualRecipients:z.array(campaignRecipientSchema).max(100).default([]),
  manualConsentConfirmed:z.boolean().default(false),
  attachments:z.array(mailAttachmentSchema).max(8).default([]),
  scheduledAt:z.union([z.string().datetime(),z.literal("")]).optional().nullable(),
});
export const campaignUpdateSchema=campaignCreateSchema.omit({workspaceId:true}).extend({scheduledAt:z.union([z.string().datetime(),z.literal("")]).optional().nullable()});
export const campaignTemplateCreateSchema=z.object({workspaceId:z.string().uuid(),name:z.string().trim().min(1).max(120),subject:z.string().trim().min(1).max(200),body:z.string().trim().min(1).max(100000)});
export const teamInvitationCreateSchema=z.object({workspaceId:z.string().uuid(),email:z.string().trim().toLowerCase().email().max(254),role:z.enum(["admin","member"]).default("member"),mailboxIds:z.array(z.string().uuid()).max(100).default([])});
export const teamMemberRoleSchema=z.object({role:z.enum(["admin","member"])});
export const teamMemberMailboxAccessSchema=z.object({mailboxIds:z.array(z.string().uuid()).max(100)});
export const sendTestEmailSchema=z.object({recipient:z.string().trim().email().max(254)});
export const composeEmailSchema=z.object({
  recipient:z.string().trim().email().max(254).optional(),
  subject:z.string().trim().min(1).max(200).optional(),
  text:z.string().trim().min(1).max(100000),
  attachments:z.array(mailAttachmentSchema).max(8).default([]),
  replyToMessageId:z.string().uuid().optional(),
}).superRefine((value,ctx)=>{
  if(!value.replyToMessageId&&!value.recipient)ctx.addIssue({code:"custom",path:["recipient"],message:"Enter a recipient email address."});
  if(!value.replyToMessageId&&!value.subject)ctx.addIssue({code:"custom",path:["subject"],message:"Enter a subject."});
});
export type WorkspaceCreateInput=z.infer<typeof workspaceCreateSchema>;
export type DomainCreateInput=z.infer<typeof domainCreateSchema>;
export type MailboxCreateInput=z.infer<typeof mailboxCreateSchema>;
export type AliasCreateInput=z.infer<typeof aliasCreateSchema>;
export type ContactCreateInput=z.infer<typeof contactCreateSchema>;
export type ContactUpdateInput=z.infer<typeof contactUpdateSchema>;
export type SendTestEmailInput=z.infer<typeof sendTestEmailSchema>;
export type ComposeEmailInput=z.infer<typeof composeEmailSchema>;

export type CampaignCreateInput=z.infer<typeof campaignCreateSchema>;

export type CampaignUpdateInput=z.infer<typeof campaignUpdateSchema>;
export type CampaignTemplateCreateInput=z.infer<typeof campaignTemplateCreateSchema>;

export type TeamInvitationCreateInput=z.infer<typeof teamInvitationCreateSchema>;
export type TeamMemberRoleInput=z.infer<typeof teamMemberRoleSchema>;
