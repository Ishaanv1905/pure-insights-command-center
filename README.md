# Pure Insights Command Center

An admin dashboard for the custom analytics portal that replaced Tableau Server: it monitors report health, finds orphaned reports, raises **real-time alerts** when a report is slow (over 15s) or its refresh fails, and attributes cost per report and per view.

Case Study 3: Tasks 1 and 2 (full-stack app + real-time alerting) and Task 3 (Snowflake cost allocation SQL suite, in [`snowflake/`](snowflake/README.md)).

**Task 3 contents of this case study are in the Snowflake folder. It includes the simulated snowflake data, sql queries for cloud credit consumption, and the results.**

| Part     | Stack                                                                                                                    |
| -------- | ------------------------------------------------------------------------------------------------------------------------ |
| Backend  | Node.js 22, Express 5, SQLite (Node's built-in `node:sqlite`, no native build), `ws` WebSockets, JWT cookie auth, bcrypt |
| Frontend | React 19, React Router, Vite                                                                                             |
| Feeder   | Plain Node script that replays the case-study CSV into the API                                                           |
| Tests    | Node's built-in test runner + supertest (153 tests, 97% line coverage); ESLint, Prettier and GitHub Actions CI           |

## What it does

- **Ingestion API** (`POST /api/ingest`, API key): validates each reading, rejects malformed ones (400, kept for review), **flags** dirty-but-valid data (orphaned owner, negative credits, high latency, failed/unknown refresh, zero views) and stores both history and current state.
- **Real-time alerts** over WebSocket: a new alert when a report goes from healthy to breached, resolution when it recovers, and a cooldown so a flapping report reopens its alert instead of spamming new ones. On the provided data at the default replay speed, 2,054 breaching readings become about 230 alerts (about 89% less noise), and every broken report always has exactly one open alert.
- **Cost vs usage mismatches** (defect d): every reading's AWS cost per active view and per peak user is checked against outlier fences learned from the data; 148 out-of-line readings across 76 reports are listed with their direction (high cost / low usage, low cost / high usage, cost with no views).
- **RBAC** with three roles (viewer, analyst, admin), enforced on the server per permission, for REST and for WebSocket events. Logout revokes the session on the server.
- **Dashboard pages:** Overview, Reports (filter, sort, search), Report detail (raw reading history), Orphaned view inside Reports (admins can assign owners), Alerts (live feed + acknowledge), Cost, Data quality, Users.

## Quick start

**Requirements:** Node.js **22.13 or newer** (check with `node -v`; Node 22 LTS or 24 LTS recommended, Node 20 is end-of-life and not supported). With nvm, `nvm use` picks the version from `.nvmrc`. Every npm script checks the version first and explains how to upgrade if it is too old. Nothing else is needed: the database is SQLite built into Node, stored in a file created automatically, and no package needs compiling.

```bash
# 1. Install dependencies for server and client
npm run setup

# 2. Build the React app (the server will serve it)
npm run build

# 3. Start the server  ->  http://localhost:3000
npm start
```

Open **http://localhost:3000** and sign in with a demo account (also offered as buttons on the login page):

| Role    | Email                        | Password       | Can                                              |
| ------- | ---------------------------- | -------------- | ------------------------------------------------ |
| admin   | `admin@pureinsights.local`   | `Admin#2026`   | everything, assign owners, manage users          |
| analyst | `analyst@pureinsights.local` | `Analyst#2026` | read all, acknowledge alerts, cost, data quality |
| viewer  | `viewer@pureinsights.local`  | `Viewer#2026`  | read-only overview, reports, orphaned, alerts    |

```bash
# 4. In a second terminal, stream the CSV into the app (one reading every 0.5s)
npm run feed
```

Keep the Alerts page open while the feeder runs: alerts pop up as toasts and appear in the live feed without refreshing. The dot in the top bar shows the WebSocket status.

Want all 2,000 rows at once instead? `npm run feed:fast` (batches of 100, no delay).

### Development mode (hot reload)

```bash
npm run dev:server     # terminal 1: API on :3000, restarts on file changes
npm run dev:client     # terminal 2: React on http://localhost:5173 (proxies /api and /ws to :3000)
npm run feed           # terminal 3
```

### With Docker (optional)

```bash
docker compose up --build      # app on http://localhost:3000, a feeder container replays the CSV
```

The Docker files are provided for convenience but were not tested in the build environment. The compose file runs in production mode with demo secrets and demo users, so use it for local demos only.

## Putting it on GitHub

The deliverable is a GitHub repository. From the project folder:

```bash
git init
git add .
git commit -m "Pure Insights Command Center: backend, real-time alerts, dashboard, docs"
git branch -M main
git remote add origin https://github.com/<you>/pure-insights-command-center.git
git push -u origin main
```

`.gitignore` already excludes `node_modules`, the database and the client build. The workflow in `.github/workflows/ci.yml` then runs lint, formatting, tests with coverage and the build on Node 22 and 24 for every push.

## How to test it

| Command                                 | What it checks                                                                                                                                                                                                                                                                                                                               |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm test`                              | 153 automated tests: validation rules, alert state machine, cost math, cost vs usage outliers, permissions, every API status code, the 27-cell RBAC matrix, WebSocket auth, delivery, logout and crash resistance, and a **full replay of the 2,000-row CSV** that asserts every planted defect count against independently computed numbers |
| `npm run test:coverage`                 | the same tests with a coverage report (about 97% of server lines)                                                                                                                                                                                                                                                                            |
| `npm run lint` / `npm run format:check` | ESLint and Prettier over server, client and feeder                                                                                                                                                                                                                                                                                           |
| `npm run check`                         | everything CI runs: lint, format check, tests, client build                                                                                                                                                                                                                                                                                  |
| `npm run edge-cases`                    | With the server running: sends 20 hand-made readings (exactly 15.0s, `nan` owner, negative credits, text instead of number, wrong API key, duplicate idempotency key...) and prints PASS/FAIL for each                                                                                                                                       |
| `npm run data-quality`                  | Profiles the raw CSV and regenerates `docs/data-quality.md`                                                                                                                                                                                                                                                                                  |

### Try the API by hand

```bash
# Ingest one reading (the same thing the feeder does)
curl -i -X POST http://localhost:3000/api/ingest \
  -H "Content-Type: application/json" -H "x-api-key: dev-ingest-key" \
  -d '{"report_id":"RPT_203","owner_email":"nan","last_refresh_status":"TIMED_OUT","monthly_active_views":706,"snowflake_credits_consumed":74.59,"avg_load_time_sec":17.8,"aws_hosting_cost_usd":164.0,"query_count_last_30d":5626,"concurrent_user_peak":130}'

# Log in, then call a protected endpoint with the cookie
curl -s -c cookies.txt -H "Content-Type: application/json" \
  -d '{"email":"analyst@pureinsights.local","password":"Analyst#2026"}' http://localhost:3000/api/auth/login
curl -s -b cookies.txt "http://localhost:3000/api/alerts?status=active&limit=5"
curl -s -b cookies.txt http://localhost:3000/api/health/summary
```

Then break things on purpose: remove `report_id`, send `"17.8"` as a string, use a wrong key, call `/api/cost` as the viewer. Each gives a clear 400 / 401 / 403.

### A 5-minute demo script

1. Log in as **analyst**, open **Alerts**, run `npm run feed`. Watch toasts and the live feed (new, escalated, reopened, resolved).
2. Click **Acknowledge** on an alert; the live feed shows who acknowledged it.
3. **Overview**: health cards, active alerts, and "alert noise avoided".
4. **Data quality**: every planted defect with counts and how it is handled; views vs AWS cost correlation is about 0.
5. **Cost**: cost per view by report, with negative-credit readings excluded.
6. Log in as **admin**, open **Reports** and switch to **Orphaned**, assign an owner: the report leaves the list and stays assigned when new data arrives.
7. Log in as **viewer**: only four pages, no Acknowledge buttons, and `/api/cost` returns 403.

## Configuration

All settings have development defaults. To change them, copy `server/.env.example` to `server/.env`. The most useful ones:

| Variable                | Default                        | Meaning                                             |
| ----------------------- | ------------------------------ | --------------------------------------------------- |
| `PORT`                  | 3000                           | HTTP and WebSocket port                             |
| `INGEST_API_KEY`        | `dev-ingest-key`               | key the feeder must send                            |
| `LATENCY_THRESHOLD_SEC` | 15                             | alert when load time is strictly greater            |
| `LATENCY_CRITICAL_SEC`  | 30                             | above this, latency alerts are critical             |
| `ALERT_COOLDOWN_SEC`    | 300                            | re-breach within this window reopens the last alert |
| `CREDIT_PRICE_USD`      | 3.0                            | assumed dollar price of one Snowflake credit        |
| `DATABASE_PATH`         | `server/data/pure-insights.db` | delete this file to start fresh                     |

With `NODE_ENV=production`, `JWT_SECRET` and `INGEST_API_KEY` are required and demo users are not created.

## Colour key

Colour always means the same thing across the dashboard: red = broken now, amber = degraded, green = healthy or resolved, violet = a problem with the data rather than the system (orphaned, negative credits, cost vs usage mismatches), grey = unknown or informational, teal = clickable. The full table of every value and its colour is in [`docs/ui-colour-key.md`](docs/ui-colour-key.md), and the same key opens in the app from the **Colour key** button in the navigation bar.

## Documentation

| File                                                                       | Contents                                                                             |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| [`docs/api-spec.md`](docs/api-spec.md)                                     | REST API and WebSocket specification (deliverable 2)                                 |
| [`docs/architecture-and-decisions.md`](docs/architecture-and-decisions.md) | architecture, every design decision with alternatives, known limits and scaling path |
| [`docs/ui-colour-key.md`](docs/ui-colour-key.md)                           | what every colour means, badge grammar, where the mapping lives in the code          |
| [`docs/data-quality.md`](docs/data-quality.md)                             | each planted defect, rows affected and how it is handled (generated)                 |

## Project structure

```
server/   Express API: config, db (schema.sql), repositories (SQL), services (logic),
          routes, middleware, ws (WebSocket hub), tests/ (unit + integration)
client/   React app: api client, auth + realtime contexts, pages
feeder/   feeder.js (CSV replay), edgeCases.js (live checks), csv.js
data/     Case_Study_3_Pure_Insights_Monitoring.csv
docs/     API spec, architecture and decisions, data quality report
```

## Troubleshooting

| Problem                                                                                            | Fix                                                                                                                    |
| -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `No such built-in module: node:sqlite` or `bad option: --env-file-if-exists` / `--disable-warning` | Your Node is too old. Install Node 22 LTS (22.13+) or 24 LTS, e.g. with nvm: `nvm install 22`.                         |
| Port 3000 in use                                                                                   | `PORT=3001 npm start` (macOS/Linux) or set `PORT` in `server/.env`; run the feeder with `--url http://localhost:3001`. |
| Feeder says "API key rejected"                                                                     | The key in `server/.env` differs; run `node feeder/feeder.js --api-key <your key>`.                                    |
| Want a clean slate                                                                                 | Stop the server and delete `server/data/pure-insights.db*`.                                                            |
| Page loads but shows "Disconnected"                                                                | The server is not running, or you opened the Vite dev URL without `npm run dev:server`.                                |
