import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useApi } from '../hooks/useApi.js';
import { REPORT_STATES, REFRESH_STATUS, loadTone, reportState, toneClass } from '../theme/colourKey.js';
import { Dot, ErrorBox, LoadTime, Loading, fmtAgo, fmtNum, plural, useNow } from '../components/ui.jsx';
import AlertList from './AlertList.jsx';

const LIVE = ['reading.ingested', 'alert.created', 'alert.updated', 'alert.resolved', 'report.updated'];
const ALERT_EVENTS = ['alert.created', 'alert.updated', 'alert.resolved'];

export default function OverviewPage() {
  const summary = useApi('/health/summary', { liveEvents: LIVE });
  const reports = useApi('/reports?limit=200&sort=report_id', { liveEvents: LIVE, throttleMs: 3000 });
  const critical = useApi('/alerts?status=active&severity=critical&limit=8', { liveEvents: ALERT_EVENTS });

  if (!summary.data) {
    return summary.error ? (
      <ErrorBox error={summary.error} what="load platform health" />
    ) : (
      <Loading>Loading platform health</Loading>
    );
  }
  const { reports: r, alerts, ingestion, thresholds } = summary.data;
  const items = reports.data?.items ?? [];
  const counts = countStates(items);
  const healthy = items.length ? counts.healthy : r.healthy;
  const total = items.length || r.total;
  const { critical: crit, warning: warn } = alerts.active_by_severity;
  const openTotal = crit + warn;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Platform health</h1>
          <p className="lede">
            {total === 0
              ? 'No readings yet. Start the feeder and reports appear here as their first reading arrives.'
              : `${fmtNum(healthy, 0)} of ${plural(total, 'report')} ${healthy === 1 ? 'is' : 'are'} healthy. ${
                  openTotal === 0
                    ? 'No alerts are open.'
                    : `${fmtNum(crit, 0)} critical and ${fmtNum(warn, 0)} warning ${openTotal === 1 ? 'alert is' : 'alerts are'} open.`
                }`}
          </p>
          <LastReading iso={ingestion.last_reading_at} />
        </div>
      </div>

      <div className="overview-top">
        <section className="panel" aria-labelledby="panel-title">
          <div className="panel-head">
            <div>
              <h2 id="panel-title">Report panel</h2>
              <p>One square per report, coloured by its worst current state. Select a square to open the report.</p>
            </div>
          </div>
          <div className="panel-body">
            {reports.error && !reports.data ? (
              <ErrorBox error={reports.error} what="load the report panel" />
            ) : !reports.data ? (
              <Loading>Loading reports</Loading>
            ) : items.length === 0 ? (
              <p className="muted">Reports appear here as soon as their first reading arrives.</p>
            ) : (
              <ReportPanel items={items} counts={counts} />
            )}
          </div>
        </section>

        <section className="panel kpis" aria-label="Key figures">
          <div className="kpi">
            <div className="label">Open alerts</div>
            <div className="value">{fmtNum(openTotal, 0)}</div>
            <div className="detail">
              <span className="part">
                <Dot tone="critical" />
                {fmtNum(crit, 0)} critical
              </span>
              <span className="part">
                <Dot tone="warning" />
                {fmtNum(warn, 0)} warning
              </span>
            </div>
            <Link className="more" to="/alerts">
              View alerts
            </Link>
          </div>
          <div className="kpi">
            <div className="label">Orphaned reports</div>
            <div className="value">{fmtNum(r.orphaned, 0)}</div>
            <div className="detail">No owner on record, so nobody is told when they break.</div>
            <Link className="more" to="/reports?view=orphaned">
              Review orphaned reports
            </Link>
          </div>
          <div className="kpi">
            <div className="label">Average load time</div>
            <div
              className={`value ${loadTone(r.avg_load_time_sec) ? `tone-text ${toneClass(loadTone(r.avg_load_time_sec))}` : ''}`}
            >
              {r.avg_load_time_sec === null ? '-' : fmtNum(r.avg_load_time_sec, 1, 1)}
              <span className="unit">s</span>
            </div>
            <div className="detail">
              Target {thresholds.latency_threshold_sec} s. Slowest report takes {fmtNum(r.max_load_time_sec, 1, 1)} s.
            </div>
          </div>
        </section>
      </div>

      <div className="overview-bottom">
        <section className="panel" aria-labelledby="attention-title">
          <div className="panel-head">
            <div>
              <h2 id="attention-title">Needs attention</h2>
              <p>Open critical alerts, newest first.</p>
            </div>
            <Link to="/alerts?severity=critical">View all alerts</Link>
          </div>
          <ErrorBox error={critical.error} what="load critical alerts" />
          <AlertList
            data={critical.data}
            onChanged={critical.reload}
            variant="attention"
            emptyTitle="No critical alerts are open"
            emptyText="New critical alerts appear here as soon as they are raised."
          />
        </section>

        <section className="panel" aria-labelledby="slow-title">
          <div className="panel-head">
            <div>
              <h2 id="slow-title">Slowest reports right now</h2>
              <p>Latest average load time. Target {thresholds.latency_threshold_sec} s.</p>
            </div>
          </div>
          {items.length ? <SlowList items={items} /> : <Loading />}
        </section>
      </div>

      <p className="footer-line tabular">
        {fmtNum(ingestion.total_readings, 0)} readings ingested, {fmtNum(ingestion.rejected_payloads, 0)} rejected as
        malformed. Alerts are raised when a report loads slower than {thresholds.latency_threshold_sec} s (critical
        above {thresholds.latency_critical_sec} s) or its refresh fails or times out.
      </p>
    </div>
  );
}

function countStates(items) {
  const counts = { critical: 0, warning: 0, neutral: 0, healthy: 0, orphaned: 0 };
  for (const item of items) {
    counts[reportState(item)] += 1;
    if (item.is_orphaned) counts.orphaned += 1;
  }
  return counts;
}

/** Refreshes every second so "4 seconds ago" stays honest without re-rendering the page. */
function LastReading({ iso }) {
  const now = useNow(1000);
  return (
    <p className="meta">
      {iso ? (
        <>
          Last reading <time dateTime={iso}>{fmtAgo(iso, now)}</time>
        </>
      ) : (
        'No readings received yet'
      )}
    </p>
  );
}

function ReportPanel({ items, counts }) {
  const [tip, setTip] = useState(null);

  const showTip = (report) => (event) => {
    const rect = event.currentTarget.getBoundingClientRect();
    setTip({ report, rect });
  };
  const hideTip = () => setTip(null);

  return (
    <div className="panel-split">
      <div className="report-grid" onMouseLeave={hideTip}>
        {items.map((report) => {
          const state = reportState(report);
          const strong = state === 'critical' || state === 'warning';
          const label = REPORT_STATES.find((s) => s.tone === state).label;
          return (
            <Link
              key={report.report_id}
              to={`/reports/${encodeURIComponent(report.report_id)}`}
              className={`cell ${strong ? '' : 'soft'} ${toneClass(state)}`}
              aria-label={`${report.report_id}, ${report.report_name ?? ''}: ${label}, load ${fmtNum(
                report.avg_load_time_sec,
                1,
              )} seconds, refresh ${REFRESH_STATUS[report.last_refresh_status]?.label.toLowerCase() ?? 'unknown'}${
                report.is_orphaned ? ', no owner' : ''
              }`}
              onMouseEnter={showTip(report)}
              onFocus={showTip(report)}
              onBlur={hideTip}
            >
              <span aria-hidden="true">{shortId(report.report_id)}</span>
              {report.is_orphaned && <span className="orphan-dot" aria-hidden="true" />}
            </Link>
          );
        })}
      </div>
      <ul className="state-legend" aria-label="Report states">
        {REPORT_STATES.map((s) => (
          <li key={s.tone}>
            <span
              className={`swatch ${s.tone === 'critical' || s.tone === 'warning' ? '' : 'soft'} ${toneClass(s.tone)}`}
            />
            <span className="count">{counts[s.tone]}</span>
            <span className="name">{s.label}</span>
            <span className="hint">{capitalise(s.hint)}</span>
          </li>
        ))}
        <li>
          <span className="orphan-key" />
          <span className="count">{counts.orphaned}</span>
          <span className="name">No owner</span>
          <span className="hint">Violet dot in the corner</span>
        </li>
      </ul>
      {tip && <CellTip {...tip} />}
    </div>
  );
}

const capitalise = (text) => text.charAt(0).toUpperCase() + text.slice(1);

/** "RPT_243" -> "243", so each square can be read without hovering. */
function shortId(id) {
  const digits = String(id).match(/\d+$/)?.[0];
  return digits ? digits.slice(-3) : String(id).slice(-3);
}

function CellTip({ report, rect }) {
  const width = 240;
  const left = Math.min(Math.max(8, rect.left + rect.width / 2 - width / 2), window.innerWidth - width - 8);
  const above = rect.top > 140;
  const style = above
    ? { left, bottom: window.innerHeight - rect.top + 8, width }
    : { left, top: rect.bottom + 8, width };
  return (
    <div className="cell-tip" style={style} aria-hidden="true">
      <div className="tip-title">
        {report.report_id}, {report.report_name}
      </div>
      <div className="tip-row">
        Load time <LoadTimePlain sec={report.avg_load_time_sec} />
      </div>
      <div className="tip-row">
        Refresh {REFRESH_STATUS[report.last_refresh_status]?.label.toLowerCase() ?? 'unknown'}
      </div>
      <div className="tip-row">{report.owner_email ? `Owner ${report.owner_email}` : 'No owner on record'}</div>
    </div>
  );
}

function LoadTimePlain({ sec }) {
  return <>{sec === null || sec === undefined ? '-' : `${fmtNum(sec, 1, 1)} s`}</>;
}

function SlowList({ items }) {
  const slowest = [...items]
    .filter((i) => i.avg_load_time_sec !== null)
    .sort((a, b) => b.avg_load_time_sec - a.avg_load_time_sec)
    .slice(0, 5);
  const max = slowest[0]?.avg_load_time_sec || 1;
  return (
    <ol className="slow-list">
      {slowest.map((r) => {
        const tone = loadTone(r.avg_load_time_sec) ?? 'neutral';
        return (
          <li key={r.report_id}>
            <div className="slow-row">
              <span className="name">
                <Link to={`/reports/${encodeURIComponent(r.report_id)}`}>{r.report_id}</Link>{' '}
                <span className="muted">{r.report_name}</span>
              </span>
              <span className="secs">
                <LoadTime sec={r.avg_load_time_sec} />
              </span>
            </div>
            <div className={`bar ${toneClass(tone)}`} aria-hidden="true">
              <span style={{ width: `${(100 * r.avg_load_time_sec) / max}%` }} />
            </div>
          </li>
        );
      })}
    </ol>
  );
}
