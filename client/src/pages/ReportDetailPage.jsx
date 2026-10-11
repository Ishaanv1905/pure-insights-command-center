import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { qs } from '../api/client.js';
import { useAuth } from '../auth/AuthContext.jsx';
import { useApi } from '../hooks/useApi.js';
import {
  Credits,
  Empty,
  ErrorBox,
  FlagBadges,
  LoadTime,
  Loading,
  NoOwnerBadge,
  Pagination,
  RefreshBadge,
  TimeAgo,
  fmtNum,
  fmtTime,
  fmtUsd,
  useNow,
} from '../components/ui.jsx';
import AlertList from './AlertList.jsx';
import NotFoundPage from './NotFoundPage.jsx';

const LIVE = { liveEvents: ['reading.ingested', 'alert.created', 'alert.updated', 'alert.resolved', 'report.updated'] };

export default function ReportDetailPage() {
  const { reportId } = useParams();
  const { can } = useAuth();
  const [offset, setOffset] = useState(0);
  const now = useNow(10_000);
  const id = encodeURIComponent(reportId);
  const report = useApi(`/reports/${id}`, LIVE);
  const alerts = useApi(`/alerts${qs({ report_id: reportId, limit: 10 })}`, LIVE);
  const readings = useApi(can('readings:read') ? `/reports/${id}/readings${qs({ limit: 20, offset })}` : null, LIVE);

  if (report.error?.status === 404) {
    return (
      <NotFoundPage title="Report not found">
        No report with the id <strong>{reportId}</strong> has sent a reading. Check the id, or find the report in the
        list.
      </NotFoundPage>
    );
  }
  const r = report.data;
  if (!r) {
    return report.error ? (
      <ErrorBox error={report.error} what={`load report ${reportId}`} />
    ) : (
      <Loading>Loading report</Loading>
    );
  }

  return (
    <div className="page">
      <div className="detail-head">
        <Link className="back-link" to="/reports">
          All reports
        </Link>
        <h1>
          {r.report_id}
          {r.report_name && <span className="name">{r.report_name}</span>}
        </h1>
        <FlagBadges flags={r.flags} status={r.last_refresh_status} loadSec={r.avg_load_time_sec} />
      </div>

      <dl className="facts">
        <div className="fact">
          <dt>Owner</dt>
          <dd>{r.owner_email ?? <NoOwnerBadge />}</dd>
          {r.owner_source === 'assigned' && <div className="hint">Assigned by an admin</div>}
        </div>
        <div className="fact">
          <dt>Last refresh</dt>
          <dd>
            <RefreshBadge status={r.last_refresh_status} />
          </dd>
        </div>
        <div className="fact">
          <dt>Load time</dt>
          <dd>
            <LoadTime sec={r.avg_load_time_sec} />
          </dd>
        </div>
        <div className="fact">
          <dt>Views per month</dt>
          <dd>{fmtNum(r.monthly_active_views, 0)}</dd>
        </div>
        <div className="fact">
          <dt>Snowflake credits</dt>
          <dd>
            <Credits value={r.snowflake_credits_consumed} />
          </dd>
        </div>
        <div className="fact">
          <dt>AWS per month</dt>
          <dd>{fmtUsd(r.aws_hosting_cost_usd)}</dd>
        </div>
        <div className="fact">
          <dt>Readings</dt>
          <dd>{fmtNum(r.reading_count, 0)}</dd>
          <div className="hint">
            Latest <TimeAgo iso={r.last_seen_at} now={now} />
          </div>
        </div>
      </dl>

      <section className="panel" aria-labelledby="report-alerts">
        <div className="panel-head">
          <div>
            <h2 id="report-alerts">Alerts for this report</h2>
            <p>The 10 most recent, open or resolved.</p>
          </div>
          <Link to="/alerts">All alerts</Link>
        </div>
        <ErrorBox error={alerts.error} what="load alerts for this report" />
        <AlertList
          data={alerts.data}
          onChanged={alerts.reload}
          hideReport
          emptyTitle="No alerts for this report"
          emptyText="An alert is raised when it loads slower than 15 s or its refresh fails."
        />
      </section>

      {can('readings:read') && (
        <section className="panel" aria-labelledby="report-history">
          <div className="panel-head">
            <div>
              <h2 id="report-history">Reading history</h2>
              <p>Raw values exactly as received, newest first.</p>
            </div>
          </div>
          <ErrorBox error={readings.error} what="load the reading history" />
          {!readings.data ? (
            <Loading>Loading readings</Loading>
          ) : readings.data.items.length === 0 ? (
            <Empty title="No readings yet" />
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Received</th>
                    <th>Owner as sent</th>
                    <th>Refresh</th>
                    <th className="num">Load time</th>
                    <th className="num">Views</th>
                    <th className="num">Credits</th>
                    <th className="num">AWS</th>
                    <th>Flags</th>
                  </tr>
                </thead>
                <tbody>
                  {readings.data.items.map((x) => (
                    <tr key={x.id}>
                      <td className="nowrap">
                        {fmtTime(x.received_at)}
                        <div className="sub">Reading {x.id}</div>
                      </td>
                      <td className="owner-cell">{x.owner_email_raw ?? <span className="muted">Not sent</span>}</td>
                      <td>
                        <RefreshBadge status={x.last_refresh_status} />
                      </td>
                      <td className="num">
                        <LoadTime sec={x.avg_load_time_sec} />
                      </td>
                      <td className="num">{fmtNum(x.monthly_active_views, 0)}</td>
                      <td className="num">
                        <Credits value={x.snowflake_credits_consumed} />
                      </td>
                      <td className="num">{fmtUsd(x.aws_hosting_cost_usd)}</td>
                      <td>
                        <FlagBadges
                          flags={x.flags}
                          status={x.last_refresh_status}
                          loadSec={x.avg_load_time_sec}
                          empty={<span className="muted small">None</span>}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <Pagination pagination={readings.data?.pagination} onChange={setOffset} noun="readings" />
        </section>
      )}
    </div>
  );
}
