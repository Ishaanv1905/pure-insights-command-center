import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { qs } from '../api/client.js';
import { useApi } from '../hooks/useApi.js';
import { useRealtime } from '../realtime/RealtimeContext.jsx';
import { feedEventStyle, toneClass } from '../theme/colourKey.js';
import { ErrorBox, Pagination, TimeAgo, alertProblem, useNow } from '../components/ui.jsx';
import AlertList from './AlertList.jsx';

const LIVE = ['alert.created', 'alert.updated', 'alert.resolved'];
const PAGE_SIZE = 25;

export default function AlertsPage() {
  const [params, setParams] = useSearchParams();
  const status = params.get('status') ?? 'active';
  const severity = params.get('severity') ?? '';
  const rule = params.get('rule') ?? '';
  const page = Math.max(1, Number(params.get('page')) || 1);

  const { data, error, reload } = useApi(
    `/alerts${qs({ status: status === 'all' ? '' : status, severity, rule, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE })}`,
    { liveEvents: LIVE, throttleMs: 1000 },
  );
  const feed = useLiveFeed();

  const set = (key) => (e) => {
    const next = new URLSearchParams(params);
    const value = e.target.value;
    if (value === '' || (key === 'status' && value === 'active')) next.delete(key);
    else next.set(key, value);
    next.delete('page');
    setParams(next);
  };
  const goTo = (offset) => {
    const next = new URLSearchParams(params);
    next.set('page', String(offset / PAGE_SIZE + 1));
    setParams(next);
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Alerts</h1>
          <p className="lede">
            One alert per report and problem. It stays open while the problem continues and resolves itself when the
            report recovers.
          </p>
        </div>
      </div>

      <div className="alerts-layout">
        <section className="panel" aria-label="Alerts">
          <div className="toolbar">
            <label className="visually-hidden" htmlFor="alert-status">
              Status
            </label>
            <select id="alert-status" value={status} onChange={set('status')}>
              <option value="active">Open and acknowledged</option>
              <option value="OPEN">Open only</option>
              <option value="ACKNOWLEDGED">Acknowledged only</option>
              <option value="RESOLVED">Resolved</option>
              <option value="all">All statuses</option>
            </select>
            <label className="visually-hidden" htmlFor="alert-severity">
              Severity
            </label>
            <select id="alert-severity" value={severity} onChange={set('severity')}>
              <option value="">Any severity</option>
              <option value="critical">Critical</option>
              <option value="warning">Warning</option>
            </select>
            <label className="visually-hidden" htmlFor="alert-rule">
              Problem
            </label>
            <select id="alert-rule" value={rule} onChange={set('rule')}>
              <option value="">Any problem</option>
              <option value="HIGH_LATENCY">Slow load time</option>
              <option value="REFRESH_FAILED">Refresh failed or timed out</option>
            </select>
            <span className="spacer" />
            {data && (
              <span className="result-count tabular">
                {data.pagination.total} {data.pagination.total === 1 ? 'alert' : 'alerts'}
              </span>
            )}
          </div>
          <ErrorBox error={error} what="load alerts" />
          <AlertList
            data={data}
            onChanged={reload}
            emptyTitle={status === 'active' && !severity && !rule ? 'No open alerts' : 'No alerts match these filters'}
            emptyText={
              status === 'active' && !severity && !rule
                ? 'Every report is within its limits. New alerts appear here as soon as they are raised.'
                : 'Try a different status, severity or problem.'
            }
          />
          <Pagination pagination={data?.pagination} onChange={goTo} noun="alerts" />
        </section>

        <aside className="panel feed-panel" aria-labelledby="live-title">
          <div className="panel-head">
            <div>
              <h2 id="live-title">Live activity</h2>
              <p>Alert changes since you opened this page.</p>
            </div>
          </div>
          <LiveFeed feed={feed} />
        </aside>
      </div>
    </div>
  );
}

function LiveFeed({ feed }) {
  const now = useNow(5000);
  if (feed.length === 0) {
    return (
      <p className="panel-body muted small">
        Nothing yet. New, escalated, reopened and resolved alerts appear here the moment they happen.
      </p>
    );
  }
  return (
    <ol className="feed" aria-live="polite">
      {feed.map((e) => {
        const style = feedEventStyle(e.type, e.data);
        return (
          <li key={e.key} className={toneClass(style.tone)}>
            <span className="dot" aria-hidden="true" />
            <span>
              <span className="what">{style.label}</span>{' '}
              <Link to={`/reports/${encodeURIComponent(e.data.report_id)}`}>{e.data.report_id}</Link>
            </span>
            <span className="detail">
              {e.type === 'alert.resolved'
                ? `${alertProblem(e.data).replace(/ \(limit.*\)$/, '')}: back to normal`
                : e.data.change === 'acknowledged'
                  ? `${alertProblem(e.data)}, by ${e.data.acknowledged_by ?? 'a teammate'}`
                  : alertProblem(e.data)}
            </span>
            <TimeAgo iso={e.at} now={now} />
          </li>
        );
      })}
    </ol>
  );
}

/** Keeps the last 30 alert events received over the WebSocket. */
function useLiveFeed() {
  const { subscribe } = useRealtime();
  const [feed, setFeed] = useState([]);
  useEffect(
    () =>
      subscribe((event) => {
        if (!LIVE.includes(event.type) || !event.data) return;
        setFeed((list) => [{ ...event, key: `${event.type}-${event.data.id}-${event.at}` }, ...list].slice(0, 30));
      }),
    [subscribe],
  );
  return feed;
}
