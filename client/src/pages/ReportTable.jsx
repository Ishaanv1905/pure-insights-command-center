import { Link } from 'react-router-dom';
import {
  Credits,
  Empty,
  FlagBadges,
  LoadTime,
  Loading,
  NoOwnerBadge,
  RefreshBadge,
  fmtNum,
  fmtUsd,
} from '../components/ui.jsx';

/** The reports table. `extraColumn` adds one column on the right (e.g. Assign owner). */
export default function ReportTable({ items, extraColumn, empty, hiddenFlags = [] }) {
  if (!items) return <Loading>Loading reports</Loading>;
  if (items.length === 0) {
    return (
      empty ?? (
        <Empty title="No reports match these filters">Clear the search or pick a different status or flag.</Empty>
      )
    );
  }
  return (
    <div className="table-wrap sticky">
      <table>
        <thead>
          <tr>
            <th>Report</th>
            <th>Owner</th>
            <th>Refresh</th>
            <th className="num">Load time</th>
            <th className="num">Views / mo</th>
            <th className="num">Credits</th>
            <th className="num">AWS / mo</th>
            <th>Flags</th>
            {extraColumn && <th>{extraColumn.title}</th>}
          </tr>
        </thead>
        <tbody>
          {items.map((r) => (
            <tr key={r.report_id}>
              <td className="report-cell">
                <Link to={`/reports/${encodeURIComponent(r.report_id)}`}>{r.report_id}</Link>
                <div className="sub">{r.report_name}</div>
              </td>
              <td className="owner-cell">
                {r.owner_email ?? <NoOwnerBadge />}
                {r.owner_source === 'assigned' && <div className="sub">Assigned by an admin</div>}
              </td>
              <td>
                <RefreshBadge status={r.last_refresh_status} />
              </td>
              <td className="num">
                <LoadTime sec={r.avg_load_time_sec} />
              </td>
              <td className="num">{fmtNum(r.monthly_active_views, 0)}</td>
              <td className="num">
                <Credits value={r.snowflake_credits_consumed} />
              </td>
              <td className="num">{fmtUsd(r.aws_hosting_cost_usd)}</td>
              <td>
                <FlagBadges
                  flags={r.flags.filter((f) => !hiddenFlags.includes(f))}
                  status={r.last_refresh_status}
                  loadSec={r.avg_load_time_sec}
                  empty={<span className="muted small">None</span>}
                />
              </td>
              {extraColumn && <td>{extraColumn.render(r)}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
