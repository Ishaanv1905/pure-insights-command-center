# REST API and WebSocket Specification

Pure Insights Command Center, v1. Base URL in development: `http://localhost:3000`.

## 1. Conventions

| Topic                     | Rule                                                                                                                                                                                                                   |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Format                    | JSON in, JSON out. Every `POST` / `PATCH` must send `Content-Type: application/json`, otherwise **415**.                                                                                                               |
| Time                      | ISO-8601 UTC strings, e.g. `2026-10-11T13:20:23.187Z`.                                                                                                                                                                 |
| Authentication (people)   | `POST /api/auth/login` sets an `httpOnly`, `SameSite=Strict` cookie `pi_session` holding a signed JWT (8h; the cookie expires with the token). Browsers send it automatically. Logout revokes the token on the server. |
| Authentication (machines) | The ingest endpoints use an API key in the `x-api-key` header. A user cookie is **not** accepted there, and the API key is not accepted anywhere else.                                                                 |
| Authorization             | Permission based (see section 2). Missing session: **401**. Valid session, missing permission: **403**.                                                                                                                |
| Pagination                | List endpoints take `limit` (1 to 200, default 25) and `offset` (default 0) and return `{ "items": [...], "pagination": { "total", "limit", "offset", "has_more" } }`.                                                 |
| Query parameters          | Each parameter may appear once; a repeated key (`?status=a&status=b`) is **400**.                                                                                                                                      |
| Errors                    | Always `{ "error": { "code": "...", "message": "...", "details": [...] } }`. `details` is present for validation errors. Stack traces are never returned.                                                              |

### Status codes used

| Code | Meaning here                                                                   |
| ---- | ------------------------------------------------------------------------------ |
| 200  | OK (also: a duplicate ingest with a known idempotency key)                     |
| 201  | Created (a reading was stored, a user was created)                             |
| 204  | No content (logout)                                                            |
| 400  | `VALIDATION_FAILED`, `BAD_REQUEST` or `INVALID_JSON`                           |
| 401  | `UNAUTHORIZED`: no or invalid session / API key                                |
| 403  | `FORBIDDEN`: role lacks the permission                                         |
| 404  | `NOT_FOUND`                                                                    |
| 409  | `CONFLICT`: e.g. acknowledging an alert that is not OPEN, duplicate user email |
| 413  | `PAYLOAD_TOO_LARGE` (body over 1 MB)                                           |
| 415  | `UNSUPPORTED_MEDIA_TYPE`                                                       |
| 429  | `TOO_MANY_REQUESTS` (login rate limit)                                         |
| 500  | `INTERNAL_ERROR`                                                               |

## 2. Roles and permissions

| Permission                        | viewer | analyst | admin |
| --------------------------------- | :----: | :-----: | :---: |
| `health:read`                     |  yes   |   yes   |  yes  |
| `reports:read`                    |  yes   |   yes   |  yes  |
| `alerts:read`                     |  yes   |   yes   |  yes  |
| `readings:read` (reading history) |        |   yes   |  yes  |
| `alerts:acknowledge`              |        |   yes   |  yes  |
| `cost:read`                       |        |   yes   |  yes  |
| `data-quality:read`               |        |   yes   |  yes  |
| `reports:assign-owner`            |        |         |  yes  |
| `users:manage`                    |        |         |  yes  |

Defined in one place: `server/src/services/permissions.js`. A role change takes effect on the user's next request (the user is re-loaded from the database on every request).

## 3. Ingestion (machine to machine)

### `POST /api/ingest`

Stores one monitoring reading. Header `x-api-key` is required. Optional header `Idempotency-Key` (1 to 128 chars) makes retries safe.

**Request body** (field names match the CSV columns):

| Field                        | Type                                              | Required | Notes                                                                                                  |
| ---------------------------- | ------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------ |
| `report_id`                  | string, 1 to 64 chars                             | yes      | identity of the report                                                                                 |
| `report_name`                | string                                            | no       |                                                                                                        |
| `owner_email`                | string or null                                    | no       | blank, `nan`, `null`, `none`, `ORPHANED_REPORT` (any case) mean "no owner" and set the `ORPHANED` flag |
| `last_refresh_status`        | `SUCCESS` \| `FAILED` \| `TIMED_OUT` \| `UNKNOWN` | yes      | trimmed and upper-cased before checking                                                                |
| `monthly_active_views`       | integer                                           | yes      |                                                                                                        |
| `query_count_last_30d`       | integer                                           | yes      |                                                                                                        |
| `concurrent_user_peak`       | integer                                           | yes      |                                                                                                        |
| `snowflake_credits_consumed` | number                                            | yes      | negative values are accepted and flagged                                                               |
| `avg_load_time_sec`          | number                                            | yes      |                                                                                                        |
| `aws_hosting_cost_usd`       | number                                            | yes      |                                                                                                        |

Numbers must be JSON numbers (the string `"17.8"` is rejected). Unknown fields are ignored.

```http
POST /api/ingest
x-api-key: dev-ingest-key
Idempotency-Key: run42-row-3
Content-Type: application/json

{ "report_id": "RPT_203", "report_name": "Analytics Dashboard 4", "owner_email": "nan",
  "last_refresh_status": "TIMED_OUT", "monthly_active_views": 706,
  "snowflake_credits_consumed": 74.59, "avg_load_time_sec": 17.8,
  "aws_hosting_cost_usd": 164.0, "query_count_last_30d": 5626, "concurrent_user_peak": 130 }
```

**201 Created**

```json
{
  "duplicate": false,
  "reading_id": 4,
  "report_id": "RPT_203",
  "received_at": "2026-10-11T13:20:16.271Z",
  "flags": ["ORPHANED", "HIGH_LATENCY", "REFRESH_FAILED"],
  "alert_actions": [
    { "type": "create", "rule": "HIGH_LATENCY" },
    { "type": "create", "rule": "REFRESH_FAILED" }
  ]
}
```

`alert_actions[].type` is one of `create`, `touch`, `reopen`, `resolve` (see section 6).

**200 OK** when the `Idempotency-Key` was seen before: `{ "duplicate": true, "reading_id": 4, "report_id": "RPT_203", "flags": [...] }`. Nothing new is stored.

**400 Validation failed** (all problems are listed at once; the payload is saved to `rejected_payloads` and shown on the Data Quality page):

```json
{
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "Request body failed validation",
    "details": [
      "report_id is required and must be a non-empty string",
      "avg_load_time_sec is required and must be a finite number"
    ]
  }
}
```

### Flags

| Flag               | Condition                                   | Effect                                                                                                       |
| ------------------ | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `ORPHANED`         | no usable owner                             | listed on the Orphaned page                                                                                  |
| `NEGATIVE_CREDITS` | `snowflake_credits_consumed < 0`            | excluded from cost math                                                                                      |
| `NEGATIVE_METRIC`  | any other numeric field `< 0`               | excluded from cost math                                                                                      |
| `HIGH_LATENCY`     | `avg_load_time_sec > 15` (strictly greater) | drives the latency alert                                                                                     |
| `REFRESH_FAILED`   | status `FAILED` or `TIMED_OUT`              | drives the refresh alert                                                                                     |
| `REFRESH_UNKNOWN`  | status `UNKNOWN`                            | warning only: neither opens nor resolves a refresh alert (unknown is not evidence of failure or of recovery) |
| `ZERO_VIEWS`       | `monthly_active_views == 0`                 | cost per view undefined for this reading                                                                     |

### `POST /api/ingest/batch`

Body: a JSON array of 1 to 1000 readings. Each item may carry its own `idempotency_key` field. Items are validated and stored independently (one bad item does not fail the batch).

**200 OK**

```json
{
  "accepted": 2,
  "rejected": 1,
  "results": [
    {
      "index": 0,
      "status": "accepted",
      "duplicate": false,
      "reading_id": 10,
      "report_id": "B1",
      "flags": [],
      "alert_actions": []
    },
    {
      "index": 1,
      "status": "rejected",
      "errors": ["last_refresh_status must be one of SUCCESS, FAILED, TIMED_OUT, UNKNOWN"]
    },
    {
      "index": 2,
      "status": "accepted",
      "duplicate": false,
      "reading_id": 11,
      "report_id": "B3",
      "flags": [],
      "alert_actions": []
    }
  ]
}
```

## 4. Authentication

| Method and path         | Auth                                      | Body                      | Response                                                                                                                                                                           |
| ----------------------- | ----------------------------------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/auth/login`  | none (rate limited: 20 per IP per 15 min) | `{ "email", "password" }` | 200 `{ "user": { "id", "email", "role", "permissions": [...] } }` and sets the cookie. 401 for a wrong email **or** password (same message, same timing).                          |
| `POST /api/auth/logout` | none                                      | `{}`                      | 204. Revokes the session server-side (its token id is stored as revoked, so a copied cookie stops working), closes that session's WebSockets with code 4001, and clears the cookie |
| `GET /api/auth/me`      | session                                   |                           | 200 `{ "user": {...} }` or 401                                                                                                                                                     |
| `GET /api/health/live`  | none                                      |                           | 200 `{ "status": "ok" }` (liveness probe)                                                                                                                                          |

## 5. Read and admin endpoints (session required)

### Reports

| Method and path                       | Permission             | Notes                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/reports`                    | `reports:read`         | Query: `search` (id, name or owner), `status`, `flag`, `orphaned=true\|false`, `sort` (`report_id`, `report_name`, `avg_load_time_sec`, `monthly_active_views`, `snowflake_credits_consumed`, `aws_hosting_cost_usd`, `last_seen_at`), `order=asc\|desc`, `limit`, `offset`. Unknown `status` or `flag` gives 400; an unknown `sort` falls back to `report_id`. |
| `GET /api/reports/orphaned`           | `reports:read`         | Same as `?orphaned=true`.                                                                                                                                                                                                                                                                                                                                       |
| `GET /api/reports/:reportId`          | `reports:read`         | 404 if unknown.                                                                                                                                                                                                                                                                                                                                                 |
| `GET /api/reports/:reportId/readings` | `readings:read`        | Reading history, newest first, raw values as received.                                                                                                                                                                                                                                                                                                          |
| `PATCH /api/reports/:reportId/owner`  | `reports:assign-owner` | Body `{ "owner_email": "x@company.com" }` or `{ "owner_email": null }` to clear. Publishes `report.updated`.                                                                                                                                                                                                                                                    |

**Report object**

```json
{
  "report_id": "RPT_201",
  "report_name": "Analytics Dashboard 2",
  "owner_email": null,
  "owner_source": null,
  "is_orphaned": true,
  "last_refresh_status": "TIMED_OUT",
  "monthly_active_views": 424,
  "snowflake_credits_consumed": -6.62,
  "avg_load_time_sec": 22.9,
  "aws_hosting_cost_usd": 437.21,
  "query_count_last_30d": 20281,
  "concurrent_user_peak": 103,
  "flags": ["ORPHANED", "NEGATIVE_CREDITS", "HIGH_LATENCY", "REFRESH_FAILED"],
  "reading_count": 20,
  "first_seen_at": "2026-10-11T13:20:21.901Z",
  "last_seen_at": "2026-10-11T13:20:23.179Z"
}
```

`owner_source` is `"feed"`, `"assigned"` (set by an admin, wins over the feed) or `null`. All metric fields are the **latest reading**.

**Reading object** (history): `id, report_id, received_at, owner_email_raw, owner_email, last_refresh_status`, the six metrics, `flags`.

### Alerts

| Method and path                    | Permission           | Notes                                                                                                                                                                                                                 |
| ---------------------------------- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/alerts`                  | `alerts:read`        | Query: `status` (`active` = OPEN + ACKNOWLEDGED, or `OPEN`, `ACKNOWLEDGED`, `RESOLVED`), `severity` (`warning`, `critical`), `rule` (`HIGH_LATENCY`, `REFRESH_FAILED`), `report_id`, `limit`, `offset`. Newest first. |
| `GET /api/alerts/:id`              | `alerts:read`        | 400 if `id` is not a positive integer, 404 if unknown.                                                                                                                                                                |
| `POST /api/alerts/:id/acknowledge` | `alerts:acknowledge` | Body `{}`. Only OPEN alerts (409 otherwise). Publishes `alert.updated` with `change: "acknowledged"`.                                                                                                                 |

**Alert object**

```json
{
  "id": 202,
  "report_id": "RPT_213",
  "report_name": "Analytics Dashboard 14",
  "rule": "REFRESH_FAILED",
  "severity": "critical",
  "status": "OPEN",
  "message": "RPT_213 automated refresh failed",
  "observed_value": "FAILED",
  "threshold": "status in [FAILED, TIMED_OUT]",
  "occurrences": 3,
  "reopen_count": 1,
  "trigger_reading_id": 1527,
  "created_at": "2026-10-11T13:20:23.113Z",
  "last_seen_at": "2026-10-11T13:21:40.002Z",
  "acknowledged_at": null,
  "acknowledged_by": null,
  "resolved_at": null
}
```

### Aggregates

| Method and path                | Permission          | Returns                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------ | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/health/summary`      | `health:read`       | `reports` (total, healthy, slow, failing_refresh, unknown_refresh, orphaned, avg/max load time, by_refresh_status), `alerts` (active_by_severity, by_status, incidents_created, reopened_by_cooldown, breaching_readings), `ingestion` (total_readings, rejected_payloads, last_reading_at), `realtime.connected_clients`, `thresholds`.                                                                                                                                                        |
| `GET /api/cost`                | `cost:read`         | `assumptions`, `summary`, `items[]` per report: average monthly credits / views / credit cost / AWS cost / total cost, `credits_per_view`, `aws_cost_per_view_usd`, `total_cost_per_view_usd` (null when a report has no views), `is_cost_outlier`, `valid_readings`, `excluded_readings`. Sorted most expensive per view first.                                                                                                                                                                |
| `GET /api/cost/usage-mismatch` | `cost:read`         | Defect (d). `method`, `fences_usd` (normal and flagged AWS cost per view and per peak user), `correlation` (views and peak users vs AWS cost), `summary` (readings checked and flagged, by direction, reports affected), `reports[]` (per-report counts by direction) and `readings[]` (each out-of-line reading with views, peak users, AWS cost, ratios, `direction` = `high_cost_low_usage` \| `low_cost_high_usage` \| `cost_with_no_usage`, and `times_beyond_fence`), most extreme first. |
| `GET /api/data-quality`        | `data-quality:read` | Totals, `flag_counts` (readings and reports per flag), raw values behind orphaned owners, refresh status counts, negative-credit stats, latency range, `views_vs_aws_cost_correlation` (Pearson r), `cost_usage_mismatch` (summary of the check above), `flag_handling` text, `recent_rejections`.                                                                                                                                                                                              |

### Users (admin)

| Method and path        | Body                                   | Notes                                                                     |
| ---------------------- | -------------------------------------- | ------------------------------------------------------------------------- |
| `GET /api/users`       |                                        | `{ "items": [ { "id", "email", "role", "permissions", "created_at" } ] }` |
| `POST /api/users`      | `{ "email", "password" (8+), "role" }` | 201; 400 with details; 409 duplicate email                                |
| `PATCH /api/users/:id` | `{ "role" }`                           | 400 when changing your own role (prevents locking out the last admin)     |

## 6. WebSocket: real-time events

**URL:** `ws://<host>/ws` (`wss://` behind HTTPS).

**Authentication:** the same `pi_session` cookie, checked **during the HTTP upgrade handshake**. Without a valid session the server answers `401` and never opens the socket. Any path other than `/ws` gets `404`.

**Origin check:** a browser connection must come from the server's own origin, or one listed in `ALLOWED_ORIGINS` (development default: the Vite dev server). Anything else gets `403`. Clients that send no `Origin` (scripts) still need the cookie.

**Session lifetime:** the session is re-checked on every heartbeat (30s), immediately on logout, and immediately when an admin changes the user's role. When it is no longer valid (expired, revoked, user removed) the server closes the socket with code **4001** and the client returns to the login page instead of reconnecting.

**Limits:** a client message may be at most 4 KB. A malformed frame or protocol error closes only that socket.

**Permissions:** each event type requires a permission and is only sent to clients whose role has it: `reading.ingested` and `report.updated` need `reports:read`; `alert.*` need `alerts:read`. Event types not in this list (internal ones such as `session.revoked`) are never sent.

**Close codes:** `4001` session ended (go to login), `1001` server shutting down (reconnect).

**Direction:** server to client. Every message is one JSON object:

```json
{ "type": "<event type>", "data": { ... }, "at": "2026-10-11T13:20:23.113Z" }
```

| `type`             | `data`                                                                 | When                                                                                                                        |
| ------------------ | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `hello`            | `{ "user": { "email", "role" }, "server_time" }`                       | immediately after connecting                                                                                                |
| `reading.ingested` | `{ "reading_id", "report_id", "received_at", "flags" }`                | every stored reading (clients throttle their refreshes)                                                                     |
| `alert.created`    | Alert object                                                           | a **new incident**: a rule went from healthy to breached and no alert for that report and rule resolved within the cooldown |
| `alert.updated`    | Alert object + `"change": "escalated" \| "reopened" \| "acknowledged"` | severity went up, a flapping report reopened its recent alert, or a user acknowledged it                                    |
| `alert.resolved`   | Alert object (`status: "RESOLVED"`)                                    | the report is healthy again for that rule                                                                                   |
| `report.updated`   | Report object                                                          | an admin assigned or cleared an owner                                                                                       |
| `pong`             |                                                                        | reply to a client message `{"type":"ping"}`                                                                                 |

**Alert rules** (configurable, see `server/.env.example`):

| Rule             | Breached when                  | Severity                                   |
| ---------------- | ------------------------------ | ------------------------------------------ |
| `HIGH_LATENCY`   | `avg_load_time_sec > 15`       | critical if `> 30`, else warning           |
| `REFRESH_FAILED` | status `FAILED` or `TIMED_OUT` | critical for FAILED, warning for TIMED_OUT |

**Lifecycle per report and rule:** healthy, then breach: `create` (`alert.created`). Breach again while active: `touch` (occurrences + 1; `alert.updated` only if severity rises). Healthy again: `resolve` (`alert.resolved`). A refresh status of `UNKNOWN` changes nothing (the alert stays as it is). Breach within `ALERT_COOLDOWN_SEC` (300s) of resolving: `reopen` (`alert.updated`, `change: "reopened"`). After the cooldown: a new incident.

**Guarantees:**

- Alerts are written to the database **before** they are broadcast, and only after the transaction commits.
- At most one active alert per report and rule (enforced by a partial unique index).
- The server pings every 30s and terminates clients that do not answer.

**Client responsibilities (implemented in `client/src/realtime/RealtimeContext.jsx`):** reconnect with exponential backoff (1s, 2s, 4s up to 30s); after reconnecting, re-fetch over REST to catch up on anything missed.

**Try it from a terminal:**

```bash
curl -s -c cookies.txt -H 'content-type: application/json' \
  -d '{"email":"viewer@pureinsights.local","password":"Viewer#2026"}' http://localhost:3000/api/auth/login
npx wscat -c ws://localhost:3000/ws -H "Cookie: $(awk '/pi_session/ {print $6"="$7}' cookies.txt)"
```
