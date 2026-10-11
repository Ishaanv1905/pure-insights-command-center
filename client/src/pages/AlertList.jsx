import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client.js';
import { useAuth } from '../auth/AuthContext.jsx';
import {
  AlertStatusBadge,
  Empty,
  Loading,
  SeverityBadge,
  TimeAgo,
  alertProblem,
  fmtDuration,
  plural,
  useNow,
} from '../components/ui.jsx';

/**
 * Table of alerts with an Acknowledge button for roles that may use it.
 * `variant="attention"` is the short list on the overview (report, problem, open for).
 * `hideReport` drops the report column (used on a report's own page).
 */
export default function AlertList({ data, onChanged, variant = 'full', hideReport = false, emptyTitle, emptyText }) {
  const { can } = useAuth();
  const [error, setError] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const now = useNow(10_000);
  const canAck = can('alerts:acknowledge');

  if (!data) return <Loading>Loading alerts</Loading>;
  if (data.items.length === 0) {
    return (
      <Empty title={emptyTitle ?? 'No alerts match'}>
        {emptyText ?? 'Try a different status or severity. New alerts appear here as soon as they are raised.'}
      </Empty>
    );
  }

  async function acknowledge(id) {
    setError(null);
    setBusyId(id);
    try {
      await api.post(`/alerts/${id}/acknowledge`);
      onChanged?.();
    } catch (err) {
      setError(
        err.status === 409
          ? 'Someone else already acknowledged or resolved this alert.'
          : `Could not acknowledge: ${err.message}`,
      );
    } finally {
      setBusyId(null);
    }
  }

  const ackButton = (a) =>
    a.status === 'OPEN' && canAck ? (
      <button className="btn small" disabled={busyId === a.id} onClick={() => acknowledge(a.id)}>
        Acknowledge
      </button>
    ) : null;

  const reportCell = (a) => (
    <td className="report-cell">
      <Link to={`/reports/${encodeURIComponent(a.report_id)}`}>{a.report_id}</Link>
      {a.report_name && <div className="sub">{a.report_name}</div>}
    </td>
  );

  if (variant === 'attention') {
    return (
      <>
        {error && <div className="error-box">{error}</div>}
        <div className="table-wrap">
          <table className="compact-table stack-table">
            <thead>
              <tr>
                <th>Report</th>
                <th>What is wrong</th>
                <th>Open for</th>
                {canAck && (
                  <th>
                    <span className="visually-hidden">Action</span>
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {data.items.map((a) => (
                <tr key={a.id}>
                  {reportCell(a)}
                  <td className="problem">
                    {alertProblem(a)}
                    {a.status === 'ACKNOWLEDGED' && (
                      <div className="sub">Acknowledged by {a.acknowledged_by ?? 'a teammate'}</div>
                    )}
                  </td>
                  <td className="nowrap tabular open-for" title={`Opened ${new Date(a.created_at).toLocaleString()}`}>
                    {fmtDuration(a.created_at, now)}
                  </td>
                  {canAck && <td className="action">{ackButton(a)}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </>
    );
  }

  return (
    <>
      {error && <div className="error-box">{error}</div>}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Severity</th>
              {!hideReport && <th>Report</th>}
              <th>Problem</th>
              <th>Status</th>
              <th title="Breaching readings counted on this alert, and how often it broke again shortly after recovering">
                Breaches
              </th>
              <th>Opened</th>
              {canAck && (
                <th>
                  <span className="visually-hidden">Action</span>
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {data.items.map((a) => (
              <tr key={a.id}>
                <td>
                  <SeverityBadge severity={a.severity} />
                </td>
                {!hideReport && reportCell(a)}
                <td className="problem">
                  {alertProblem(a)}
                  <div className="sub">Rule: {a.rule}</div>
                </td>
                <td>
                  <AlertStatusBadge status={a.status} />
                  {a.status === 'ACKNOWLEDGED' && a.acknowledged_by && (
                    <div className="sub xsmall">by {a.acknowledged_by}</div>
                  )}
                </td>
                <td className="nowrap tabular">
                  {plural(a.occurrences, 'reading')}
                  {a.reopen_count > 0 && (
                    <div className="sub">
                      reopened {a.reopen_count} {a.reopen_count === 1 ? 'time' : 'times'}
                    </div>
                  )}
                </td>
                <td className="nowrap">
                  <TimeAgo iso={a.created_at} now={now} />
                </td>
                {canAck && <td className="action">{ackButton(a)}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
