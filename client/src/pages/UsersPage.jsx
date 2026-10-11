import { useState } from 'react';
import { api } from '../api/client.js';
import { useAuth } from '../auth/AuthContext.jsx';
import { useApi } from '../hooks/useApi.js';
import { ErrorBox, Loading, fmtTime } from '../components/ui.jsx';

const ROLES = [
  ['viewer', 'Viewer'],
  ['analyst', 'Analyst'],
  ['admin', 'Admin'],
];

export default function UsersPage() {
  const { user: me } = useAuth();
  const { data, error, reload } = useApi('/users');
  const [form, setForm] = useState({ email: '', password: '', role: 'viewer' });
  const [formError, setFormError] = useState(null);
  const [rowError, setRowError] = useState(null);
  const [created, setCreated] = useState(null);

  async function create(e) {
    e.preventDefault();
    setFormError(null);
    setCreated(null);
    try {
      await api.post('/users', form);
      setCreated(form.email);
      setForm({ email: '', password: '', role: 'viewer' });
      reload();
    } catch (err) {
      setFormError(err.details?.length ? err.details.join('. ') : err.message);
    }
  }

  async function changeRole(id, role) {
    setRowError(null);
    try {
      await api.patch(`/users/${id}`, { role });
      reload();
    } catch (err) {
      setRowError(`Could not change the role: ${err.message}`);
    }
  }

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Users</h1>
          <p className="lede">
            Viewers can read health, reports and alerts. Analysts can also acknowledge alerts and see cost and data
            quality. Admins can assign owners and manage users.
          </p>
        </div>
      </div>

      <section className="panel" aria-label="Users">
        <ErrorBox error={error} what="load users" />
        {rowError && (
          <div className="error-box" role="alert" style={{ marginTop: 16 }}>
            {rowError}
          </div>
        )}
        {!data ? (
          <Loading>Loading users</Loading>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Email</th>
                  <th>Role</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((u) => (
                  <tr key={u.id}>
                    <td className="strong">
                      {u.email}
                      {u.id === me.id && <div className="sub">You</div>}
                    </td>
                    <td>
                      <label className="visually-hidden" htmlFor={`role-${u.id}`}>
                        Role for {u.email}
                      </label>
                      <select
                        id={`role-${u.id}`}
                        value={u.role}
                        disabled={u.id === me.id}
                        title={u.id === me.id ? 'You cannot change your own role' : undefined}
                        onChange={(e) => changeRole(u.id, e.target.value)}
                      >
                        {ROLES.map(([value, label]) => (
                          <option key={value} value={value}>
                            {label}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="nowrap small secondary">{fmtTime(u.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="panel" aria-labelledby="add-user">
        <div className="panel-head">
          <div>
            <h2 id="add-user">Add a user</h2>
            <p>They can sign in straight away with this email and password.</p>
          </div>
        </div>
        <form className="panel-body form-grid" onSubmit={create}>
          <label>
            Email
            <input
              type="email"
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
              autoComplete="off"
              required
            />
          </label>
          <label>
            Password (8 or more characters)
            <input
              type="password"
              value={form.password}
              minLength={8}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
              autoComplete="new-password"
              required
            />
          </label>
          <label>
            Role
            <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
              {ROLES.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <button className="btn primary">Add user</button>
          {formError && (
            <div className="form-error" role="alert" style={{ width: '100%' }}>
              {formError}
            </div>
          )}
          {created && (
            <div className="small secondary" role="status" style={{ width: '100%' }}>
              Added {created}.
            </div>
          )}
        </form>
      </section>
    </div>
  );
}
