# Gather API

NestJS 11 API for the Gather private-community frontend. Requires Node.js 24.15+ on the Node 24 line. Uses Node's SQLite module with WAL, foreign keys, parameterized SQL, and persistent storage.

## Run

```sh
npm ci
cp .env.example .env
npm run build
npm start
```

On PowerShell use `Copy-Item .env.example .env`. The default API is http://127.0.0.1:3000/api. Clone https://github.com/Ubdale/gather-frontend separately and run its development server on http://127.0.0.1:4200. Its `/api` proxy keeps cookies and requests on the same browser origin.

There are no default users or seeded passwords. Register an owner through the frontend. Data is stored under `.data/gather.sqlite` by default, outside source control.

## Checks

`npm test` builds the API and runs real HTTP multi-user integration tests using an isolated in-memory database, plus a file-persistence test. Tests cover unauthorized requests, request origins, registration, password rules, invitation acceptance, isolation between tenants, role restrictions, posts/comments/reactions/bookmarks, private messages, unread state, reports/moderation, archive rules, quotas, suspension, administrative permissions, plan requests, branding, audit history, password changes, recovery tokens, data export, logout, and persistence.

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

Private voice messages: POST `workspaces/:workspaceId/conversations/:id/voice` with JSON `{audio: base64, mime, duration, waveform}`. Accepted containers are WebM, Ogg, MP4 and WAV, checked by signature; this is not full audio decoding. Limit 2 MB decoded bytes and 3 MB JSON, 180 seconds of declared duration, 1–64 normalized waveform peaks. The browser recorder enforces its duration timer. Workspace audio quotas: Pilot 50 MB, Starter 256 MB, Growth 1024 MB. Bytes live in SQLite `voice_messages`, included in normal database backups. Message lists return duration/waveform metadata; GET `workspaces/:workspaceId/conversations/:id/messages/:messageId/audio` requires active membership and participation and supports single byte ranges. Both participants can play sent recordings; suspended conversations are read-only. Reverse proxies must permit 3 MB requests and `media-src 'self' blob:` for local previews.

## Operator commands

```sh
npm run plan -- requests
npm run plan -- activate REQUEST_ID --confirm-invoiced
npm run plan -- decline REQUEST_ID
npm run account -- recovery user@example.com --identity-verified
npm run backup -- /private-backups/gather.sqlite
```

Activation does not process money. Verify the external invoice/payment first. Recovery requires identity verification through your support process and emits a sensitive one-use URL. Never publish it.

## Deployment limits

Use the Dockerfile with a persistent volume at `/app/.data`, NODE_ENV=production, HOST=0.0.0.0, and FRONTEND_URL set to the real HTTPS origin. The frontend repository includes nginx and a two-container deployment example. API replicas must not use independent local SQLite files. This is a single-instance paid-pilot architecture; migrate to a coordinated database before horizontal scale.

Automatic email, media uploads, calls, native apps, automatic billing/renewal, and end-to-end encryption are not included. The frontend does not expose pretend controls for them. Configure HTTPS, support identity verification, customer terms/privacy information, operational monitoring, backups, and a retention/deletion process before public onboarding.
