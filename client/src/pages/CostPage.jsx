import { useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useApi } from '../hooks/useApi.js';
import { MISMATCH } from '../theme/colourKey.js';
import { Badge, Empty, ErrorBox, Loading, NoOwnerBadge, fmtNum, fmtUsd } from '../components/ui.jsx';
import SnowflakeAttribution from './SnowflakeAttribution.jsx';

const LIVE = { liveEvents: ['reading.ingested'], throttleMs: 5000 };
const TABS = [
  { id: 'reports', label: 'By report' },
  { id: 'usage', label: 'Cost vs usage' },
  { id: 'snowflake', label: 'Snowflake attribution' },
];

export default function CostPage() {
  const [params, setParams] = useSearchParams();
  const tab = TABS.some((t) => t.id === params.get('tab')) ? params.get('tab') : 'reports';
  const cost = useApi('/cost', LIVE);
  const mismatch = useApi(tab === 'usage' ? '/cost/usage-mismatch' : null, LIVE);
  const tabRefs = useRef({});

  const select = (id, focus = false) => {
    const next = new URLSearchParams(params);
    if (id === 'reports') next.delete('tab');
    else next.set('tab', id);
    setParams(next, { replace: true });
    if (focus) tabRefs.current[id]?.focus();
  };

  // Arrow keys move between tabs (WAI-ARIA tabs pattern).
  const onKeyDown = (e) => {
    const index = TABS.findIndex((t) => t.id === tab);
    const moves = { ArrowRight: 1, ArrowLeft: -1, Home: -index, End: TABS.length - 1 - index };
    if (!(e.key in moves)) return;
    e.preventDefault();
    select(TABS[(index + moves[e.key] + TABS.length) % TABS.length].id, true);
  };

  if (!cost.data) {
    return cost.error ? <ErrorBox error={cost.error} what="load cost data" /> : <Loading>Loading cost data</Loading>;
  }
  const { summary, assumptions, items } = cost.data;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Cost</h1>
          <p className="lede">
            What each report costs per month in Snowflake credits and AWS hosting, and what that buys in views.
          </p>
        </div>
      </div>

      <dl className="facts">
        <div className="fact">
          <dt>Total per month</dt>
          <dd>{fmtUsd(summary.avg_monthly_total_cost_usd, 0)}</dd>
          <div className="hint">Average month, all {summary.reports} reports</div>
        </div>
        <div className="fact">
          <dt>Snowflake</dt>
          <dd>{fmtUsd(summary.avg_monthly_credit_cost_usd, 0)}</dd>
          <div className="hint">Credits at ${assumptions.credit_price_usd} each</div>
        </div>
        <div className="fact">
          <dt>AWS hosting</dt>
          <dd>{fmtUsd(summary.avg_monthly_aws_cost_usd, 0)}</dd>
        </div>
        <div className="fact">
          <dt>Median cost per view</dt>
          <dd>{fmtUsd(summary.median_total_cost_per_view_usd, 3)}</dd>
          <div className="hint">
            {summary.cost_outliers === 0
              ? 'No report above 3 times the median'
              : `${summary.cost_outliers} above 3 times the median`}
          </div>
        </div>
      </dl>

      <section className="panel">
        <div
          className="tablist"
          role="tablist"
          aria-label="Cost views"
          onKeyDown={onKeyDown}
          style={{ padding: '0 20px' }}
        >
          {TABS.map((t) => (
            <button
              key={t.id}
              ref={(el) => (tabRefs.current[t.id] = el)}
              role="tab"
              id={`tab-${t.id}`}
              aria-selected={tab === t.id}
              aria-controls={`panel-${t.id}`}
              tabIndex={tab === t.id ? 0 : -1}
              onClick={() => select(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
          {tab === 'reports' && <ByReport items={items} summary={summary} />}
          {tab === 'usage' &&
            (mismatch.error ? (
              <ErrorBox error={mismatch.error} what="load the cost vs usage check" />
            ) : (
              <UsageMismatch data={mismatch.data} />
            ))}
          {tab === 'snowflake' && <SnowflakeAttribution />}
        </div>
      </section>
    </div>
  );
}

const COST_ROWS = 25;

function ByReport({ items, summary }) {
  const [showAll, setShowAll] = useState(false);
  if (items.length === 0) {
    return <Empty title="No cost data yet">Cost appears once reports have sent readings.</Empty>;
  }
  const maxCpv = Math.max(...items.map((i) => i.total_cost_per_view_usd ?? 0), 0.0001);
  return (
    <>
      <p className="note" style={{ padding: '16px 20px 8px' }}>
        Most expensive per view first. Per-view cost is total cost divided by total views, so months with no views do
        not divide by zero.{' '}
        {summary.excluded_readings > 0 &&
          `${summary.excluded_readings} readings with negative values are left out of the math.`}
      </p>
      <div className="table-wrap sticky">
        <table>
          <thead>
            <tr>
              <th>Report</th>
              <th>Owner</th>
              <th className="num">Views / mo</th>
              <th className="num">Credits / mo</th>
              <th className="num">Total / mo</th>
              <th className="num">Credits / view</th>
              <th className="num">Cost / view</th>
              <th style={{ width: '16%' }}>
                <span className="visually-hidden">Cost per view compared with the most expensive report</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {(showAll ? items : items.slice(0, COST_ROWS)).map((i) => (
              <tr key={i.report_id}>
                <td className="report-cell">
                  <Link to={`/reports/${encodeURIComponent(i.report_id)}`}>{i.report_id}</Link>
                  <div className="sub">
                    {i.excluded_readings > 0
                      ? `${i.excluded_readings} ${i.excluded_readings === 1 ? 'reading' : 'readings'} left out`
                      : i.report_name}
                  </div>
                </td>
                <td className="owner-cell">{i.owner_email ?? <NoOwnerBadge />}</td>
                <td className="num">{fmtNum(i.avg_monthly_views, 0)}</td>
                <td className="num">{fmtNum(i.avg_monthly_credits, 1, 1)}</td>
                <td className="num">{fmtUsd(i.avg_monthly_total_cost_usd, 0)}</td>
                <td className="num">{fmtNum(i.credits_per_view, 3, 3)}</td>
                <td className="num strong">
                  {fmtUsd(i.total_cost_per_view_usd, 3)}
                  {i.is_cost_outlier && <div className="sub">Over 3x median</div>}
                </td>
                <td>
                  <div className="bar" style={{ marginTop: 8 }}>
                    <span style={{ width: `${(100 * (i.total_cost_per_view_usd ?? 0)) / maxCpv}%` }} />
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {items.length > COST_ROWS && (
        <div className="pagination">
          <span className="tabular">
            Showing {showAll ? items.length : COST_ROWS} of {items.length} reports
          </span>
          <button className="btn small" onClick={() => setShowAll((v) => !v)}>
            {showAll ? `Show the top ${COST_ROWS}` : 'Show all reports'}
          </button>
        </div>
      )}
    </>
  );
}

/** Defect (d): readings whose AWS hosting cost is out of line with their active users. */
function UsageMismatch({ data }) {
  if (!data) return <Loading>Checking cost against usage</Loading>;
  const { summary, fences_usd: f, correlation, reports, readings } = data;
  return (
    <div>
      <div className="panel-body" style={{ paddingTop: 16 }}>
        <p className="secondary" style={{ maxWidth: '80ch' }}>
          AWS hosting cost does not follow usage: {fmtNum(summary.mismatched_readings, 0)} of{' '}
          {fmtNum(summary.readings_checked, 0)} readings, across {summary.reports_affected} reports, cost far more or
          far less than their views and peak users would suggest.
        </p>
        <p className="note" style={{ marginTop: 8 }}>
          Correlation of AWS cost with views is r = {correlation.views_vs_aws_cost}, with peak users r ={' '}
          {correlation.peak_users_vs_aws_cost}. A reading is flagged when its AWS cost per view or per peak user falls
          outside fences learned from all readings (log scale, k = 1.5). Typical cost per view is about{' '}
          {fmtUsd(f.per_view?.median, 3)}; flagged above {fmtUsd(f.per_view?.high, 2)} or below{' '}
          {fmtUsd(f.per_view?.low, 3)}.
        </p>
        <div className="legend" style={{ marginTop: 12 }}>
          {Object.entries(MISMATCH).map(([key, m]) => (
            <span key={key} className="item">
              <Badge tone={m.tone}>{m.label}</Badge>
              <span className="count">{fmtNum(summary[key], 0)}</span> readings
            </span>
          ))}
        </div>
      </div>

      <div className="two-col" style={{ gap: 0, borderTop: '1px solid var(--line-soft)' }}>
        <div style={{ minWidth: 0 }}>
          <h3 className="section-title" style={{ padding: '16px 20px 0' }}>
            Most extreme readings
          </h3>
          {readings.length === 0 ? (
            <Empty title="Nothing out of line">Every reading has a hosting cost in line with its usage.</Empty>
          ) : (
            <div className="table-wrap">
              <table className="compact-table">
                <thead>
                  <tr>
                    <th>Report</th>
                    <th>Finding</th>
                    <th className="num">Views</th>
                    <th className="num">Peak users</th>
                    <th className="num">AWS</th>
                    <th className="num">AWS / view</th>
                  </tr>
                </thead>
                <tbody>
                  {readings.slice(0, 15).map((r) => {
                    const m = MISMATCH[r.direction] ?? { tone: 'dq', label: r.direction };
                    return (
                      <tr key={r.reading_id}>
                        <td className="report-cell">
                          <Link to={`/reports/${encodeURIComponent(r.report_id)}`}>{r.report_id}</Link>
                        </td>
                        <td>
                          <Badge tone={m.tone}>{m.label}</Badge>
                        </td>
                        <td className="num">{fmtNum(r.monthly_active_views, 0)}</td>
                        <td className="num">{fmtNum(r.concurrent_user_peak, 0)}</td>
                        <td className="num">{fmtUsd(r.aws_hosting_cost_usd)}</td>
                        <td className="num">{fmtUsd(r.aws_cost_per_view_usd, 3)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
        <div style={{ minWidth: 0, borderLeft: '1px solid var(--line-soft)' }}>
          <h3 className="section-title" style={{ padding: '16px 20px 0' }}>
            Reports with the most flagged readings
          </h3>
          <div className="table-wrap">
            <table className="compact-table">
              <thead>
                <tr>
                  <th>Report</th>
                  <th className="num">High cost</th>
                  <th className="num">No views</th>
                  <th className="num">Low cost</th>
                </tr>
              </thead>
              <tbody>
                {reports.slice(0, 15).map((r) => (
                  <tr key={r.report_id}>
                    <td className="report-cell">
                      <Link to={`/reports/${encodeURIComponent(r.report_id)}`}>{r.report_id}</Link>
                    </td>
                    <MismatchCount n={r.high_cost_low_usage} />
                    <MismatchCount n={r.cost_with_no_usage} />
                    <MismatchCount n={r.low_cost_high_usage} />
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}

function MismatchCount({ n }) {
  return <td className={`num ${n ? '' : 'muted'}`}>{fmtNum(n, 0)}</td>;
}
