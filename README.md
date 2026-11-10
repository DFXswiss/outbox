# Outbox

Internal send queue for **approved social posts**. A person writes, a person approves, the service publishes through **official APIs**. This is not a coordinator for all outbound communications.

Phase 1 is **X (OAuth 2.0)** for one brand. Telegram, Nostr, and LinkedIn are later phases.

This repository is the Outbox **application**. Deployment config lives in the infrastructure repository, not here.

---

## Goals

1. Phase 1: publish to **X** through the official API (OAuth 2.0) for **one** brand, with a real post as proof.
2. Login is the existing DFX JWT (`api.dfx.swiss`). Compose/submit requires `hasRoleAccess(OUTBOX, payload.role)` — the user's own `UserRole.OUTBOX`, or Admin/SuperAdmin via additionalRoles. Grant Outbox like Support: set `User.role` on the user of the target userData. Approve requires `UserRole.ADMIN`.
3. Approval is the only insert into the send queue. GET never mutates.
4. Outcomes `sent` | `failed` | `uncertain`. `uncertain` is never auto-retried. Approvers retry `failed` and resolve `uncertain`.
5. No LLM. Content packs (`facts-sheet.md`, `voice-guide.md`, `rules.json`) are deterministic checks.
6. Secrets stay out of git. Config is in the image/environment. Boot probe proves valid X credentials before send.

## Non-goals

- Analytics, replies, DMs, video, multi-image, auto-translation, LLM generation.
- Browser DOM automation against x.com or linkedin.com.
- A laptop executor or a second role model / email allowlist besides `User.role`.
- Cloudflare Access as identity.
- Telegram, Nostr, or LinkedIn in phase 1.

---

## Auth (DFX JWT)

Identity is the **existing DFX JWT** (HS256), not Cloudflare Access and not an email allowlist.

| Actor | How they sign in | Role |
|---|---|---|
| Composer | DFX mail login (magic link), then TOTP in Outbox | `Outbox` |
| Approver | Wallet sign-in | `Admin` / `SuperAdmin` |

Mail login does **not** elevate Admin. Approvers stay on wallet sign-in.

**Grant:** an Admin sets `User.role` on the user of the target userData (`UpdateUserInternalDto.role`), same as Support/Compliance. Put `OUTBOX` only on userData that has no other staff user (mail login picks one staff user; Support/Compliance would shadow Outbox).

**Composer login**

1. Outbox requests `POST /v1/auth/mail` with a redirect URI pointing to its callback. The mail opens the DFX mail-login page, which calls `GET /v1/auth/mail/redirect?code=…`; its 200 JSON `redirectUrl` is opened by the page.
2. The callback receives a staff JWT with `tfaRequired`, stores it in a ten-minute pending session, and redirects to `/auth/tfa` without the JWT in the URL. It does not set a working cookie yet.
3. Outbox checks `GET /v1/auth/2fa?level=Strict`. If no proof exists it requests setup: a new secret and URI are displayed for enrollment, while a 409 means the authenticator is already set up. The user enters the code on Outbox.
4. Outbox calls `POST /v1/auth/2fa/verify` itself because DFX binds the proof to the caller's IP address. Outbox then calls `GET /v1/auth/introspect/outbox`; only a 200 issues the working cookie. Missing verified staff name is a hard error.

**Approver login**

Outbox requests `GET /v1/auth/signMessage`, has the browser wallet sign it, and sends the address and signature to `POST /v1/auth/signIn`. The 201 response contains `accessToken`; Outbox checks `GET /v1/auth/introspect/admin` before issuing the working cookie. API clients may submit an access token to `POST /auth/callback`, which tries admin introspection and then outbox on 403.

Browser/SSR uses the cookie. Outbox always sends `Authorization: Bearer` to the DFX API. API routes accept cookie **or** Bearer.

**Checks inside Outbox**

- Verify HS256 with the **same JWT secret** as the DFX API. Mail-elevated staff tokens include `address`. Account tokens do not; they are not enough. Copy the default JWT validate branch (`address && user && account`). Outbox users need a wallet, like Support.
- `hasRoleAccess(entryRole, payload.role)` with the DFX hierarchy. Compose/submit/retract: `OUTBOX` (retract also `authoredBy`; Outbox introspect). Decide/retry/resolve: `ADMIN` (Admin introspect). Retract is **not** Admin-only. Admin/SuperAdmin may compose via additionalRoles.
- Audit uses JWT `user` and `account`, never a typed email.
- Introspect **every** authenticated route (HTML GET, API, mutations).
  - `GET /v1/auth/introspect/outbox`: `RoleGuard(OUTBOX)` (Admin via additionalRoles). If `payload.role === 'Outbox'`: mail-origin claim `tfaRequired` **and** the DFX TFA interceptor must have passed (completed TOTP). Wallet-Outbox tokens → 403. A pre-verify magic-link JWT still carries the claim but introspect stays 403 until `2fa/verify`. Admin/SuperAdmin on this route without that claim is allowed.
  - `GET /v1/auth/introspect/admin`: `RoleGuard(ADMIN)`, no `tfaRequired`. Never run dual-visibility GETs through the admin introspect (composers would 403).
- Health endpoints have no JWT.

The DFX API must add `UserRole.OUTBOX` to the enum, `StaffRoles`, `KycGatedRoles`, and `additionalRoles[OUTBOX] = [ADMIN, SUPER_ADMIN]` (plus ACCOUNT/USER entries). `hasRoleAccess` is not recursive.

---

## Design

One process, one image: HTTP (composer + API) plus a ticker.

| Part | Responsibility |
|---|---|
| Composer | SSR HTML: plaintext, optional image, X preview, review findings, submit for approval |
| Review | Deterministic checks against `content/<brand>/` in the image |
| Approval | GET: Admin sees all first, else Outbox sees own (`authoredBy.account === payload.account`). POST decide is Admin only. Promote to the queue **only** on `approve`. |
| Scheduler | One global queue, X publisher, honest status, failure alerts |

Node 22, no frontend bundler. SQLite WAL on durable storage.

### Composer (phase 1)

- Plaintext, one optional PNG/JPEG ≤ 5 MiB, date plus hour and 5-minute minute choices as **Europe/Zurich** wall time (server parses IANA `Europe/Zurich`, not the browser zone).
- The composer checks text as it is typed and shows a Posts overview for authors and approvers.
- X only.
- Preview: text, optional image, character count, X pay-per-use cost hint (post 0.015 USD, post with URL 0.200 USD).
- Blocking review → submit 409.
- Submit creates an atomic bundle (text + image + time) and notifies approvers (no secrets in the URL).
- **No** “Publish now” / “Schedule” control without approval.
- Identity only from the JWT.

### Draft → queue → X

Promote in the **same SQLite transaction** as `submitted → approved` (UNIQUE on `scheduled_posts` per entry/channel). Insert the queue row with `status='pending'` and phase-1 `channel='x'`. Crash before commit: no queue row. Crash after commit: same id, no second insert. That is **not** exactly-once toward X.

`contentHash` = SHA-256(text NUL scheduledAt NUL imageBytes). `scheduledAt` is epoch ms. Past time at submit → 409.

`GET /review/:id` is read-only. Decide is POST only. No share token in the query. Auth callbacks may carry a transient `?session=<jwt>` and must strip it.

```mermaid
sequenceDiagram
  participant P as Composer
  participant B as Outbox
  participant API as DFX API
  participant Q as Admin
  participant X as api.x.com
  P->>B: POST /auth/mail
  B->>API: POST /v1/auth/mail (redirectUri = Outbox callback)
  API-->>P: Mail link opens DFX mail-login page
  P->>API: GET /v1/auth/mail/redirect?code=...
  API-->>P: 200 JSON redirectUrl; page navigates
  P->>B: GET /auth/callback?session=JWT
  B-->>P: Pending cookie; 302 /auth/tfa
  B->>API: GET/POST /v1/auth/2fa?level=Strict
  P->>B: POST /auth/tfa (code)
  B->>API: POST /v1/auth/2fa/verify
  B->>API: GET /v1/auth/introspect/outbox Bearer
  API-->>B: 200
  B-->>P: Set-Cookie, strip query
  Q->>B: Wallet signs message; POST /auth/wallet
  B->>API: POST /v1/auth/signIn
  API-->>B: 201 JSON accessToken
  B->>API: GET /v1/auth/introspect/admin
  B-->>Q: Set-Cookie
  P->>B: POST /api/submit Cookie
  B->>API: GET /v1/auth/introspect/outbox Bearer
  B->>B: review rules.json; create bundle
  Q->>B: POST /review/:id/decide {decision: approve or reject, comment?} Bearer
  B->>API: GET /v1/auth/introspect/admin Bearer
  alt approve
    B->>B: CAS submitted to approved; queue in same tx
  else reject
    B->>B: CAS submitted to rejected
  end
  opt queued and due
    Note over B,X: Ticker, never Decide
    opt image attached
      B->>X: POST /2/media/upload
      X-->>B: media id or error (failed, no tweet)
    end
    B->>X: POST /2/tweets OAuth
    X-->>B: id or error
    B->>B: sent / failed / uncertain
  end
```

### Serial publish

One global queue, one `runningId`. Due = `pending && scheduledAt <= now`. Phase 1 channel is X only. Budget 90 s. Timeout after dispatch → `uncertain`.

SIGTERM: ticker stops, waits for `runningId`. Boot: interrupted in-flight channel → `uncertain`.

**Composer (OUTBOX, authoredBy):**

- `POST /api/bundles/:id/retract` — Phase 1 is **one entry per bundle**. Retract 409 unless **every** entry on the bundle is still `submitted`. Then CAS all of them `submitted → retracted` in one transaction. Channel `pending` is not retractable.

**Approver (ADMIN):**

- `POST /api/posts/:id/retry` — `BEGIN IMMEDIATE` + `UPDATE … WHERE id=? AND status='failed'` → `pending`, audit, **no** synchronous X call. Unknown id → 404; a post that is not `failed` → 409. Ticker takes due.
- `POST /api/posts/:id/resolve-uncertain` — `{ resolution: "sent"|"failed", url? }`. Channel comes from the row. CAS `WHERE id=? AND status='uncertain'`. Unknown id → 404; a post that is not `uncertain` → 409. A given `url` must be an X post permalink (`/<handle>/status/<id>`); query and fragment are dropped.

Channel status: `pending | in-flight | sent | failed | uncertain`. `PublishResult.ok` is a JSON boolean, not the status.

### X (phase 1)

- OAuth 2.0 user token against `api.x.com`.
- Scopes: `tweet.read`, `tweet.write`, `users.read`, `offline.access`, and `media.write` for media upload.
- One-shot `POST /2/media/upload` (`media_category=tweet_image`) before `POST /2/tweets`; refresh `POST /2/oauth2/token`.
- One refresh on HTTP 401, never a second. Failed refresh **after dispatch** (tweet call already sent) → CAS `in-flight → uncertain` plus `needs-login` alert, no loop. Failed refresh **before dispatch** → `failed` (retry allowed).
- Any media upload failure occurs before the tweet request, so it is `failed` and no tweet request is sent.
- No auto-retry after an accepted `POST /2/tweets`.
- Boot probe: `GET /2/users/me` username, strip a leading `@` on **both** sides, compare to configured handle. Mismatch → `probes.x=bad`, no send.
- Dev uses a **test** X account, not the brand account. Client id is config; client secret and refresh token are secrets.

### Brand pack

Phase 1: **one** brand, X only: **21 gifts**. The brand slug is configuration (`BRAND`), the pack lives at `content/<brand>/` **in the image**. `rules.json` is not part of this repository; the build adds it from a private source. Missing `rules.json` → submit 409 and health `ok: false`.

Blocking: forbidden claims, MiCAR-unsafe wording, and provisional parameters without a qualifier. No LLM. Pack updates = new image.

---

## HTTP API

**Health (no JWT):** HTTP 200 if the process is up.

```
{ "ok": bool, "queueRunning": bool, "probes": { "x": "ok"|"bad", "jwt": "ok"|"bad" } }
```

`ok` is true only when every probe is ok. `x=bad`: no successful users/me probe yet (also while the service starts), the probe failed or the handle does not match, or a refresh needed a new login. `jwt=bad` only when the JWT secret is unset (not a drift detector).

| Route | Role | Effect |
|---|---|---|
| `GET /api/me` | OUTBOX or ADMIN | `{ account, user, role }` from payload |
| `POST /api/review` | OUTBOX | findings |
| `POST /api/submit` | OUTBOX | bundle; 409 on blocking / past time / bad image |
| `GET /api/posts` | Admin → all; else Outbox → `authoredBy.account === payload.account`; else 403 | status list |
| `POST /api/bundles/:id/retract` | OUTBOX, authoredBy | Phase 1: one entry per bundle. 409 unless every entry is `submitted`; then CAS all to `retracted` |
| `GET /review/:id` | same visibility as `GET /api/posts` | `:id` is the **bundle** id. GET, no side effect; no token in the query |
| `GET /posts` | OUTBOX or ADMIN | HTML status overview; authors see their own, approvers see all |
| `GET /media/:sha256` | OUTBOX or ADMIN | Image bytes only when a visible entry references the image |
| `POST /review/:id/decide` | ADMIN | `:id` is the bundle id. Body `{ decision: "approve"\|"reject", comment?: string }` for that bundle's single entry (phase 1). The optional comment is trimmed, limited to 1000 characters, stored as `decisionComment`, and shown to everyone who can see the entry on Review and Posts and in the JSON post views. CAS `submitted → approved\|rejected`. Queue insert **only** on `approve`, same transaction. Retract vs decide: one winner. Repeat 409. |
| `POST /api/posts/:id/retry` | ADMIN | CAS `WHERE id=? AND status='failed'` → `pending`; unknown id 404, else 409 |
| `POST /api/posts/:id/resolve-uncertain` | ADMIN | `{ resolution: "sent"\|"failed", url? }`. CAS `WHERE id=? AND status='uncertain'`; unknown id 404, else 409 |

No `/api/publish`, `/api/schedule`, `/now`.

`PublishResult`: `{ channel, ok, url?, error?, uncertain? }`. Phase 1 `channel: 'x'`.

Logs: denylist `Authorization`, Cookie, Bearer. No JWT in HTML.

---

## Configuration

Environment variables, read once at start. A missing or invalid required variable stops the process with its **name** (never its value).

| Variable | Required | Default | Meaning |
|---|---|---|---|
| `DB_PATH` | yes | image: `/data/outbox.sqlite` | SQLite file on durable storage |
| `BRAND` | yes | — | Brand slug; the pack is `<PACK_ROOT>/content/<BRAND>/rules.json` |
| `PACK_ROOT` | no | `.` (image: `/app`) | Directory that **contains** `content/` |
| `PORT` | no | `3000` | HTTP port |
| `DFX_API_BASE_URL` | yes | — | DFX API for introspection |
| `OUTBOX_PUBLIC_URL` | yes | — | Public Outbox URL without a trailing slash; used for the mail callback |
| `JWT_SECRET` | no | — | Same HS256 secret as the DFX API; unset → health `jwt: bad` |
| `X_CLIENT_ID` | yes | — | X OAuth 2.0 client id |
| `X_CLIENT_SECRET` | no | — | Confidential clients only; sent as Basic auth on refresh |
| `X_REFRESH_TOKEN` | no | — | Seed for the stored refresh token, see below |
| `X_HANDLE` | yes | — | Account the boot probe expects (leading `@` optional) |
| `X_MAX_WEIGHTED_LENGTH` | no | `25000` | Maximum X weighted length; set to `280` for accounts without Premium |
| `X_API_BASE` | no | `https://api.x.com` | X API base |

**Refresh token.** X refresh tokens are treated as single-use: every refresh stores the new pair in `x_credentials` before the access token is used. `X_REFRESH_TOKEN` only seeds that row. The same value on a later start changes nothing; a **different** value replaces the stored token. After a lost rotation (`needs-login` alert), authorize again, set the new refresh token, and restart.

Create the initial token with `npm run x:authorize -- --env /path/to/x.env`. The file must have mode 600 and contain `X_CLIENT_ID`, `X_CLIENT_SECRET`, and `X_HANDLE`. The default path is `~/.config/outbox-e2e/x.env`; register `http://127.0.0.1:8765/callback` as the X OAuth callback.

**Container.** The rule list `content/<brand>/rules.json` is not in this repository; the build places it in the context before `docker build`. A running publish has a 90 s budget, so the deployment needs a stop grace of at least 100 s.

## End-to-end test

The test starts Outbox as a process with a fresh database and uses a local DFX API plus a dedicated X test account. In a checkout of the DFX API containing the Outbox introspection endpoints, run `npm install`, `cp .env.local.example .env`, start PostgreSQL, and run `npm run setup`. Set `DFX_BACKEND_DIR` to that checkout. The harness reads its `.env` and `api.log`; keep both private. The database must be local and `psql` must be installed. `DFX_API_BASE_URL` defaults to `http://localhost:3000`.

The browser-form station uses the handbook's isolated Playwright installation and Chromium. Install them with `npm install --prefix ./_handbook-deps --no-save playwright@1.61.1` and `./_handbook-deps/node_modules/.bin/playwright install chromium`. Missing Playwright or Chromium makes the run exit 3 before starting Outbox.

Create an X test-account refresh token with `npm run x:authorize` and store `X_CLIENT_ID`, `X_CLIENT_SECRET`, `X_HANDLE`, and `X_REFRESH_TOKEN` in a mode-600 file. `OUTBOX_E2E_X_ENV` overrides the default `~/.config/outbox-e2e/x.env`. `OUTBOX_E2E_PORT` defaults to 8080. Run:

```sh
npm run test:e2e
```

Allow approximately 10–15 minutes for the five-minute publishing slots. Exit 0 means all stations passed; 1 means a station failed; 3 means a prerequisite or X account was missing. With only X missing the local sign-in, composition, approval and rejection stations still run, but publishing is not tested. `e2e-run.json` records the commits, dirty state, station results, and public URLs. The X refresh token is written back to the private environment file after the run, including failures.

What is not real:

- The DFX `/mail-login` page is not opened in a browser; its redirect API call is made directly, so a green run does not prove that page works.
- The setup admin's missing verified name is set directly in local PostgreSQL; a green run does not prove the admin onboarding path supplies it.
- The approver wallet signs with ethers rather than a browser wallet; a green run does not prove browser-wallet integration.
- For resolve, a transport proxy drops one real X response after forwarding the request; a green run does not prove the production network will fail in the same way.

---

## Data model

SQLite WAL. Tables: bundles, entries, scheduled_posts, publish_results, audit, media, x_credentials (the X OAuth token pair; the refresh token is stored at rest because it rotates). There is no `drafts` table.

Pending mail sessions are stored in `auth_pending` for at most ten minutes and removed after use. Audit rows distinguish `actorKind = 'user'` with numeric JWT IDs from `actorKind = 'system'` with null IDs.

Phase 1: **one entry per bundle**. `GET`/`POST /review/:id` uses the bundle id. `media` stores deduplicated PNG/JPEG bytes by SHA-256.

Bundles and scheduled_posts store `authoredByUser` + `authoredByAccount` (JWT `user` / `account` at submit). Entry state: `submitted | retracted | approved | rejected`. Submit creates `submitted`. Retract/decide are compare-and-set `WHERE state='submitted'` in `BEGIN IMMEDIATE`. Retract 409 unless every entry on the bundle is still `submitted`. `approved` writes `scheduled_posts` with `status='pending'` and `channel='x'` in the same transaction. `decidedByUser` / `decidedByAccount` and optional `decisionComment` are stored on approve/reject.

---

## Security

| Threat | Mitigation |
|---|---|
| Stolen JWT | HS256; short TTL; introspect on every authenticated route |
| Wrong role | `hasRoleAccess`; ACCOUNT token is not enough |
| Outbox without TOTP | mail-origin `tfaRequired` **and** DFX TFA interceptor 200 (completed TOTP). Claim presence alone is not enough. |
| Publish without approval | no endpoint; no DOM control; tests |
| Double post on X | no auto-retry after accepted tweet; retry only `failed`; `uncertain` not requeued |
| Token in logs | denylist |
| Cross-origin cookie POST | Origin or Referer must match the host; `Origin: null` is rejected. `Referrer-Policy: same-origin` keeps cross-origin referrers private while allowing same-origin forms. |

---

## Phase 1 done

1. JWT login with `OUTBOX` after the DFX API role PR.
2. One brand, X only.
3. One real post on the **test** account, status `sent` with permalink.
4. Queue insert only via Admin decide. GET does not mutate. No publish-now in the DOM.
5. Blocking review → 409. Missing `rules.json` → 409 / `ok: false`.
6. Failure drill → `failed` or `uncertain` plus an ops alert.
7. Retry does not retry `uncertain`.
8. Boot probe `GET /2/users/me` matches the configured handle.

## Handbook

The operator handbook covers the composer, review states, and service responses. See [docs/handbook/README.md](docs/handbook/README.md) for coverage, regeneration, and content checks.

---

## Implementation plan

| PR | What |
|---|---|
| DFX API B1 | `UserRole.OUTBOX` in enum, `StaffRoles`, `KycGatedRoles`, `additionalRoles`, redirect allowlist for Outbox callback and tfa-complete |
| DFX API B2 | `GET /v1/auth/introspect/outbox` and `/admin` |
| A1 | Scaffold, `content/dfx/`, review engine, status types, CI |
| A2 | SSR composer, cookie/Bearer = DFX JWT, submit/approve, **no** publish-now |
| A3 | X publisher, serial queue, retry/resolve, boot probe, SIGTERM |
| A-img | Dockerfile |
| A4 | Gates: queue only via Admin decide; GET without mutation; empty X OAuth → healthz 200 `ok:false`; Outbox compose until introspect 200 (TOTP completed) → 403; retry only `failed` |

Deploy compose, secrets, and monitors are **not** this repository.

Feature work lands on **develop** via pull request. A push to `develop` opens a release PR onto **main** when none is already open and `develop` is ahead of `main`. Pull requests into **main** must come from this repository's `develop`.

---

## Open questions

1. Approvers without full Admin? Default no. If yes: a userData-id allowlist in the DFX API, not email.

Not open: phase-1 brand (21 gifts), role name (`UserRole.OUTBOX`), Access emails as login.
