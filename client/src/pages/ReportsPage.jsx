import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, qs } from '../api/client.js';
import { useAuth } from '../auth/AuthContext.jsx';
import { useApi } from '../hooks/useApi.js';
import { FLAGS, REFRESH_STATUS } from '../theme/colourKey.js';
import { Empty, ErrorBox, Pagination } from '../components/ui.jsx';
import ReportTable from './ReportTable.jsx';

const PAGE_SIZE = 25;
const LIVE = ['reading.ingested', 'report.updated'];
const SORTS = [
  ['report_id', 'Report id'],
  ['avg_load_time_sec', 'Load time'],
  ['monthly_active_views', 'Views'],
  ['snowflake_credits_consumed', 'Credits'],
  ['aws_hosting_cost_usd', 'AWS cost'],
  ['last_seen_at', 'Last reading'],
];

/**
 * All reports, or only the orphaned ones (view=orphaned). Every filter lives in
 * the URL query string, so any view can be bookmarked or shared.
 */
export default function ReportsPage() {
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const orphaned = params.get('view') === 'orphaned';
  const search = params.get('search') ?? '';
  const status = params.get('status') ?? '';
  const flag = params.get('flag') ?? '';
  const sort = params.get('sort') ?? 'report_id';
  const order = params.get('order') ?? 'asc';
  const page = Math.max(1, Number(params.get('page')) || 1);

  // The search box updates the URL after a short pause, not on every keystroke.
  const [searchText, setSearchText] = useState(search);
  useEffect(() => setSearchText(search), [search]);
  useEffect(() => {
    if (searchText === search) return undefined;
    const id = setTimeout(() => update({ search: searchText }), 300);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchText]);

  function update(changes, { resetPage = true } = {}) {
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        for (const [key, value] of Object.entries(changes)) {
          if (value === '' || value === null || value === undefined) next.delete(key);
          else next.set(key, value);
        }
        if (resetPage && !('page' in changes)) next.delete('page');
        return next;
      },
      { replace: 'search' in changes },
    );
  }

  const query = qs({
    search,
    status,
    flag,
    sort,
    order,
    orphaned: orphaned ? 'true' : undefined,
    limit: PAGE_SIZE,
    offset: (page - 1) * PAGE_SIZE,
  });
  const { data, error, reload } = useApi(`/reports${query}`, { liveEvents: LIVE, throttleMs: 3000 });
  const summary = useApi('/health/summary', { liveEvents: LIVE, throttleMs: 3000 });
  const orphanCount = summary.data?.reports.orphaned;

  const canAssign = can('reports:assign-owner');
  const extraColumn =
    orphaned && canAssign
      ? {
          title: 'Assign owner',
          render: (r) => (
            <AssignOwner
              reportId={r.report_id}
              onDone={() => {
                reload();
                summary.reload();
              }}
            />
          ),
        }
      : undefined;

  const filtered = Boolean(search || status || flag);
  const viewHref = (view) => {
    const next = new URLSearchParams(params);
    next.delete('page');
    if (view) next.set('view', view);
    else next.delete('view');
    const s = next.toString();
    return `/reports${s ? `?${s}` : ''}`;
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>{orphaned ? 'Orphaned reports' : 'Reports'}</h1>
          <p className="lede">
            {orphaned
              ? 'These reports have no owner on record, so nobody is accountable when they break or cost money.' +
                (canAssign ? ' Assign an owner to take a report off this list.' : ' An admin can assign an owner.')
              : 'The latest reading of every report on the portal. Select a report for its history and alerts.'}
          </p>
        </div>
        <nav className="segmented" aria-label="Report views">
          <Link to={viewHref(null)} aria-current={orphaned ? undefined : 'page'}>
            All reports
          </Link>
          <Link to={viewHref('orphaned')} aria-current={orphaned ? 'page' : undefined}>
            Orphaned <span className="count">{orphanCount === undefined ? '' : `(${orphanCount})`}</span>
          </Link>
        </nav>
      </div>

      <section className="panel" aria-label={orphaned ? 'Orphaned reports' : 'All reports'}>
        <div className="toolbar" role="search">
          <label className="visually-hidden" htmlFor="report-search">
            Search reports
          </label>
          <input
            id="report-search"
            className="search"
            type="search"
            placeholder="Search by id, name or owner"
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
          />
          <label className="visually-hidden" htmlFor="report-status">
            Refresh status
          </label>
          <select id="report-status" value={status} onChange={(e) => update({ status: e.target.value })}>
            <option value="">Any refresh status</option>
            {Object.entries(REFRESH_STATUS).map(([value, s]) => (
              <option key={value} value={value}>
                Refresh: {s.label.toLowerCase()}
              </option>
            ))}
          </select>
          <label className="visually-hidden" htmlFor="report-flag">
            Flag
          </label>
          <select id="report-flag" value={flag} onChange={(e) => update({ flag: e.target.value })}>
            <option value="">Any flag</option>
            {Object.entries(FLAGS)
              .filter(([value]) => !(orphaned && value === 'ORPHANED'))
              .map(([value, f]) => (
                <option key={value} value={value}>
                  {f.label}
                </option>
              ))}
          </select>
          <label className="visually-hidden" htmlFor="report-sort">
            Sort by
          </label>
          <select id="report-sort" value={sort} onChange={(e) => update({ sort: e.target.value })}>
            {SORTS.map(([value, label]) => (
              <option key={value} value={value}>
                Sort by {label.toLowerCase()}
              </option>
            ))}
          </select>
          <label className="visually-hidden" htmlFor="report-order">
            Order
          </label>
          <select id="report-order" value={order} onChange={(e) => update({ order: e.target.value })}>
            <option value="asc">Ascending</option>
            <option value="desc">Descending</option>
          </select>
          {filtered && (
            <button
              type="button"
              className="text-button"
              onClick={() => {
                setSearchText('');
                update({ search: '', status: '', flag: '' });
              }}
            >
              Clear filters
            </button>
          )}
        </div>
        <ErrorBox error={error} what="load reports" />
        <ReportTable
          items={data?.items}
          extraColumn={extraColumn}
          hiddenFlags={orphaned ? ['ORPHANED'] : []}
          empty={
            orphaned && !filtered ? (
              <Empty title="Every report has an owner">
                Reports land here when a reading arrives with a blank or placeholder owner.
              </Empty>
            ) : undefined
          }
        />
        <Pagination
          pagination={data?.pagination}
          noun="reports"
          onChange={(offset) => update({ page: offset / PAGE_SIZE + 1 }, { resetPage: false })}
        />
      </section>
    </div>
  );
}

/** Inline owner assignment for one orphaned report. */
function AssignOwner({ reportId, onDone }) {
  const [email, setEmail] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const inputId = `owner-${reportId}`;

  async function save(e) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await api.patch(`/reports/${encodeURIComponent(reportId)}/owner`, { owner_email: email.trim() });
      onDone();
    } catch (err) {
      setError(err.details?.join('. ') || err.message);
      setBusy(false);
    }
  }

  return (
    <form onSubmit={save}>
      <div className="assign">
        <label className="visually-hidden" htmlFor={inputId}>
          Owner email for {reportId}
        </label>
        <input
          id={inputId}
          type="email"
          placeholder="owner@company.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
        <button className="btn small primary" disabled={busy}>
          {busy ? 'Assigning' : 'Assign'}
        </button>
      </div>
      {error && (
        <div className="assign-error" role="alert">
          {error}
        </div>
      )}
    </form>
  );
}
