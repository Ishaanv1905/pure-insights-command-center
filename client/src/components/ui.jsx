// Small shared presentational components. Every status colour comes from
// theme/colourKey.js through `toneClass`; nothing here picks a colour itself.

import { useEffect, useState } from 'react';
import {
  ALERT_STATUS,
  FLAGS,
  REFRESH_STATUS,
  SEVERITY,
  creditsTone,
  flagStyle,
  loadTone,
  toneClass,
} from '../theme/colourKey.js';

/** A soft, filled badge in a status tone. */
export function Badge({ tone, children, title }) {
  return (
    <span className={`badge ${toneClass(tone)}`} title={title}>
      {children}
    </span>
  );
}

export function SeverityBadge({ severity }) {
  const s = SEVERITY[severity] ?? { tone: 'neutral', label: severity };
  return <Badge tone={s.tone}>{s.label}</Badge>;
}

export function RefreshBadge({ status }) {
  const s = REFRESH_STATUS[status] ?? { tone: 'neutral', label: status ?? 'Unknown' };
  return <Badge tone={s.tone}>{s.label}</Badge>;
}

/** Alert lifecycle status: outlined, so it never competes with severity. */
export function AlertStatusBadge({ status }) {
  const s = ALERT_STATUS[status] ?? { tone: 'neutral', label: status };
  return <span className={`badge outline ${s.tone ? toneClass(s.tone) : 'ink'}`}>{s.label}</span>;
}

/**
 * Flags as badges. `context` (refresh status, load time) lets a badge match the
 * status badge and load time shown on the same row.
 */
export function FlagBadges({ flags, status, loadSec, empty = null }) {
  if (!flags?.length) return empty;
  return (
    <span className="badges">
      {flags.map((f) => {
        const s = flagStyle(f, { status, loadSec });
        return (
          <Badge key={f} tone={s.tone}>
            {s.label}
          </Badge>
        );
      })}
    </span>
  );
}

export function NoOwnerBadge() {
  return <Badge tone={FLAGS.ORPHANED.tone}>No owner</Badge>;
}

export function Dot({ tone, label }) {
  return <span className={`dot ${toneClass(tone)}`} role={label ? 'img' : undefined} aria-label={label} />;
}

/** A load time, coloured only when it crosses the 15 s / 30 s thresholds. */
export function LoadTime({ sec, digits = 1, unit = true }) {
  if (sec === null || sec === undefined) return '-';
  const tone = loadTone(sec);
  return (
    <span className={tone ? `tone-text strong ${toneClass(tone)}` : undefined}>
      {fmtNum(sec, digits, digits)}
      {unit ? ' s' : ''}
    </span>
  );
}

/** Snowflake credits; negative values are impossible, so they show in the data-quality tone. */
export function Credits({ value, digits = 2 }) {
  const tone = creditsTone(value);
  return (
    <span
      className={tone ? `tone-text strong ${toneClass(tone)}` : undefined}
      title={tone ? 'Negative credits: excluded from cost math' : undefined}
    >
      {fmtNum(value, digits)}
    </span>
  );
}

export function Pagination({ pagination, onChange, noun = 'items' }) {
  if (!pagination || pagination.total <= pagination.limit) return null;
  const { total, limit, offset } = pagination;
  const from = offset + 1;
  const to = Math.min(offset + limit, total);
  return (
    <nav className="pagination" aria-label="Pagination">
      <span className="tabular">
        Showing {from} to {to} of {total} {noun}
      </span>
      <span className="controls">
        <button className="btn small" disabled={offset === 0} onClick={() => onChange(Math.max(0, offset - limit))}>
          Previous
        </button>
        <button className="btn small" disabled={!pagination.has_more} onClick={() => onChange(offset + limit)}>
          Next
        </button>
      </span>
    </nav>
  );
}

/** Explains what went wrong in plain words. */
export function ErrorBox({ error, what = 'load this data' }) {
  if (!error) return null;
  const reason =
    error.status === 403
      ? 'Your role does not have access to this.'
      : error.status === 401
        ? 'Your session has ended. Sign in again to continue.'
        : error.message;
  return (
    <div className="error-box" role="alert">
      <div>
        <strong>Could not {what}.</strong> {reason}
      </div>
    </div>
  );
}

export function Empty({ title, children }) {
  return (
    <div className="empty">
      {title && <strong>{title}</strong>}
      {children && <p>{children}</p>}
    </div>
  );
}

export function Loading({ children = 'Loading' }) {
  return (
    <div className="loading" role="status">
      {children}...
    </div>
  );
}

/** The brand mark: a 3 x 2 grid of status LEDs, one lit in the accent colour. */
export function BrandMark({ size = 26 }) {
  const cells = [];
  for (let row = 0; row < 2; row += 1) {
    for (let col = 0; col < 3; col += 1) {
      cells.push(
        <rect
          key={`${row}-${col}`}
          className={row === 0 && col === 2 ? 'lit' : undefined}
          x={col * 9}
          y={row * 9 + 4.5}
          width="7"
          height="7"
          rx="2"
        />,
      );
    }
  }
  return (
    <svg className="brand-mark" width={size} height={size} viewBox="0 0 25 25" aria-hidden="true">
      {cells}
    </svg>
  );
}

export function CloseIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

/** Re-renders every `ms` so relative times ("4 seconds ago") stay current. */
export function useNow(ms = 5000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

/** Relative time with the absolute time as a tooltip. */
export function TimeAgo({ iso, now }) {
  if (!iso) return '-';
  return (
    <time dateTime={iso} title={fmtTime(iso)}>
      {fmtAgo(iso, now)}
    </time>
  );
}

export function fmtAgo(iso, now = Date.now()) {
  if (!iso) return '-';
  const sec = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (sec < 5) return 'just now';
  if (sec < 60) return `${sec} seconds ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} minute${min === 1 ? '' : 's'} ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} hour${hr === 1 ? '' : 's'} ago`;
  const days = Math.floor(hr / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

/** "for 3 minutes": how long something has been open. */
export function fmtDuration(iso, now = Date.now()) {
  if (!iso) return '-';
  const sec = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (sec < 60) return 'under a minute';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} min`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} h ${min % 60} min`;
  return `${Math.floor(hr / 24)} d ${hr % 24} h`;
}

export const fmtTime = (iso) =>
  iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'medium' }) : '-';
export const fmtNum = (n, digits = 2, minDigits = 0) =>
  n === null || n === undefined
    ? '-'
    : Number(n).toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: minDigits });
export const fmtUsd = (n, digits = 2) => {
  if (n === null || n === undefined) return '-';
  const sign = n < 0 ? '-' : '';
  return `${sign}$${fmtNum(Math.abs(n), digits, digits)}`;
};
export const plural = (n, one, many = `${one}s`) => `${fmtNum(n, 0)} ${n === 1 ? one : many}`;

/** Human description of an alert's problem, e.g. "Load time 44.8 s (limit 15 s)". */
export function alertProblem(a) {
  if (a.rule === 'HIGH_LATENCY') {
    const limit = String(a.threshold ?? '').match(/[\d.]+/)?.[0] ?? '15';
    return `Load time ${fmtNum(Number(a.observed_value), 1, 1)} s (limit ${limit} s)`;
  }
  if (a.rule === 'REFRESH_FAILED') {
    if (a.observed_value === 'TIMED_OUT') return 'Refresh timed out';
    if (a.observed_value === 'FAILED') return 'Refresh failed';
    return 'Refresh not succeeding';
  }
  return a.message;
}
