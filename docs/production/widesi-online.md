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

Keep `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ZONE_ID` out of production. That static token is for local testing only; production customer DNS automation uses each organization's Cloudflare OAuth authorization. When an organization does not connect Cloudflare, Widesip displays records for manual DNS setup.

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

Widesip owns this Resend integration. Customers do not need their own Resend accounts. Customers can publish the displayed DNS records manually, or authorize Widesip's Cloudflare OAuth integration for the verified domain. OAuth writes are scoped to that customer zone; the Widesip company zone token is never used to edit customer DNS.

## Before inviting real customers

- Confirm verification, reset, invite, send, receive, unsubscribe, bounce, and complaint flows on the production domain using test accounts.
- Confirm login/session cookies and allowed origins only work over HTTPS and the intended hostnames.
- Enable database backups/PITR, logs, uptime alerting, error alerts, and a tested restore procedure.
- Review privacy policy, terms, data retention/deletion, email consent/unsubscribe, abuse reporting, support contact, and business details.
- Review multi-tenant access controls and run an independent security review before accepting customer mail.

**Privacy boundary:** Widesip's current mail flow is not end-to-end encrypted. The API and database process/store message content, and Resend processes outbound/inbound delivery. HTTPS protects network connections; it does not make mail invisible to the service or encrypt it for recipients. Do not promise end-to-end encryption until that architecture exists.

## Production readiness work still required

The repository has a working production deployment path, but these features need the following production-specific work before Widesip should be treated as ready for general customer traffic:

### Cloudflare customer connections

- Production DNS automation uses a Cloudflare OAuth client that an organization owner or admin authorizes for each verified domain. Never use Widesip's own zone token to change customer zones.
- Register a server-side authorization-code OAuth client on the verified `widesi.online` domain. Request only the Cloudflare DNS read/write permissions needed for DNS setup. Widesip stores OAuth state and PKCE data server-side, encrypts customer tokens at rest with AES-256-GCM, and associates each consent with a verified workspace domain and matched zone.
- In Cloudflare, public OAuth clients require client-domain ownership verification. OAuth clients support the authorization-code flow; private clients only work for members of the client owner's account. See [Cloudflare OAuth client setup](https://developers.cloudflare.com/fundamentals/oauth/create-an-oauth-client/) and [OAuth integration endpoints](https://developers.cloudflare.com/fundamentals/oauth/integrate-with-cloudflare/).
- Configure the OAuth client ID, secret, exact scope IDs, redirect URI `https://api.widesi.online/v1/integrations/cloudflare/callback`, and a base64-encoded random 32-byte encryption key in Railway. Generate the key with `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`. Keep these values in Railway only. The client uses authorization code + PKCE and refresh tokens, so enable the `refresh_token` grant and include `offline_access`; request the narrow `zone.read`, `dns.read`, and `dns.write` scopes supported by the client. Confirm the exact IDs against Cloudflare's OAuth scope list and select only DNS/zone permissions, not account-wide permissions. Production DNS writes read existing records first, preserve conflicts and root MX routes, and retain copyable DNS records as a fallback when Cloudflare is not connected. Cloudflare documents OAuth scope selection and the supported scope API in [OAuth client setup](https://developers.cloudflare.com/fundamentals/oauth/create-an-oauth-client/) and its [OAuth client API](https://developers.cloudflare.com/api/resources/iam/subresources/oauth_clients/).

### Contact collection on customer sites

- This is an organization's public contact/newsletter collection form, not Widesip account signup. The Contact page's copied widget script opens the form in a modal iframe. A visitor submits their name, email, and explicit email consent; the record is saved directly to that organization's Contacts. The high-entropy link token identifies the target list; customers and visitors do not need Resend accounts.
- Production security headers are applied before route responses. Authenticated pages deny framing; only the public contact-collection iframe permits framing. Collection, compose, and test-send rate limits are stored in PostgreSQL so they apply across API replicas.
- The checkbox is currently the consent record; there is no email-confirmation/double-opt-in step. Decide whether to require double opt-in before large-scale newsletter use. Keep unsubscribe and complaint suppression effective if that flow is added.

### Resend production setup

- Use the Widesip company Resend account and a verified sender such as `accounts@notify.widesi.online` for Widesip account emails. Customers should not create Resend accounts.
- Add the sending DNS records Resend provides for `notify.widesi.online`, then set `RESEND_API_KEY`, `RESEND_FROM`, and `RESEND_WEBHOOK_SECRET` in Railway's production environment. Never place the API or webhook secret in Vercel or a `NEXT_PUBLIC_*` variable.
- Register `https://api.widesi.online/v1/webhooks/resend` and subscribe to `email.received`, `email.sent`, `email.delivered`, `email.delivery_delayed`, `email.bounced`, `email.complained`, and `email.suppressed`. Resend signs webhook requests and retries failed deliveries; Widesip verifies the signature and should be monitored for non-2xx responses. See [Resend webhooks](https://resend.com/features/webhooks) and [Resend inbound email](https://www.resend.com/features/inbound).
- Organization sending domains remain separate Resend domains owned by the Widesip integration. Users publish the DNS records Widesip displays; they do not supply provider credentials. Receiving requires the receiving MX records and the production webhook. Do not replace a customer's existing root MX records without explicit confirmation.
- `GET /ready` checks database connectivity plus production email and customer Cloudflare OAuth configuration without returning secret values. Keep `/health` as Railway's basic liveness check; use `/ready` as the pre-launch readiness check after configuration is complete.

### Campaigns and inbox scale

- Campaign sends are now queued in PostgreSQL, claimed safely across API replicas, retried with backoff, and sent with a stable Resend idempotency key. Local development is capped at 25 recipients; production is capped at 10,000 per campaign. Add per-workspace daily/monthly quotas, billing enforcement, abuse review, and queue age/attempt alerts before broad customer access.
- The inbox uses PostgreSQL notifications and authenticated Server-Sent Events for live updates. Browsers refresh after reconnect and while returning to a visible tab; a 60-second recovery refresh runs only while the event stream is unavailable. PostgreSQL notifications are transient, so keep the reconnect refresh and add monitoring for event-stream/database connection exhaustion.
- Attachments are currently carried in request/database payloads. Move them to private object storage with short-lived download URLs, malware scanning, retention/deletion rules, and strict size limits before supporting larger production traffic.
- Decide whether to require double opt-in for public newsletter forms. Keep suppression checks effective for bounced, complained, unsubscribed, and provider-suppressed recipients. Add durable webhook event idempotency, automated database restore drills, and alerting before broad release.

