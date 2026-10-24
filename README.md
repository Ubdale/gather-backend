# Gather API

NestJS 11 API for the Gather private-community frontend. Requires Node.js 24.15+ on the Node 24 line. Uses PostgreSQL through `pg`, a bounded connection pool, parameterized SQL, verified TLS for Neon, and transaction-scoped clients. Configure `DATABASE_URL` only in the backend environment. Runtime storage has no SQLite fallback.

## Run

```sh
npm ci
cp .env.example .env
npm run build
npm start
```

On PowerShell use `Copy-Item .env.example .env`. The default API is http://127.0.0.1:3000/api. Clone https://github.com/Ubdale/gather-frontend separately and run its development server on http://127.0.0.1:4200. Its `/api` proxy keeps cookies and requests on the same browser origin.

Set `DATABASE_URL` in `.env` before starting. `DATABASE_SCHEMA` defaults to `gather`; startup creates its additive tables without touching other schemas. There are no default users or seeded passwords. Register an owner through the frontend. Keep `.env`, credentials and backups out of source control. The example URL uses local PostgreSQL; Neon connections use TLS with certificate verification and channel binding enabled.

## Checks

Set `TEST_DATABASE_URL`, then run `npm test`. Each test file creates and cleans up a uniquely named `gather_test_*` PostgreSQL schema, never the application schema. CI supplies PostgreSQL 17. Tests cover authorization, origins, registration, invitations, tenant isolation, roles, posts/comments/reactions/bookmarks, text/voice messages, moderation, quotas, suspension, plans, audit, password/recovery flows, exports, persistence, concurrent registration and backup/restore.

## API surface

All routes are under `/api`.

- Public: GET `/health`, GET `/plans`.
- Accounts: POST `/auth/register`, `/auth/login`, `/auth/logout`, `/auth/recover`; authenticated GET `/auth/me`, `/auth/export`; POST `/auth/profile`, `/auth/password`, `/auth/accept-invitation`.
- Workspaces: authenticated GET/POST `/workspaces`; membership-scoped GET/PATCH `/workspaces/:workspaceId`.
- Within a workspace: `spaces`, `invitations`, `members/:id`, `posts`, `posts/:id`, `posts/:id/comments`, `comments/:id`, `posts/:id/reaction`, `posts/:id/bookmark`, `posts/:id/report`.
- Staff: `moderation`, `moderation/:postId`, `reports/:id`, `audit`.
- Messaging: `conversations`, `conversations/:id`, `conversations/:id/messages`.
- Owner/operator billing workflow: GET/POST `billing`.

See controller source for exact methods and validated request shapes. Feed pages contain at most 30 posts, messages/comments at most 50 per page, moderation at most 200 recent entries, and audit at most 100 recent events. Cursor-based earlier-page loading is available in the frontend. Direct-conversation listing is capped at 100 per user/workspace in this launch scope.

## Security model

Passwords use salted scrypt. Sessions and invitation/recovery tokens are stored hashed. Session cookies are HttpOnly, SameSite=Lax, and Secure in production. Every workspace request checks current membership and suspension. Private messaging additionally checks participation. Owners cannot demote/suspend themselves; admins cannot manage peer admins or grant administrator access. Moderators can manage community content but not member permissions or branding. The client cannot activate a paid plan.

State-changing HTTP requests must send an Origin matching FRONTEND_URL. Production should use a single HTTPS frontend/API origin. Rate limits and helmet headers are enabled. No payment credentials are needed for the manual invoice model.

Private voice messages: POST `workspaces/:workspaceId/conversations/:id/voice` with JSON `{audio: base64, mime, duration, waveform}`. Accepted containers are WebM, Ogg, MP4 and WAV, checked by signature; this is not full audio decoding. Limit 2 MB decoded bytes and 3 MB JSON, 180 seconds of declared duration, 1–64 normalized waveform peaks. The browser recorder enforces its duration timer. Workspace audio quotas: Pilot 50 MB, Starter 256 MB, Growth 1024 MB. Bytes live in PostgreSQL `voice_messages`, included in normal database backups. Message lists return duration/waveform metadata; GET `workspaces/:workspaceId/conversations/:id/messages/:messageId/audio` requires active membership and participation and supports single byte ranges. Both participants can play sent recordings; suspended conversations are read-only. Reverse proxies must permit 3 MB requests and `media-src 'self' blob:` for local previews.

## Operator commands

```sh
npm run plan -- requests
npm run plan -- activate REQUEST_ID --confirm-invoiced
npm run plan -- decline REQUEST_ID
npm run account -- recovery user@example.com --identity-verified
npm run backup -- /private-backups/gather.json
npm run restore -- /private-backups/gather.json
npm run import:sqlite -- /private-data/old-gather.sqlite
```

Activation does not process money. Verify the external invoice/payment first. Recovery requires identity verification through your support process and emits a sensitive one-use URL. Never publish it.

## Deployment limits

Use the Dockerfile with DATABASE_URL supplied as a secret, NODE_ENV=production, HOST=0.0.0.0, and FRONTEND_URL set to the real HTTPS origin. The frontend repository includes nginx and a two-container deployment example. PostgreSQL is the shared source of truth; multi-step writes use a schema-scoped advisory transaction lock for correctness. This deliberately serializes writes for the pilot; partition locks and add shared rate limiting before high-throughput multi-instance deployment. The pool supports Neon's transaction pooler without relying on session search paths. Voice bytes use BYTEA.

Backups use a consistent read-only repeatable-read snapshot and include all app tables and audio bytes. Snapshot files contain private customer data and password hashes; encrypt off-host copies and restrict access. Restore and the one-time SQLite importer refuse any populated destination schema and run transactionally. Keep the old SQLite file until migration has been verified. For large production databases use provider recovery and PostgreSQL-native backup tooling; the JSON tool loads the snapshot in memory.

Automatic email, media uploads, calls, native apps, automatic billing/renewal, and end-to-end encryption are not included. The frontend does not expose pretend controls for them. Configure HTTPS, support identity verification, customer terms/privacy information, operational monitoring, backups, and a retention/deletion process before public onboarding.
