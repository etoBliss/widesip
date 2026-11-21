# Architecture decisions

## Scope for the first build

The first implementation stage establishes the web application, workspace identity boundary, and domain onboarding foundation. The marketing site describes the intended platform; availability statements are kept explicit where provider-backed functionality is not active.

## Multi-tenant boundary

A workspace owns domains and future mailboxes, messages, and usage records. Every workspace resource includes `workspace_id`. API operations resolve a signed-in user's membership before reading or changing a workspace resource. Client-supplied workspace IDs select context only; they do not grant access.

## Authentication

Better Auth owns credential and session operations. Express mounts the Better Auth handler before JSON parsing, and protected routes resolve the current user from the server-validated session cookie. Do not use a frontend-supplied user or role.

## Email infrastructure

Resend is reserved for Widesip product notifications. Customer mailbox delivery remains behind separate provider adapters and is unavailable until inbound/outbound capabilities, limits, and costs are validated. Domain creation records a pending domain only; it does not claim DNS ownership or activate MX routing.

## Verification records

Domain verification requires a cryptographically random token whose hash is stored in `domain_verifications`. DNS checks must run asynchronously and only set `verified` after observing the expected TXT record. Never replace existing MX records automatically.

## Known deployment prerequisites

PostgreSQL, a valid Better Auth secret, an email verification delivery integration, and production origin configuration are required before sign-up can be used outside local development. Redis/BullMQ and object storage will be added with email processing, rather than simulated in the first slice.
Production browser sessions use cookies, so serve the web app and API on the same site. If the API runs on a separate origin, proxy `/api/*` and `/v1/*` through the web host using `API_INTERNAL_URL` and set `BETTER_AUTH_URL`/`WEB_ORIGIN` to the browser-visible web origin. This avoids relying on third-party cookies.
