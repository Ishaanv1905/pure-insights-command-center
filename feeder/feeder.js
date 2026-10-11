#!/usr/bin/env node
// Feeder: replays the case-study CSV into the server, one reading at a time,
// as if a real monitoring agent were sending telemetry.
//
// It is deliberately "dumb": it converts CSV text to JSON types and sends rows
// AS THEY ARE, including the dirty ones (missing owners, negative credits).
// All validation and flagging is the server's job - that is what we are testing.
//
// Usage: node feeder.js [options]
//   --file <path>        CSV to replay        (default: ../data/Case_Study_3_Pure_Insights_Monitoring.csv)
//   --url <url>          server base URL      (default: http://localhost:3000)
//   --api-key <key>      ingest API key       (default: $INGEST_API_KEY or dev-ingest-key)
//   --interval <ms>      delay between sends  (default: 500)
//   --start <n>          first row index      (default: 0)
//   --limit <n>          max rows to send     (default: all)
//   --batch <n>          send n rows per request to /api/ingest/batch (default: 1 = single endpoint)
//   --loop               start again from the top when the file ends
//   --run-id <id>        prefix for idempotency keys (default: current timestamp)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCsv } from './csv.js';

const here = path.dirname(fileURLToPath(import.meta.url));

const INTEGER_COLUMNS = ['monthly_active_views', 'query_count_last_30d', 'concurrent_user_peak'];
const DECIMAL_COLUMNS = ['snowflake_credits_consumed', 'avg_load_time_sec', 'aws_hosting_cost_usd'];

function parseArgs(argv) {
  const opts = {
    file: path.resolve(here, '..', 'data', 'Case_Study_3_Pure_Insights_Monitoring.csv'),
    url: 'http://localhost:3000',
    apiKey: process.env.INGEST_API_KEY ?? 'dev-ingest-key',
    interval: 500,
    start: 0,
    limit: Infinity,
    batch: 1,
    loop: false,
    runId: String(Date.now()),
  };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i];
    switch (arg) {
      case '--file':
        opts.file = path.resolve(next());
        break;
      case '--url':
        opts.url = next().replace(/\/$/, '');
        break;
      case '--api-key':
        opts.apiKey = next();
        break;
      case '--interval':
        opts.interval = Number(next());
        break;
      case '--start':
        opts.start = Number(next());
        break;
      case '--limit':
        opts.limit = Number(next());
        break;
      case '--batch':
        opts.batch = Number(next());
        break;
      case '--loop':
        opts.loop = true;
        break;
      case '--run-id':
        opts.runId = next();
        break;
      case '--help':
        console.log(
          fs
            .readFileSync(fileURLToPath(import.meta.url), 'utf8')
            .split('\n')
            .slice(1, 22)
            .join('\n'),
        );
        process.exit(0);
        break;
      default:
        console.error(`Unknown option ${arg} (use --help)`);
        process.exit(2);
    }
  }
  return opts;
}

/** CSV text -> JSON types. Empty numeric cells become null (the server will reject them). */
export function rowToReading(row) {
  const reading = {
    report_id: row.report_id,
    report_name: row.report_name || undefined,
    owner_email: row.owner_email === '' ? null : row.owner_email, // "nan" / "ORPHANED_REPORT" sent as-is
    last_refresh_status: row.last_refresh_status,
  };
  for (const col of [...INTEGER_COLUMNS, ...DECIMAL_COLUMNS]) {
    reading[col] = row[col] === '' || row[col] === undefined ? null : Number(row[col]);
  }
  return reading;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** POST with retries on network errors and 5xx (never on 4xx: the request itself is wrong). */
async function post(url, body, headers, attempts = 4) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
      });
      const json = await res.json().catch(() => ({}));
      if (res.status >= 500 && attempt < attempts) throw new Error(`HTTP ${res.status}`);
      return { status: res.status, json };
    } catch (err) {
      if (attempt >= attempts) return { status: 0, json: { error: { message: err.message } } };
      const backoff = 250 * 2 ** (attempt - 1);
      console.warn(`  retry ${attempt}/${attempts - 1} in ${backoff}ms (${err.message})`);
      await sleep(backoff);
    }
  }
}

async function main() {
  const opts = parseArgs(process.argv);
  const rows = parseCsv(fs.readFileSync(opts.file, 'utf8'));
  const end = Math.min(rows.length, opts.start + opts.limit);
  console.log(
    `Feeding ${end - opts.start} of ${rows.length} rows from ${path.basename(opts.file)} to ${opts.url} (interval ${opts.interval}ms, batch ${opts.batch})`,
  );

  const stats = { created: 0, duplicate: 0, rejected: 0, failed: 0, alerts: 0 };
  let stopping = false;
  process.on('SIGINT', () => {
    stopping = true;
  });

  let pass = 0;
  do {
    for (let i = opts.start; i < end && !stopping; i += opts.batch) {
      const slice = rows.slice(i, Math.min(i + opts.batch, end));
      const keyFor = (index) => `${opts.runId}-p${pass}-row-${index}`;

      if (opts.batch === 1) {
        const reading = rowToReading(slice[0]);
        const { status, json } = await post(`${opts.url}/api/ingest`, reading, {
          'x-api-key': opts.apiKey,
          'idempotency-key': keyFor(i),
        });
        if (status === 201) {
          stats.created++;
          const alertActions = (json.alert_actions ?? []).filter((a) => a.type === 'create');
          stats.alerts += alertActions.length;
          const flags = json.flags?.length ? json.flags.join(',') : 'clean';
          const alertText = alertActions.length ? `  ALERT: ${alertActions.map((a) => a.rule).join(', ')}` : '';
          console.log(`[${i}] 201 ${reading.report_id} ${flags}${alertText}`);
        } else if (status === 200) {
          stats.duplicate++;
          console.log(`[${i}] 200 duplicate (already ingested)`);
        } else if (status === 400) {
          stats.rejected++;
          console.log(`[${i}] 400 rejected: ${JSON.stringify(json.error?.details ?? json.error)}`);
        } else {
          stats.failed++;
          console.log(`[${i}] ${status} ${JSON.stringify(json.error ?? json)}`);
          if (status === 401) {
            console.error('API key rejected - stopping.');
            process.exit(1);
          }
        }
      } else {
        const body = slice.map((row, k) => ({ ...rowToReading(row), idempotency_key: keyFor(i + k) }));
        const { status, json } = await post(`${opts.url}/api/ingest/batch`, body, { 'x-api-key': opts.apiKey });
        if (status !== 200) {
          stats.failed += slice.length;
          console.log(`[${i}..${i + slice.length - 1}] ${status} ${JSON.stringify(json.error ?? json)}`);
          if (status === 401) process.exit(1);
        } else {
          for (const r of json.results) {
            if (r.status === 'rejected') stats.rejected++;
            else if (r.duplicate) stats.duplicate++;
            else {
              stats.created++;
              stats.alerts += (r.alert_actions ?? []).filter((a) => a.type === 'create').length;
            }
          }
          console.log(`[${i}..${i + slice.length - 1}] batch accepted=${json.accepted} rejected=${json.rejected}`);
        }
      }
      if (opts.interval > 0) await sleep(opts.interval);
    }
    pass++;
  } while (opts.loop && !stopping);

  console.log(
    `\nDone. created=${stats.created} duplicate=${stats.duplicate} rejected=${stats.rejected} failed=${stats.failed} alerts_raised=${stats.alerts}`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
