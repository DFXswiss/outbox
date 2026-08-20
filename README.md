# Outbox

Internal send queue for **approved social posts**. A person writes, a person approves, the service publishes through **official APIs**. This is not a coordinator for all outbound communications.

Phase 1 is **X (OAuth 2.0)** for one brand. Telegram, Nostr, and LinkedIn are later phases.

This repository is the Outbox **application**. Deployment config lives in the infrastructure repository, not here.

---

## Goals

1. Phase 1: publish to **X** through the official API (OAuth 2.0) for **one** brand, with a real post as proof.
2. Login is the existing DFX JWT (`api.dfx.swiss`). Compose/submit requires a new `UserRole.OUTBOX` on the user's userData (same gesture as Support/Compliance). Approve requires `UserRole.ADMIN`.
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
| Composer | DFX mail login (magic link) then existing DFX TOTP UI | `UserRole.OUTBOX` |
| Approver | Wallet `POST /v1/auth/signIn` (JSON `{ accessToken }`) | `UserRole.ADMIN` / `SUPER_ADMIN` |

Mail login does **not** elevate Admin. Approvers stay on wallet sign-in.

**Grant:** an Admin sets `User.role` on the user of the target userData (`UpdateUserInternalDto.role`), same as Support/Compliance. Put `OUTBOX` only on userData that has no other staff user (mail login picks one staff user; Support/Compliance would shadow Outbox).

**Composer login**

1. Magic link mints a staff JWT with `tfaRequired` and redirects to Outbox `/auth/callback?session=<jwt>`.
2. Callback does **not** set a working cookie. It 302s to the existing DFX TOTP UI with `session` and `returnUrl` of Outbox `/auth/tfa-complete`. Both URLs must be on the DFX API redirect allowlist.
3. TOTP UI calls `GET`/`POST /v1/auth/2fa` and `POST /v1/auth/2fa/verify`. Outbox does not rebuild TOTP.
4. After success, TOTP UI 302s to `/auth/tfa-complete?session=<jwt>`. Outbox calls `GET /v1/auth/introspect/outbox` with Bearer. Introspect **200** means the DFX TFA interceptor already accepted completed TOTP — claim presence alone is not enough. Pre-verify magic-link JWTs get **403** `tfaRequired` and no working cookie. After 200: HttpOnly working cookie, query stripped. Staff KYC failure (`verifiedName` missing) → hard error, **not** the TOTP UI.

**Approver login**

Wallet `POST /v1/auth/signIn` against the DFX API (`DFX_API_BASE_URL`). Body `accessToken` goes to Outbox `POST /auth/callback`. Outbox checks `GET /v1/auth/introspect/admin` → 200, then sets the same HttpOnly cookie.

Browser/SSR uses the cookie. Outbox always sends `Authorization: Bearer` to the DFX API. API routes accept cookie **or** Bearer.

**Checks inside Outbox**

- Verify HS256 with the **same JWT secret** as the DFX API. Mail-elevated staff tokens include `address`. Account tokens do not; they are not enough. Copy the default JWT validate branch (`address && user && account`). Outbox users need a wallet, like Support.
- `hasRoleAccess(entryRole, payload.role)` with the DFX hierarchy. Compose/submit: `OUTBOX`. Decide/retry/resolve: `ADMIN`. Admin/SuperAdmin may compose (additionalRoles).
- Audit uses JWT `user` and `account`, never a typed email.
- Introspect **every** authenticated route (HTML GET, API, mutations).
  - `GET /v1/auth/introspect/outbox`: `RoleGuard(OUTBOX)` (Admin via additionalRoles). If `payload.role === OUTBOX`: mail-origin claim `tfaRequired` **and** the DFX TFA interceptor must have passed (completed TOTP). Wallet-Outbox tokens → 403. A pre-verify magic-link JWT still carries the claim but introspect stays 403 until `2fa/verify`. Admin/SuperAdmin on this route without that claim is allowed.
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

- Plaintext, one PNG/JPEG ≤ 5 MiB, `datetime-local` as **Europe/Zurich** wall time (server parses IANA `Europe/Zurich`, not the browser zone).
- X only.
- Preview: text, optional image, character count, X pay-per-use cost hint (post 0.015 USD, post with URL 0.200 USD).
- Blocking review → submit 409.
- Submit creates an atomic bundle (text + image + time) and notifies approvers (no secrets in the URL).
- **No** “Publish now” / “Schedule” control without approval.
- Identity only from the JWT.

### Draft → queue → X

Promote in the **same SQLite transaction** as `submitted → approved` (UNIQUE on `scheduled_posts` per entry/channel). Crash before commit: no queue row. Crash after commit: same id, no second insert. That is **not** exactly-once toward X.

`contentHash` = SHA-256(text NUL scheduledAt NUL imageBytes). `scheduledAt` is epoch ms. Past time at submit → 409.

`GET /review/:id` is read-only. Decide is POST only. No share token in the query. Auth callbacks may carry a transient `?session=<jwt>` and must strip it.

```mermaid
sequenceDiagram
  participant P as Composer
  participant B as Outbox
  participant API as DFX API
  participant Q as Admin
  participant X as api.x.com
  P->>API: Mail login (redirectUri = Outbox callback)
  API-->>P: 302 /auth/callback?session=JWT
  P->>B: GET /auth/callback?session=JWT
  B-->>P: 302 DFX TOTP UI session + returnUrl
  P->>API: GET/POST /v1/auth/2fa, POST /v1/auth/2fa/verify
  API-->>P: 302 /auth/tfa-complete?session=JWT
  P->>B: GET /auth/tfa-complete?session=JWT
  B->>API: GET /v1/auth/introspect/outbox Bearer
  API-->>B: 200
  B-->>P: Set-Cookie, strip query
  Q->>API: Wallet POST /v1/auth/signIn
  API-->>Q: JSON accessToken
  Q->>B: POST /auth/callback accessToken
  B-->>Q: Set-Cookie
  P->>B: POST /api/submit Cookie
  B->>API: GET /v1/auth/introspect/outbox Bearer
  B->>B: review rules.json; create bundle
  Q->>B: POST /review/:id/decide {decision: approve or reject} Bearer
  B->>API: GET /v1/auth/introspect/admin Bearer
  alt approve
    B->>B: CAS submitted to approved; queue in same tx
  else reject
    B->>B: CAS submitted to rejected
  end
  opt queued and due
    Note over B,X: Ticker, never Decide
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

- `POST /api/posts/:id/retry` — `BEGIN IMMEDIATE` + `UPDATE … WHERE id=? AND status='failed'` → `pending`, audit, **no** synchronous X call. 0 rows → 409. Ticker takes due.
- `POST /api/posts/:id/resolve-uncertain` — `{ resolution: "sent"|"failed", url? }`. Channel comes from the row. CAS `WHERE id=? AND status='uncertain'`; else 409.

Channel status: `pending | in-flight | sent | failed | uncertain`. `PublishResult.ok` is a JSON boolean, not the status.

### X (phase 1)

- OAuth 2.0 user token against `api.x.com`.
- Scopes: `tweet.write`, `users.read`, `offline.access`, plus media upload (`media.write` or the documented scope for chunked `POST /2/media/upload`).
- `POST /2/tweets`; media chunked `POST /2/media/upload`; refresh `POST /2/oauth2/token`.
- One refresh on HTTP 401, never a second. Failed refresh → `needs-login` alert, no loop.
- No auto-retry after an accepted `POST /2/tweets`.
- Boot probe: `GET /2/users/me` username, strip a leading `@` on **both** sides, compare to configured handle. Mismatch → `probes.x=bad`, no send.
- Dev uses a **test** X account, not the brand account. Client id is config; client secret and refresh token are secrets.

### Brand pack

Phase 1: **one** brand, X only. Default recommendation **DFX** (`@DFX_Swiss`). Pack at `content/dfx/` **in the image**. Missing `rules.json` → submit 409 and health `ok: false`.

Blocking: forbidden claims, MiCAR-unsafe, provisional without qualifier. Hints: emoji, sentence length, X character count. No LLM. Pack updates = new image.

---

## HTTP API

**Health (no JWT):** HTTP 200 if the process is up.

```
{ "ok": bool, "queueRunning": bool, "probes": { "x": "ok"|"bad", "jwt": "ok"|"bad" } }
```

`ok` is true only when every probe is ok. `x=bad`: users/me mismatch. `jwt=bad` only when the JWT secret is unset (not a drift detector).

| Route | Role | Effect |
|---|---|---|
| `GET /api/me` | OUTBOX or ADMIN | `{ account, user, role }` from payload |
| `POST /api/drafts` | OUTBOX | text, image, scheduledAt (Zurich) |
| `POST /api/review` | OUTBOX | findings |
| `POST /api/submit` | OUTBOX | bundle; 409 on blocking / past time / bad image |
| `GET /api/posts` | Admin → all; else Outbox → `authoredBy.account === payload.account`; else 403 | status list |
| `POST /api/bundles/:id/retract` | OUTBOX, authoredBy | Phase 1: one entry per bundle. 409 unless every entry is `submitted`; then CAS all to `retracted` |
| `GET /review/:id` | same visibility as `GET /api/posts` | `:id` is the **bundle** id. GET, no side effect; no token in the query |
| `POST /review/:id/decide` | ADMIN | `:id` is the bundle id. Body `{ decision: "approve"\|"reject" }` for that bundle's single entry (phase 1). CAS `submitted → approved\|rejected`. Queue insert **only** on `approve`, same transaction. Retract vs decide: one winner. Repeat 409. |
| `POST /api/posts/:id/retry` | ADMIN | CAS `WHERE id=? AND status='failed'` → `pending`; else 409 |
| `POST /api/posts/:id/resolve-uncertain` | ADMIN | `{ resolution: "sent"\|"failed", url? }`. CAS `WHERE id=? AND status='uncertain'`; else 409 |

No `/api/publish`, `/api/schedule`, `/now`.

`PublishResult`: `{ channel, ok, url?, error?, uncertain? }`. Phase 1 `channel: 'x'`.

Logs: denylist `Authorization`, Cookie, Bearer. No JWT in HTML.

---

## Data model

SQLite WAL. Tables: drafts, bundles, entries, scheduled_posts, publish_results, audit, media.

Phase 1: **one entry per bundle**. `GET`/`POST /review/:id` uses the bundle id.

Bundles and scheduled_posts store `authoredByUser` + `authoredByAccount` (JWT `user` / `account` at submit). Entry state: `submitted | retracted | approved | rejected`. Submit creates `submitted`. Retract/decide are compare-and-set `WHERE state='submitted'` in `BEGIN IMMEDIATE`. Retract 409 unless every entry on the bundle is still `submitted`. `approved` writes `scheduled_posts` in the same transaction. `decidedByUser` / `decidedByAccount` only on approve/reject.

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

---

## Open questions

1. Phase-1 brand: default DFX (`@DFX_Swiss`). Alternative: zkCoins.
2. Approvers without full Admin? Default no. If yes: a userData-id allowlist in the DFX API, not email.

Not open: role name (`UserRole.OUTBOX`), Access emails as login.
