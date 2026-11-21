# Widesip

Your email. Your domains. One place.

Widesip is a multi-tenant email and communications platform. This repository starts with the product foundation and workspace/domain model described in the WIDESIP blueprint.

## Stack

- `apps/web`: Next.js 16 App Router, TypeScript, Tailwind CSS
- `apps/api`: Express 5 REST API and Better Auth
- `packages/database`: PostgreSQL + Drizzle schema
- `packages/validation`: shared Zod schemas
- pnpm workspaces + Turborepo

## Local setup (PowerShell)

1. Install Node.js 26 LTS and pnpm 10.
2. In this folder, copy `.env.example` to `.env` and set a random `BETTER_AUTH_SECRET` of at least 32 characters.
3. Copy `apps/web/.env.example` to `apps/web/.env.local`.
4. Start PostgreSQL and set `DATABASE_URL` in `.env`.
5. Configure a verified Resend sender with `RESEND_API_KEY` and `RESEND_FROM`; account verification and password recovery depend on it.
6. Run `pnpm install`, `pnpm db:push`, then `pnpm dev`.

The web app runs on port 3000 and the API on port 4000. API auth requires a valid database and signing secret. Sign-up also requires the transactional email sender above.

## Current boundary

The app supports domain ownership verification, mailbox address records, Resend sending-domain preparation, safe Cloudflare DNS record creation, and a limited outbound test message. Inbound email delivery and inbox storage are still in development. The current local Cloudflare token path is for the project owner's test zone; customer-facing Cloudflare OAuth requires Widesip's verified public domain.

See `docs/architecture/decisions.md` for the tenant boundary and infrastructure decisions. See the attached product blueprint for the full roadmap.
Production browser sessions use cookies, so serve the web app and API on the same site. If the API runs on a separate origin, proxy `/api/*` and `/v1/*` through the web host using `API_INTERNAL_URL`, set `NEXT_PUBLIC_API_URL` to an empty string, and set `BETTER_AUTH_URL`/`WEB_ORIGIN` to the browser-visible web origin. This avoids relying on third-party cookies.
# Local sending-domain connection (Resend + Cloudflare)

The Domains page can prepare a verified domain for outbound sending through the Widesip Resend account. For a local test, `RESEND_API_KEY` is required. To have Widesip add the returned DNS records automatically, also set `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ZONE_ID` in the root `.env` file.

For the `etobliss.com` test, create a Cloudflare API token restricted to that zone with **DNS Read** and **DNS Write** only. Find the zone ID in the Cloudflare domain overview. Keep both values in the root `.env`; never put them in frontend variables or paste them into chat. If the Cloudflare values are omitted, Widesip displays the Resend records for manual addition.

The sending setup uses a dedicated return-path subdomain and leaves the domain's root MX records alone, preserving the current Cloudflare-to-Gmail forwarding. Widesip checks for conflicting DNS records and stops instead of overwriting them. After adding the credentials, run `pnpm db:push` and restart `pnpm dev`, then open **Domains** and choose **Set up sending** for the verified domain.

This local API-token path is for the project owner's test zone only. Customer-facing one-click setup must use Cloudflare OAuth, which requires Widesip's verified public domain before Cloudflare will make the OAuth client public. Incoming-message routing and the Widesip inbox are a separate next step; this connection enables sender-domain verification only.
