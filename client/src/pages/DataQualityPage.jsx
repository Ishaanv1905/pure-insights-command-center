import { Link } from 'react-router-dom';
import { useApi } from '../hooks/useApi.js';
import { REFRESH_STATUS, flagStyle } from '../theme/colourKey.js';
import { Badge, Credits, Empty, ErrorBox, Loading, RefreshBadge, fmtNum, fmtTime } from '../components/ui.jsx';

export default function DataQualityPage() {
  const { data, error } = useApi('/data-quality', { liveEvents: ['reading.ingested'], throttleMs: 5000 });
  if (!data) {
    return error ? (
      <ErrorBox error={error} what="load the data quality checks" />
    ) : (
      <Loading>Loading data quality checks</Loading>
    );
  }
  const total = data.totals.total_readings || 1;
  const r = data.views_vs_aws_cost_correlation;
  const m = data.cost_usage_mismatch;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Data quality</h1>
          <p className="lede">
            What is wrong with the incoming data itself, and how each problem is handled. Bad values are kept for audit
            but never silently used in cost math.
          </p>
        </div>
      </div>

      <dl className="facts">
        <div className="fact">
          <dt>Readings accepted</dt>
          <dd>{fmtNum(data.totals.total_readings, 0)}</dd>
          <div className="hint">From {fmtNum(data.totals.distinct_reports, 0)} reports</div>
        </div>
        <div className="fact">
          <dt>Rejected payloads</dt>
          <dd>{fmtNum(data.rejected_payloads, 0)}</dd>
          <div className="hint">Malformed, not stored</div>
        </div>
        <div className="fact">
          <dt>Lowest credit value</dt>
          <dd>
            {data.negative_credits.min_value === null ? '-' : <Credits value={data.negative_credits.min_value} />}
          </dd>
          <div className="hint">{fmtNum(data.negative_credits.readings, 0)} negative readings</div>
        </div>
        <div className="fact">
          <dt>Load time range</dt>
          <dd>
            {data.latency.min_sec ?? '-'} to {data.latency.max_sec ?? '-'} s
          </dd>
        </div>
        <div className="fact">
          <dt>Views vs AWS cost</dt>
          <dd>r = {r ?? '-'}</dd>
          {r !== null && Math.abs(r) < 0.3 && <div className="hint">Hosting cost does not track usage</div>}
        </div>
      </dl>

      <section className="panel" aria-labelledby="flags-title">
        <div className="panel-head">
          <div>
            <h2 id="flags-title">Flags and how they are handled</h2>
            <p>Each reading can carry several flags.</p>
          </div>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Flag</th>
                <th className="num">Readings</th>
                <th className="num">Share</th>
                <th className="num">Reports</th>
                <th>Handling</th>
              </tr>
            </thead>
            <tbody>
              {data.flag_counts.map((f) => {
                const s = flagStyle(f.flag);
                return (
                  <tr key={f.flag}>
                    <td>
                      <Badge tone={s.tone}>{s.label}</Badge>
                    </td>
                    <td className="num">{fmtNum(f.readings, 0)}</td>
                    <td className="num">{((100 * f.readings) / total).toFixed(1)}%</td>
                    <td className="num">
                      <Link to={`/reports?flag=${f.flag}`}>{fmtNum(f.reports, 0)}</Link>
                    </td>
                    <td className="small secondary" style={{ minWidth: 260 }}>
                      {data.flag_handling[f.flag]}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      {m && (
        <section className="panel" aria-labelledby="mismatch-title">
          <div className="panel-head">
            <div>
              <h2 id="mismatch-title">Cost vs usage discrepancy</h2>
            </div>
            <Link to="/cost?tab=usage">See the readings</Link>
          </div>
          <p className="panel-body secondary">
            {fmtNum(m.mismatched_readings, 0)} of {fmtNum(m.readings_checked, 0)} readings have an AWS hosting cost far
            out of line with their usage, across {m.reports_affected} reports: {m.high_cost_low_usage} high cost with
            low usage, {m.low_cost_high_usage} low cost with high usage, and {m.cost_with_no_usage} with cost but no
            views. AWS cost correlates with views at r = {m.correlation.views_vs_aws_cost} and with peak users at r ={' '}
            {m.correlation.peak_users_vs_aws_cost}.
          </p>
        </section>
      )}

      <div className="two-col">
        <section className="panel" aria-labelledby="raw-title">
          <div className="panel-head">
            <div>
              <h2 id="raw-title">Values sent instead of an owner</h2>
              <p>Each of these marks the report as orphaned.</p>
            </div>
          </div>
          {data.orphaned_owner_raw_values.length === 0 ? (
            <Empty title="Every reading named an owner" />
          ) : (
            <div className="table-wrap">
              <table className="compact-table">
                <thead>
                  <tr>
                    <th>Value as sent</th>
                    <th className="num">Readings</th>
                  </tr>
                </thead>
                <tbody>
                  {data.orphaned_owner_raw_values.map((o) => (
                    <tr key={o.raw_value}>
                      <td className="strong">{o.raw_value === '' ? '(blank)' : o.raw_value}</td>
                      <td className="num">{fmtNum(o.readings, 0)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
        <section className="panel" aria-labelledby="refresh-title">
          <div className="panel-head">
            <div>
              <h2 id="refresh-title">Refresh status across all readings</h2>
            </div>
          </div>
          <div className="table-wrap">
            <table className="compact-table">
              <thead>
                <tr>
                  <th>Status</th>
                  <th className="num">Readings</th>
                  <th className="num">Share</th>
                </tr>
              </thead>
              <tbody>
                {[...data.refresh_status_counts]
                  .sort(
                    (a, b) =>
                      Object.keys(REFRESH_STATUS).indexOf(a.status) - Object.keys(REFRESH_STATUS).indexOf(b.status),
                  )
                  .map((s) => (
                    <tr key={s.status}>
                      <td>
                        <RefreshBadge status={s.status} />
                      </td>
                      <td className="num">{fmtNum(s.readings, 0)}</td>
                      <td className="num">{((100 * s.readings) / total).toFixed(1)}%</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>

      <section className="panel" aria-labelledby="rejected-title">
        <div className="panel-head">
          <div>
            <h2 id="rejected-title">Recently rejected payloads</h2>
            <p>Requests that failed validation. They are stored here for review, not ingested.</p>
          </div>
        </div>
        {data.recent_rejections.length === 0 ? (
          <Empty title="No rejected payloads">
            Malformed requests, such as a missing id, a wrong type or an unknown status, appear here.
          </Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Received</th>
                  <th>Problems</th>
                  <th>Payload (truncated)</th>
                </tr>
              </thead>
              <tbody>
                {data.recent_rejections.map((x) => (
                  <tr key={x.id}>
                    <td className="nowrap small">{fmtTime(x.received_at)}</td>
                    <td className="small">
                      {x.errors.map((e) => (
                        <div key={e}>{e}</div>
                      ))}
                    </td>
                    <td className="payload">{x.payload}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
