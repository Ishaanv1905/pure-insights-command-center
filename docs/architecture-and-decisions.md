# Architecture and Design Decisions

This document explains how the Command Center is built and **why**, including the alternatives that were considered. The case-study brief leaves many choices open; each one is recorded here.

## 1. The problem in one paragraph

After moving from Tableau Server to a custom portal (React, Node.js, Snowflake, AWS), the business lost admin visibility: nobody can easily see which reports are used, which fail to refresh, who owns them, or what they cost. The Command Center is a _dashboard about dashboards_: it ingests monitoring readings about ~100 reports, stores them, flags data quality problems, raises real-time alerts when a report is slow or its refresh fails, and attributes cost.

## 2. System overview

```
 CSV file ──► feeder (Node)                          any future telemetry agent
               │  POST /api/ingest  (x-api-key)             │
               ▼                                             ▼
 ┌──────────────────────────── Express server ─────────────────────────────┐
 │                                                                          │
 │  routes ──► services ──► repositories ──► SQLite                         │
 │     │         │  readingValidator (pure)      reports   (current state)  │
 │     │         │  alertEngine      (pure)      readings  (history)        │
 │     │         │  costService      (pure core) alerts, users, rejections  │
 │     │         ▼                                                          │
 │     │     event bus ──► WebSocket hub ──────────────────────┐            │
 └─────┼──────────────────────────────────────────────────────┼────────────┘
       │ REST: login, lists, actions (cookie)                  │ push: alerts, updates
       ▼                                                       ▼
                         React app in the browser
```

Two channels reach the browser: **REST for asking** ("give me the reports") and **WebSocket for being told** ("a report just broke"). The browser loads state over REST, then listens for changes.

## 3. Code layout

```
server/src/
  config/          every tunable value, read once from env vars
  db/              schema.sql + openDatabase()
  repositories/    the ONLY code that writes SQL (one file per table group)
  services/        business logic; readingValidator and alertEngine are pure functions
  routes/          thin HTTP handlers: parse request, call service, send response
  middleware/      auth (session, API key, permissions), JSON-only writes, errors, logging
  ws/              WebSocket hub (handshake auth, heartbeat, broadcast)
  lib/             errors, logger, event bus, query parsing
  container.js     composition root: builds and wires everything (dependency injection)
  app.js           builds the Express app from the container (no port opened)
  server.js        entry point: HTTP server + WebSocket + graceful shutdown
server/tests/      unit (pure logic) and integration (HTTP, WebSocket, full CSV replay)
feeder/            CSV replay client + edge-case checker (no dependencies)
client/            React (Vite) app
```

### Why layers?

| Layer        | Knows about                  | Does not know about  |
| ------------ | ---------------------------- | -------------------- |
| routes       | HTTP (req/res, status codes) | SQL, business rules  |
| services     | business rules               | HTTP, SQL            |
| repositories | SQL                          | HTTP, business rules |

If a route also contained SQL and alert rules, none of it could be tested alone and swapping the database would mean rewriting everything. Here the alert rules are a pure function tested with no server and no database, and moving to Postgres means rewriting only `repositories/`. The cost is more files, which is worth it even at this size.

### Dependency injection without a framework

`createContainer(config, { db, clock, logger })` builds every object and passes dependencies in as arguments. Tests call it with an in-memory database, a fake clock (so a 5-minute cooldown is tested instantly) and a silent logger. Nothing reads global state, so tests never interfere with each other.

## 4. The life of one reading

1. Feeder sends `POST /api/ingest` with `RPT_203, owner "nan", 17.8s, TIMED_OUT`.
2. `requireApiKey` checks the key with a constant-time comparison. Wrong key: 401.
3. Idempotency: if the `Idempotency-Key` was seen before, return the earlier result (200).
4. `processReading()` (pure) validates, normalizes (`"nan"` becomes `null`, raw text kept) and flags: `ORPHANED, HIGH_LATENCY, REFRESH_FAILED`. Malformed input: 400 and saved to `rejected_payloads`.
5. **One transaction:** upsert the report's current state, insert the reading into history, ask `decideAlertActions()` (pure) what to do, apply the actions.
6. **After commit:** publish `reading.ingested` and any `alert.*` events on the event bus.
7. The WebSocket hub forwards them to every connected browser; the toast appears and the tables refresh.

## 5. Decisions

### D1. Ingestion: push over HTTP POST, behind an API key

- **Chosen:** the data source POSTs readings to `/api/ingest`. The feeder is just one client of that contract.
- **Why:** the server does not care where data comes from. Today it is a CSV replay; in production it would be the portal's telemetry. The contract can be tested with a single `curl`.
- **Alternatives:** the server reads the CSV itself on a timer (simpler, but hides the real interface and proves nothing about the API); the server polls a source (pull) which needs the source to run a server.
- **API key, not user login:** the sender is a machine. Its credential is separate from people's sessions, can be rotated independently, and a stolen user cookie cannot write data.

### D2. Reject vs flag

- **Reject (400)** only what is structurally unusable: missing `report_id`, wrong types, unknown status, NaN, fractional counts.
- **Flag** what is valid but unusual: no owner, negative credits, slow, failed refresh, zero views.
- **Why:** orphaned and slow reports are exactly what the dashboard must show; deleting or rejecting them would hide the problems the tool exists to find. Impossible values (negative credits) are kept for audit but excluded from calculations they would corrupt.
- **The raw CSV is never edited.** Raw values are stored next to normalized ones (`owner_email_raw`).

### D3. Current state + history

- `reports` holds one row per report (latest reading) for fast dashboard reads; `readings` is append-only history.
- **Why:** the overview reads 100 rows instead of aggregating 2,000+; history still supports drill-down, data quality stats and cost averages.
- **Interpretation of the CSV:** 100 reports x 20 snapshots, round-robin. There is no timestamp, so the server stamps `received_at`.

### D4. SQLite (Node's built-in `node:sqlite`), plain SQL, no ORM

|                                | SQLite        | PostgreSQL        | Snowflake                             |
| ------------------------------ | ------------- | ----------------- | ------------------------------------- |
| Setup for a reviewer           | none (a file) | Docker or install | account                               |
| Many small writes, low latency | good          | good              | poor (built for big analytical scans) |
| Concurrent writers             | one at a time | many              | many                                  |
| Fits this assessment           | yes           | overkill to run   | wrong tool for an operational store   |

- **Driver:** Node's built-in `node:sqlite` (Node 22.13+) instead of the popular `better-sqlite3`. Both have the same synchronous API, but `better-sqlite3` is a native C++ module: when its prebuilt binary cannot be downloaded, `npm install` tries to compile it and fails on machines without build tools. That happened when this project was installed from a clean copy, so the native dependency was removed. Trade-off: `node:sqlite` is still marked experimental in Node 22, so the npm scripts pass `--disable-warning=ExperimentalWarning`; the repository layer would absorb a later switch either way. Transactions are a 10-line helper (`transaction()` in `db/database.js`: BEGIN, COMMIT, ROLLBACK on error).
- SQLite runs with WAL mode (readers do not block the writer) and foreign keys on. Plain SQL keeps every query visible and reviewable, which matters for a data role.
- Generated columns compute `effective_owner_email` and `is_orphaned` in the database, so the rule lives in one place.
- A **partial unique index** guarantees at most one active alert per report and rule, even if application code had a bug.
- **Migration path:** only `repositories/` and `db/` would change for Postgres.

### D5. Alert engine: state change + cooldown (avoiding alert fatigue)

- **Problem:** 1,490 of 2,000 readings are over 15s. Alerting on each would produce ~2,000 notifications and people would stop reading them.
- **Chosen:** each (report, rule) pair is a state machine. A notification (`alert.created`) fires only when a report goes from healthy to breached. Repeat breaches increment `occurrences` on the same alert. Recovery resolves it.
- **Cooldown:** a report that recovers and breaks again within 300s **reopens** its previous alert (quiet `alert.updated`) instead of creating a new incident.
- **A design bug caught by testing:** the first version _suppressed_ the alert during the cooldown. A full replay showed 76 slow reports but 0 active alerts, which is a dashboard that lies. The reopen approach keeps the invariant "every broken report has exactly one active alert per broken rule", and `csvReplay.test.js` now checks that invariant on the real data.
- **Result on the CSV:** 2,054 breaching readings become about 230 alerts at the default replay speed (one row every 0.5s), about 89% less noise, while active alerts always match reality. The count depends on replay speed, because the cooldown is measured in real time: replaying all rows at once gives 200, one row per second gives about 370.
- **Severity:** latency over 30s is critical; FAILED is critical, TIMED_OUT a warning. Severity can escalate, never silently downgrade while active.
- **Open points from the brief, decided here:** "exceeds 15 seconds" means strictly greater (7 rows sit at exactly 15.0s). `TIMED_OUT` counts as a failure (the refresh did not complete). `UNKNOWN` is a warning flag without an alert, because missing information is not evidence of failure.
- **UNKNOWN is undetermined, not healthy.** A rule evaluates to breached, healthy or _undetermined_. An UNKNOWN refresh status neither opens nor resolves a refresh alert: it is not evidence of failure, and it is not evidence of recovery either. (A first version treated it as healthy, so FAILED then UNKNOWN resolved the alert; the independent review caught this, and 26 such transitions exist in the CSV.)
- Thresholds are configuration, not code.

### D6. WebSocket (`ws` library) rather than SSE or polling

|                                  | Polling                | SSE              | WebSocket                                 |
| -------------------------------- | ---------------------- | ---------------- | ----------------------------------------- |
| Direction                        | client asks repeatedly | server to client | both                                      |
| Wasted requests                  | many                   | none             | none                                      |
| Auto-reconnect                   | n/a                    | built in         | written by hand                           |
| Named in the brief's deliverable |                        |                  | yes ("WebSocket Technical Specification") |

- Alerts only flow one way, so SSE would also be a clean fit. WebSocket matches the brief's deliverable and the `ws` library keeps the mechanics visible (Socket.IO adds rooms, fallbacks and its own protocol that are not needed here).
- **Handshake authentication:** the session cookie is verified during the HTTP upgrade; unauthenticated sockets are never opened. Browser connections must also come from an allowed Origin, so another website cannot open a socket with the user's cookie.
- **A socket never outlives its session:** the session is re-checked on every heartbeat, and immediately on logout or role change (the auth service publishes internal `session.revoked` / `user.updated` events that the hub acts on). An ended session is closed with code 4001 and the client goes back to login.
- **Events are permission-filtered:** each event type maps to a permission, exactly like REST routes; unknown types are never forwarded (fail closed).
- **Crash-proofing:** a malformed upgrade request or an invalid frame from one client is handled and closes only that connection (`ws.on('error')`, try/catch around the upgrade, 4 KB message limit). Both crashes were found by an independent review and are now covered by tests.
- **Missed messages:** alerts are persisted before broadcast, and the client re-fetches over REST after reconnecting.
- **Heartbeat:** ping every 30s, dead clients are terminated.
- **Event bus in between:** services publish domain events and never import WebSocket code. Scaling to several server instances means replacing the bus with Redis pub/sub; nothing else changes.

### D7. Authentication and RBAC

- **Passwords:** bcrypt (salted, deliberately slow). Login compares against a dummy hash when the email does not exist, so a wrong email and a wrong password take the same time and return the same message (no account discovery).
- **Session:** a signed JWT in an `httpOnly`, `SameSite=Strict` cookie (`Secure` in production). JavaScript cannot read it, which limits the damage of an XSS bug, and it is sent automatically on the WebSocket handshake.
- **Logout is server-side:** every token carries a unique id (`jti`). Logout stores it in `revoked_tokens` (pruned once expired), so a copied cookie stops working everywhere, and the session's WebSockets are closed. The cookie's lifetime is derived from the token's, so they always expire together.
  - Alternative: token in `localStorage` + `Authorization` header. Easier for non-browser clients, but readable by any injected script.
- **CSRF:** `SameSite=Strict` plus a rule that every write must be `application/json` (HTML forms on other sites cannot send that without a CORS preflight, which this server never approves).
- **Permissions, not role checks:** routes ask for `alerts:acknowledge`, never "is admin". The role-to-permission map lives in one file. The user is re-loaded on each request, so a role change or removal takes effect immediately rather than when the 8h token expires.
- **Roles:** viewer (read-only operations view), analyst (+ acknowledge, cost, data quality, history), admin (+ assign owners, manage users). Admins cannot change their own role, which prevents locking out the last admin.
- **Server-side enforcement is the real control.** The React app hides links and buttons for convenience only; `authRbac.test.js` checks a 27-cell matrix (9 endpoints x 3 roles) against the API directly.
- **Rate limiting** on login (20 attempts per IP per 15 minutes) and **helmet** security headers.

### D8. Orphaned reports are actionable

Listing orphaned reports is required; the app also lets an admin assign an owner. The assignment is stored separately (`assigned_owner_email`) and wins over the feed, so the next reading that still says `nan` does not undo it. The _reading_ keeps its `ORPHANED` flag (a true fact about the incoming data); the _report_ is no longer orphaned. One function (`withOwnershipFlag`) derives the report's flags from the effective owner, and both ingestion and assignment use it inside a transaction, so `is_orphaned`, the flags and the `?flag=ORPHANED` filter always agree.

### D9. In-app cost view (Task 3 is separate)

Task 3 (Snowflake `ACCOUNT_USAGE` SQL suite) is a separate deliverable. The app answers the same question from the feed it already has:

- per report, over all readings valid for cost (negative credits excluded and counted);
- **ratio of sums** for per-view figures (total cost / total views), so a zero-view month cannot divide by zero or dominate an average;
- `$3.00 per credit` is an explicit, configurable assumption;
- outlier = cost per view above 3 x the median.
  Finding on this data: hosting cost is uncorrelated with usage (r = -0.03 with views, -0.02 with peak users).

### D9b. Cost vs usage mismatches (defect d)

- **Question:** which readings and reports have an AWS cost out of line with their active users? An overall correlation proves the problem exists but names nobody, and the per-report averages are too smooth to show it.
- **Method:** for every reading valid for cost math, compute AWS cost per monthly active view and per peak concurrent user (the brief says "active user counts"; the data has both). Take logs (cost ratios are heavily skewed, and on a log scale 10x too expensive and 10x too cheap are equally far apart) and apply **Tukey fences**, Q1 - 1.5 IQR and Q3 + 1.5 IQR. Quartiles are robust: the outliers cannot drag the thresholds. A reading outside the fences is `high_cost_low_usage` or `low_cost_high_usage`; AWS cost with zero views is `cost_with_no_usage`.
- **No hard-coded dollar threshold:** the fences are learned from the data (normal is about $0.32 per view; flagged above about $4.98 or below about $0.02), and `k` is configurable.
- **Result on the CSV:** 148 of 1,976 valid readings across 76 reports (106 high cost / low usage, 38 low cost / high usage, 4 cost with no views). The test suite checks these numbers against an independent pandas calculation.
- **Where it shows:** `GET /api/cost/usage-mismatch`, the Cost page and the Data quality page. It is computed at query time rather than stored as a flag, because the fences depend on all the data, so a stored flag would go stale as data arrives.

### D10. Idempotency

Networks fail after a request is processed but before the response arrives; a retry would then store the reading twice. The optional `Idempotency-Key` header (and `idempotency_key` per batch item) is stored with a unique constraint, and a repeat returns the original result. The feeder sends `<run>-p<pass>-row-<n>` and retries 5xx and network errors with exponential backoff, but never retries a 4xx (the request itself is wrong).

### D11. Testing strategy

| Level           | What                                                                                                                                                                                                        | Why                                                       |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Unit            | validator (35 cases), alert engine state machine (including UNKNOWN), cost math and cost vs usage outliers with hand-checkable numbers, permissions, CSV parser                                             | the logic most likely to be wrong, tested in milliseconds |
| Integration     | HTTP status codes, validation errors, idempotency, batch, auth (cookie flags, forged tokens, logout), the RBAC matrix, alert lifecycle with a fake clock, owner assignment, SQL injection attempt on `sort` | proves the contract the API spec describes                |
| Real-time       | real HTTP server + `ws` client: handshake refusal, Origin check, delivery, fan-out, logout closing sockets, internal events never forwarded, malformed requests and frames not crashing the server          | WebSockets are where untested code usually breaks         |
| Data validation | full replay of the 2,000-row CSV; asserts every planted-defect count, the cost vs usage counts from an independent pandas run, and the alert invariant                                                      | if a cleaning rule changes behaviour, a test fails        |
| Live            | `feeder/edgeCases.js` against a running server (20 cases)                                                                                                                                                   | checks the deployed process, not just the code            |

153 tests, about 97% line coverage of `server/src` (`npm run test:coverage`).

### D12. Code quality tooling

- **ESLint** (flat config, React and hooks rules for the client) and **Prettier** over the whole repository; `npm run check` runs lint, format check, tests and build.
- **GitHub Actions** (`.github/workflows/ci.yml`) runs the same checks on Node 22 and 24 for every push and pull request.
- **Independent review:** before submission the backend was reviewed by a separate reviewer who had not written it. It found two server crashes, the UNKNOWN resolution bug, stale WebSocket sessions, owner flags out of sync, a 500 on repeated query parameters and a missing per-report view of defect (d). All are fixed and each has a regression test.

## 6. Known limits and what would change at scale

| Limit today                                             | Fix at scale                                                                                                                              |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| SQLite: one writer at a time, one machine               | PostgreSQL (or a managed DB); only `repositories/` changes                                                                                |
| Event bus and WebSocket client list live in one process | Redis pub/sub or a broker (Kafka, SNS/SQS) behind the same `publish/subscribe` interface; sticky sessions or a dedicated realtime service |
| Ingestion runs inside the HTTP request                  | Accept quickly, put readings on a queue, process with background workers                                                                  |
| Readings table grows forever                            | Retention policy, roll-ups (hourly/daily aggregates), partitioning                                                                        |
| Revoked tokens live in the app database                 | A shared session store (Redis) when there are several servers                                                                             |
| Rate limiter state is in memory                         | Shared store (Redis)                                                                                                                      |
| Alert notifications only in the browser                 | Email / Slack / PagerDuty channels subscribed to the same event bus                                                                       |
| Thresholds are global                                   | Per-report SLOs stored in the database                                                                                                    |

## 7. Assumptions (the brief does not specify these)

- Each CSV row is one reading of an existing report; the file is 20 snapshots of 100 reports.
- `received_at` (server time) is the reading's timestamp.
- "Exceeds 15 seconds" is `> 15`, not `>= 15`.
- `TIMED_OUT` is a refresh failure. `UNKNOWN` is undetermined: it neither raises nor clears a refresh alert.
- Negative credits are data errors, not refunds.
- 1 Snowflake credit = $3.00 (configurable).
- The three roles and their permissions.
