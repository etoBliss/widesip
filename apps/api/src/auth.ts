import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { betterAuth } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { captcha } from "better-auth/plugins";
import { and, eq, inArray, sql } from "drizzle-orm";
import { createHmac } from "node:crypto";
import { db } from "@widesip/database";
import { accounts, campaigns, campaignTemplates, loginAttemptLocks, mailboxAccess, rateLimits, sessions, users, verifications, workspaceInvitations, workspaces } from "@widesip/database/schema";
import { sendProductEmail } from "./email.js";
const secret=process.env.BETTER_AUTH_SECRET;
if(!secret || secret.length<32) throw new Error("BETTER_AUTH_SECRET must be configured with at least 32 characters.");
const turnstileSecret=process.env.TURNSTILE_SECRET_KEY;
const turnstileSiteKey=process.env.TURNSTILE_SITE_KEY;
const production=process.env.NODE_ENV==="production";
if(production && (!turnstileSecret || !turnstileSiteKey)) throw new Error("Production auth requires TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY.");
if(production && (turnstileSiteKey==="1x00000000000000000000AA" || turnstileSecret==="1x0000000000000000000000000000000AA")) throw new Error("Cloudflare Turnstile test keys cannot be used in production.");
if(production && !process.env.BETTER_AUTH_URL?.startsWith("https://")) throw new Error("BETTER_AUTH_URL must use HTTPS in production.");
const authPlugins = production && turnstileSecret ? [captcha({provider:"cloudflare-turnstile",secretKey:turnstileSecret,endpoints:["/sign-in/email","/sign-up/email"],allowedHostnames:[new URL(process.env.WEB_ORIGIN??"http://localhost:3000").hostname]})] : [];
function accountKey(email: unknown) {
  return createHmac("sha256", secret!).update(String(email ?? "").trim().toLowerCase()).digest("hex");
}
async function recordFailedPassword(email: unknown) {
  const emailHash=accountKey(email);
  await db.insert(loginAttemptLocks).values({emailHash,failedAttempts:1,updatedAt:new Date()}).onConflictDoUpdate({
    target:loginAttemptLocks.emailHash,
    set:{
      failedAttempts:sql`${loginAttemptLocks.failedAttempts} + 1`,
      lockedUntil:sql`case when ${loginAttemptLocks.failedAttempts} + 1 >= 9 then now() + interval '1 hour' when ${loginAttemptLocks.failedAttempts} + 1 = 8 then now() + interval '30 minutes' when ${loginAttemptLocks.failedAttempts} + 1 = 7 then now() + interval '10 minutes' when ${loginAttemptLocks.failedAttempts} + 1 = 6 then now() + interval '2 minutes' when ${loginAttemptLocks.failedAttempts} + 1 = 5 then now() + interval '30 seconds' else null end`,
      updatedAt:new Date(),
    },
  });
}
export const auth=betterAuth({
  secret, baseURL:process.env.BETTER_AUTH_URL,
  trustedOrigins:[process.env.WEB_ORIGIN ?? "http://localhost:3000"],
  onAPIError:{onError:(error)=>{console.error("[better-auth] API error",error instanceof Error?{name:error.name,message:error.message}:error);}},
  database:drizzleAdapter(db,{provider:"pg",schema:{user:users,session:sessions,account:accounts,verification:verifications,rateLimit:rateLimits}}),
  plugins:authPlugins,
  rateLimit:{enabled:true,storage:"database",window:600,max:30,customRules:{
    "/sign-in/email":{window:600,max:8},
    "/sign-up/email":{window:3600,max:5},
    "/request-password-reset":{window:3600,max:4},
  }},
  hooks:{
    before:createAuthMiddleware(async ctx=>{
      const body=(ctx.body??{}) as Record<string,unknown>;
      if(ctx.path==="/sign-up/email"){
        const type=body.accountType;
        const name=typeof body.name==="string"?body.name.trim():"";
        const dob=typeof body.dateOfBirth==="string"?body.dateOfBirth:"";
        const dobDate=/^\d{4}-\d{2}-\d{2}$/.test(dob)?new Date(`${dob}T00:00:00.000Z`):null;
        const organizationName=typeof body.organizationName==="string"?body.organizationName.trim():"";
        if(type!=="personal"&&type!=="organization") throw APIError.from("BAD_REQUEST",{code:"INVALID_ACCOUNT_TYPE",message:"Choose a personal or organization account."});
        if(name.length<2||name.length>80) throw APIError.from("BAD_REQUEST",{code:"INVALID_NAME",message:"Enter your name using 2 to 80 characters."});
        if(!dobDate||Number.isNaN(dobDate.getTime())||dobDate.toISOString().slice(0,10)!==dob||dob<"1900-01-01"||dobDate.getTime()>Date.now()) throw APIError.from("BAD_REQUEST",{code:"INVALID_DATE_OF_BIRTH",message:"Enter a valid date of birth that is not in the future."});
        if(type==="organization"&&(organizationName.length<2||organizationName.length>80)) throw APIError.from("BAD_REQUEST",{code:"INVALID_ORGANIZATION_NAME",message:"Enter an organization name between 2 and 80 characters."});
      }else if(["accountType","dateOfBirth","organizationName"].some(field=>Object.prototype.hasOwnProperty.call(body,field))){
        throw APIError.from("FORBIDDEN",{code:"SIGNUP_DETAILS_LOCKED",message:"Account type and signup details can only be set during account creation."});
      }
      if(ctx.path==="/sign-in/email"){
        const emailHash=accountKey(body.email);
        const [lock]=await db.select({lockedUntil:loginAttemptLocks.lockedUntil}).from(loginAttemptLocks)
          .where(and(eq(loginAttemptLocks.emailHash,emailHash),sql`${loginAttemptLocks.lockedUntil} > now()`)).limit(1);
        if(lock?.lockedUntil){
          const seconds=Math.max(1,Math.ceil((lock.lockedUntil.getTime()-Date.now())/1000));
          throw APIError.from("TOO_MANY_REQUESTS",{code:"ACCOUNT_TEMPORARILY_LOCKED",message:`Too many incorrect attempts. Try again in ${seconds} seconds.`});
        }
      }
    }),
    after:createAuthMiddleware(async ctx=>{
      if(ctx.path!=="/sign-in/email") return;
      const emailHash=accountKey(ctx.body.email);
      const result=ctx.context.returned;
      if(result instanceof APIError && result.body?.code==="INVALID_EMAIL_OR_PASSWORD"){
        await recordFailedPassword(ctx.body.email);
      }else if(!(result instanceof APIError)){
        await db.delete(loginAttemptLocks).where(eq(loginAttemptLocks.emailHash,emailHash));
      }
    }),
  },
  emailAndPassword:{enabled:true,minPasswordLength:12,maxPasswordLength:128,requireEmailVerification:true,revokeSessionsOnPasswordReset:true,resetPasswordTokenExpiresIn:3600,onPasswordReset:async({user})=>{void sendProductEmail(user.email,"Your Widesip password was changed","Your Widesip password was recently changed. If you did not make this change, contact support.").catch(error=>console.error("Password change notification failed",error));},sendResetPassword:async({user,url})=>{void sendProductEmail(user.email,"Reset your Widesip password",`Use this secure link to reset your password. The link expires shortly.\n\n${url}`).catch(error=>console.error("Password reset email failed",error));}},
  user:{additionalFields:{
    accountType:{type:"string",required:true,input:true,defaultValue:"personal"},
    dateOfBirth:{type:"string",required:true,input:true},
    organizationName:{type:"string",required:false,input:true},
    onboardingComplete:{type:"boolean",required:false,input:false,defaultValue:false},
  },deleteUser:{enabled:true,beforeDelete:async(user)=>{
    const owned = await db.select({id:workspaces.id,name:workspaces.name,type:workspaces.type}).from(workspaces).where(eq(workspaces.ownerUserId,user.id));
    const organization = owned.find(row=>row.type==="organization");
    if(organization) throw new Error(`Transfer ownership of ${organization.name} before deleting this account.`);
    const personalIds=owned.filter(row=>row.type==="personal").map(row=>row.id);
    if(personalIds.length) await db.delete(workspaces).where(inArray(workspaces.id,personalIds));
    const invited=await db.select({id:workspaceInvitations.id,workspaceId:workspaceInvitations.workspaceId}).from(workspaceInvitations).where(eq(workspaceInvitations.invitedByUserId,user.id));
    const granted=await db.select({id:mailboxAccess.id,workspaceId:mailboxAccess.workspaceId}).from(mailboxAccess).where(eq(mailboxAccess.grantedByUserId,user.id));
    const authoredCampaigns=await db.select({id:campaigns.id,workspaceId:campaigns.workspaceId}).from(campaigns).where(eq(campaigns.createdByUserId,user.id));
    const authoredTemplates=await db.select({id:campaignTemplates.id,workspaceId:campaignTemplates.workspaceId}).from(campaignTemplates).where(eq(campaignTemplates.createdByUserId,user.id));
    const workspaceIds=[...new Set([...invited,...granted,...authoredCampaigns,...authoredTemplates].map(row=>row.workspaceId))];
    if(!workspaceIds.length) return;
    const workspaceOwners=await db.select({id:workspaces.id,ownerUserId:workspaces.ownerUserId}).from(workspaces).where(inArray(workspaces.id,workspaceIds));
    const ownerByWorkspace=new Map(workspaceOwners.map(row=>[row.id,row.ownerUserId]));
    for(const row of invited){const owner=ownerByWorkspace.get(row.workspaceId);if(owner&&owner!==user.id)await db.update(workspaceInvitations).set({invitedByUserId:owner}).where(eq(workspaceInvitations.id,row.id));}
    for(const row of granted){const owner=ownerByWorkspace.get(row.workspaceId);if(owner&&owner!==user.id)await db.update(mailboxAccess).set({grantedByUserId:owner}).where(eq(mailboxAccess.id,row.id));}
    for(const row of authoredCampaigns){const owner=ownerByWorkspace.get(row.workspaceId);if(owner&&owner!==user.id)await db.update(campaigns).set({createdByUserId:owner}).where(eq(campaigns.id,row.id));}
    for(const row of authoredTemplates){const owner=ownerByWorkspace.get(row.workspaceId);if(owner&&owner!==user.id)await db.update(campaignTemplates).set({createdByUserId:owner}).where(eq(campaignTemplates.id,row.id));}
  }}},
  emailVerification:{sendOnSignUp:true,sendOnSignIn:true,autoSignInAfterVerification:true,expiresIn:3600,sendVerificationEmail:async({user,url})=>{void sendProductEmail(user.email,"Verify your Widesip email",`Verify your email address to continue setting up Widesip.\n\n${url}`).catch(error=>console.error("Verification email failed",error));}},
  session:{expiresIn:60*60*12,updateAge:60*60},
  advanced:{useSecureCookies:production,ipAddress:{ipAddressHeaders:["cf-connecting-ip"]}},
});



