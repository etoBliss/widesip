# Widesip production plan: widesi.online

The product name remains **Widesip**. The purchased domain is **widesi.online** (without the final `p` in “Widesip”), so public links and email addresses must use that exact spelling. This is a domain/configuration change; the UI brand does not need to be renamed.

## Production hostnames

| Purpose | Hostname | Provider |
| --- | --- | --- |
| Public site and app | `widesi.online` | Vercel |
| `www` redirect | `www.widesi.online` → `widesi.online` | Vercel |
| Express API | `api.widesi.online` | Railway |
| Widesip account email sender | `notify.widesi.online` | Resend sending domain |

Customer domains added inside Widesip remain independent. Do not add Resend or mail-routing records to the root of `widesi.online` unless Widesip itself later needs a mailbox there. The API and web hostnames do not need MX records.

## Phase 1: secure the domain

1. Manage the domain from the Widesip company Cloudflare account, not a personal account. Turn on MFA/passkeys, keep recovery codes safely, enable auto-renew and domain lock, and verify the registrant email promptly.
2. Add or open the `widesi.online` Cloudflare zone. Keep DNS changes limited to this zone; leave `etobliss.com` untouched.
3. Do not create website DNS records until Vercel and Railway show the exact records for their custom-domain setup. Provider-specific DNS targets can differ by project.

## Phase 2: create production services

Create a production project in Railway with an API service and PostgreSQL. Use Railway's private database connection from the API service. Turn on scheduled backups and point-in-time recovery before storing customer data; rehearse restoring a backup. Railway's standard Postgres instance is a single node until high availability is enabled.

Create a Vercel project for the web app. Because Widesip is a commercial SaaS, use a Vercel Pro or other commercial plan; Vercel Hobby is restricted to non-commercial personal use.

Keep local development, preview/staging, and production secrets and databases separate. Do not copy the local `.env` file into the production service.

## Phase 3: deploy the API and database

Use the repository root for the Railway service so pnpm can see all workspace packages.

- Build command: `pnpm install --frozen-lockfile && pnpm exec turbo build --filter=@widesip/api...`
- Start command: `pnpm --filter @widesip/api start`
- Health check path: `/health`
- Runtime: Node.js 26, matching the workspace engine.

Set these API variables in Railway's **production** environment (values are entered in the hosting dashboards, never committed):

```text
NODE_ENV=production
DATABASE_URL=<Railway PostgreSQL private connection URL>
WEB_ORIGIN=https://widesi.online
BETTER_AUTH_URL=https://api.widesi.online
BETTER_AUTH_SECRET=<fresh random secret, at least 32 characters>
API_PORT=<optional; Railway supplies PORT>
MAIL_TRANSPORT=resend
RESEND_API_KEY=<fresh production-only Resend key>
RESEND_FROM=Widesip <accounts@notify.widesi.online>
RESEND_WEBHOOK_SECRET=<the signing secret from the production Resend webhook>
WIDESIP_PUBLIC_URL=https://api.widesi.online
CAMPAIGN_UNSUBSCRIBE_SECRET=<separate fresh random secret>
TURNSTILE_SITE_KEY=<production Cloudflare Turnstile site key>
TURNSTILE_SECRET_KEY=<production Cloudflare Turnstile secret>
```

Create the Cloudflare Turnstile widget for `widesi.online` and `www.widesi.online`. Production auth intentionally refuses missing or test Turnstile keys.

Do **not** set `CLOUDFLARE_API_TOKEN` or `CLOUDFLARE_ZONE_ID` on the production API yet. The current token integration targets one zone; it must not be used to edit arbitrary customers' domains. Customer DNS automation needs per-customer Cloudflare OAuth and a proper consent flow first. Until then, the app displays DNS records for users to add themselves.

Add `api.widesi.online` to Railway's API service. Copy the CNAME and TXT verification values Railway displays into Cloudflare exactly as shown. Keep the API record DNS-only initially; Railway then validates the custom hostname and provisions TLS.

## Phase 4: prepare PostgreSQL safely

Development can continue using `db:push`. Production uses the checked-in Drizzle migration files:

1. Review the generated SQL under `packages/database/drizzle/` before running it.
2. Provision an empty production database and set its `DATABASE_URL` in the migration environment.
3. Run `pnpm --filter @widesip/database db:migrate` once before the first API deployment.
4. For future schema changes, run `pnpm db:generate`, inspect and commit the migration, then run `db:migrate` against production as a deliberate release step.

Never run `db:push` against production and never point local development at the production database.

## Phase 5: deploy the web app

Set the Vercel project root to `apps/web` and add these Production variables:

```text
NEXT_PUBLIC_API_URL=https://api.widesi.online
NEXT_PUBLIC_TURNSTILE_SITE_KEY=<same production site key as the API configuration>
```

Add `widesi.online` and `www.widesi.online` to the Vercel project. Copy the exact records Vercel requests into the Cloudflare `widesi.online` zone. Configure `www` to redirect to the root hostname. Vercel provisions HTTPS after DNS is verified.

The web app currently proxies routes only when `API_INTERNAL_URL` is configured. This plan uses the public API hostname directly, so leave `API_INTERNAL_URL` unset. API CORS and Better Auth are configured with the exact web origin above.

## Phase 6: set up Widesip's own Resend sender

In the Widesip company Resend account, add and verify **`notify.widesi.online`** for account verification, password resets, invitations, and notifications. Add only the sending DNS records Resend gives for that subdomain in Cloudflare. Do not enable receiving or replace root MX records for this purpose.

Create a production webhook in that Resend account with endpoint:

```text
https://api.widesi.online/v1/webhooks/resend
```

Subscribe to the inbound and delivery events Widesip uses, then place the webhook signing secret in `RESEND_WEBHOOK_SECRET`. Keep a separate webhook and secret for local/staging if those environments use a public tunnel.

Widesip owns this Resend integration. Customers do not need their own Resend accounts. Customers still need to publish the DNS records for their sending domains; automatic Cloudflare changes are not production-enabled yet.

## Before inviting real customers

- Confirm verification, reset, invite, send, receive, unsubscribe, bounce, and complaint flows on the production domain using test accounts.
- Confirm login/session cookies and allowed origins only work over HTTPS and the intended hostnames.
- Enable database backups/PITR, logs, uptime alerting, error alerts, and a tested restore procedure.
- Review privacy policy, terms, data retention/deletion, email consent/unsubscribe, abuse reporting, support contact, and business details.
- Review multi-tenant access controls and run an independent security review before accepting customer mail.

**Privacy boundary:** Widesip's current mail flow is not end-to-end encrypted. The API and database process/store message content, and Resend processes outbound/inbound delivery. HTTPS protects network connections; it does not make mail invisible to the service or encrypt it for recipients. Do not promise end-to-end encryption until that architecture exists.

