import { Link, NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext.jsx';
import { useRealtime } from '../realtime/RealtimeContext.jsx';
import { CONNECTION, SEVERITY, toneClass } from '../theme/colourKey.js';
import ColourKeyButton from './ColourKeyDialog.jsx';
import { BrandMark, CloseIcon, Dot, alertProblem } from './ui.jsx';

// Navigation entries, each shown only if the user has the permission.
const NAV = [
  { to: '/', label: 'Overview', permission: 'health:read', end: true },
  { to: '/reports', label: 'Reports', permission: 'reports:read' },
  { to: '/alerts', label: 'Alerts', permission: 'alerts:read' },
  { to: '/cost', label: 'Cost', permission: 'cost:read' },
  { to: '/data-quality', label: 'Data quality', permission: 'data-quality:read' },
  { to: '/users', label: 'Users', permission: 'users:manage' },
];

const MAX_TOASTS = 3;

export default function Layout() {
  const { user, logout, can } = useAuth();
  const { status, toasts, dismissToast } = useRealtime();
  const conn = CONNECTION[status] ?? CONNECTION.disconnected;

  return (
    <div className="app">
      <header>
        <div className="masthead">
          <div className="wrap masthead-inner">
            <Link to="/" className="brand" aria-label="Pure Insights Command Center, platform health">
              <BrandMark />
              <span className="brand-name">
                <strong>Pure Insights</strong>
                <span>Command Center</span>
              </span>
            </Link>
            <div className="session">
              <span className="connection" title={`Real-time connection: ${conn.label.toLowerCase()}`}>
                <Dot tone={conn.tone} />
                {conn.label}
              </span>
              <span className="who">
                <span>{user.email}</span>
                <span className="role">{user.role}</span>
              </span>
              <button className="link" onClick={logout}>
                Log out
              </button>
            </div>
          </div>
        </div>
        <div className="navbar">
          <div className="wrap navbar-inner">
            <nav className="tabs-nav" aria-label="Main">
              {NAV.filter((n) => can(n.permission)).map((n) => (
                <NavLink key={n.to} to={n.to} end={n.end}>
                  {n.label}
                </NavLink>
              ))}
            </nav>
            <ColourKeyButton />
          </div>
        </div>
      </header>

      <main className="wrap">
        <Outlet />
      </main>

      <div className="toasts" aria-live="polite">
        {toasts.slice(0, MAX_TOASTS).map(({ id, alert }) => {
          const tone = SEVERITY[alert.severity]?.tone ?? 'warning';
          return (
            <div key={id} className={`toast ${toneClass(tone)}`} role="status">
              <div className="toast-title">New {alert.severity} alert</div>
              <button className="icon-button" onClick={() => dismissToast(id)} aria-label="Dismiss notification">
                <CloseIcon />
              </button>
              <div className="toast-body">
                <Link to={`/reports/${encodeURIComponent(alert.report_id)}`}>{alert.report_id}</Link>
                {alert.report_name ? `, ${alert.report_name}` : ''}: {alertProblem(alert)}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
