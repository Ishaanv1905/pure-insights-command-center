import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './auth/AuthContext.jsx';
import Layout from './components/Layout.jsx';
import LoginPage from './pages/LoginPage.jsx';
import OverviewPage from './pages/OverviewPage.jsx';
import ReportsPage from './pages/ReportsPage.jsx';
import ReportDetailPage from './pages/ReportDetailPage.jsx';
import AlertsPage from './pages/AlertsPage.jsx';
import CostPage from './pages/CostPage.jsx';
import DataQualityPage from './pages/DataQualityPage.jsx';
import UsersPage from './pages/UsersPage.jsx';
import NotFoundPage from './pages/NotFoundPage.jsx';

/** Route guard: shows a friendly message instead of a page the role cannot use. */
function Guard({ permission, children }) {
  const { can } = useAuth();
  if (!can(permission)) {
    return (
      <div className="panel">
        <div className="empty">
          <strong>Not available for your role</strong>
          <p>
            This page needs the <code>{permission}</code> permission. Ask an admin to change your role if you need it.
          </p>
        </div>
      </div>
    );
  }
  return children;
}

export default function App() {
  const { user, loading } = useAuth();
  if (loading) return <div className="center">Loading...</div>;
  if (!user) {
    return (
      <Routes>
        <Route path="*" element={<LoginPage />} />
      </Routes>
    );
  }

  return (
    <Routes>
      <Route element={<Layout />}>
        <Route
          index
          element={
            <Guard permission="health:read">
              <OverviewPage />
            </Guard>
          }
        />
        <Route
          path="reports"
          element={
            <Guard permission="reports:read">
              <ReportsPage />
            </Guard>
          }
        />
        <Route
          path="reports/:reportId"
          element={
            <Guard permission="reports:read">
              <ReportDetailPage />
            </Guard>
          }
        />
        {/* The orphaned list now lives inside Reports; keep old links working. */}
        <Route path="orphaned" element={<Navigate to="/reports?view=orphaned" replace />} />
        <Route
          path="alerts"
          element={
            <Guard permission="alerts:read">
              <AlertsPage />
            </Guard>
          }
        />
        <Route
          path="cost"
          element={
            <Guard permission="cost:read">
              <CostPage />
            </Guard>
          }
        />
        <Route
          path="data-quality"
          element={
            <Guard permission="data-quality:read">
              <DataQualityPage />
            </Guard>
          }
        />
        <Route
          path="users"
          element={
            <Guard permission="users:manage">
              <UsersPage />
            </Guard>
          }
        />
        <Route path="login" element={<Navigate to="/" replace />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}
