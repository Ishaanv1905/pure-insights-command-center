#!/usr/bin/env node
// Sends hand-made edge-case readings to a RUNNING server and checks each response.
// These cover situations the CSV does not test cleanly (exact threshold, bad types,
// wrong key, duplicates...). Exits with code 1 if any expectation fails.
//
// Usage: node edgeCases.js [--url http://localhost:3000] [--api-key dev-ingest-key]

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : args[i + 1];
};
const URL_BASE = arg('--url', 'http://localhost:3000').replace(/\/$/, '');
const API_KEY = arg('--api-key', process.env.INGEST_API_KEY ?? 'dev-ingest-key');
const RUN = Date.now();

const base = {
  report_id: `RPT_EDGE_${RUN}`,
  report_name: 'Edge Case Report',
  owner_email: 'owner@company.com',
  last_refresh_status: 'SUCCESS',
  monthly_active_views: 100,
  snowflake_credits_consumed: 10,
  avg_load_time_sec: 5,
  aws_hosting_cost_usd: 20,
  query_count_last_30d: 300,
  concurrent_user_peak: 4,
};

const cases = [
  { name: 'clean reading', body: base, status: 201, flags: [] },
  {
    name: 'exactly 15.0s is NOT high latency (rule is "exceeds")',
    body: { ...base, avg_load_time_sec: 15 },
    status: 201,
    flags: [],
  },
  { name: '15.1s is high latency', body: { ...base, avg_load_time_sec: 15.1 }, status: 201, flags: ['HIGH_LATENCY'] },
  { name: '55s spike is high latency', body: { ...base, avg_load_time_sec: 55 }, status: 201, flags: ['HIGH_LATENCY'] },
  { name: 'owner "nan" is orphaned', body: { ...base, owner_email: 'nan' }, status: 201, flags: ['ORPHANED'] },
  {
    name: 'owner "ORPHANED_REPORT" is orphaned',
    body: { ...base, owner_email: 'ORPHANED_REPORT' },
    status: 201,
    flags: ['ORPHANED'],
  },
  {
    name: 'owner missing entirely is orphaned',
    body: { ...base, owner_email: undefined },
    status: 201,
    flags: ['ORPHANED'],
  },
  {
    name: 'negative credits are flagged, not rejected',
    body: { ...base, snowflake_credits_consumed: -13.6 },
    status: 201,
    flags: ['NEGATIVE_CREDITS'],
  },
  { name: 'zero views flagged', body: { ...base, monthly_active_views: 0 }, status: 201, flags: ['ZERO_VIEWS'] },
  {
    name: 'TIMED_OUT counts as refresh failure',
    body: { ...base, last_refresh_status: 'TIMED_OUT' },
    status: 201,
    flags: ['REFRESH_FAILED'],
  },
  {
    name: 'UNKNOWN status is a warning flag',
    body: { ...base, last_refresh_status: 'UNKNOWN' },
    status: 201,
    flags: ['REFRESH_UNKNOWN'],
  },
  { name: 'brand-new report_id is accepted', body: { ...base, report_id: `RPT_NEW_${RUN}` }, status: 201, flags: [] },
  { name: 'missing report_id is rejected', body: { ...base, report_id: undefined }, status: 400 },
  { name: 'numeric field sent as text is rejected', body: { ...base, avg_load_time_sec: '17.8' }, status: 400 },
  { name: 'unknown refresh status is rejected', body: { ...base, last_refresh_status: 'BROKEN' }, status: 400 },
  { name: 'fractional view count is rejected', body: { ...base, monthly_active_views: 10.5 }, status: 400 },
  { name: 'array body is rejected', body: [base], status: 400 },
  { name: 'wrong API key is refused', body: base, status: 401, apiKey: 'wrong-key' },
  { name: 'same idempotency key twice: first stored', body: base, status: 201, flags: [], idem: `edge-${RUN}` },
  { name: 'same idempotency key twice: second is a duplicate', body: base, status: 200, idem: `edge-${RUN}` },
];

let failures = 0;
for (const c of cases) {
  const headers = { 'content-type': 'application/json', 'x-api-key': c.apiKey ?? API_KEY };
  if (c.idem) headers['idempotency-key'] = c.idem;
  const res = await fetch(`${URL_BASE}/api/ingest`, { method: 'POST', headers, body: JSON.stringify(c.body) });
  const json = await res.json().catch(() => ({}));
  const problems = [];
  if (res.status !== c.status) problems.push(`status ${res.status}, expected ${c.status}`);
  if (c.flags && res.status === 201) {
    const got = [...(json.flags ?? [])].sort().join(',');
    const want = [...c.flags].sort().join(',');
    if (got !== want) problems.push(`flags [${got}], expected [${want}]`);
  }
  if (problems.length) failures++;
  const detail = res.status === 400 ? `  -> ${(json.error?.details ?? []).join('; ')}` : '';
  console.log(
    `${problems.length ? 'FAIL' : 'PASS'}  ${c.name}${problems.length ? '  (' + problems.join('; ') + ')' : ''}${detail}`,
  );
}

console.log(`\n${cases.length - failures}/${cases.length} edge cases behaved as expected`);
process.exit(failures ? 1 : 0);
