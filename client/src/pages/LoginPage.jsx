import { useState } from 'react';
import { useAuth } from '../auth/AuthContext.jsx';
import { BrandMark } from '../components/ui.jsx';

const DEMO = [
  ['admin@pureinsights.local', 'Admin#2026', 'admin'],
  ['analyst@pureinsights.local', 'Analyst#2026', 'analyst'],
  ['viewer@pureinsights.local', 'Viewer#2026', 'viewer'],
];

export default function LoginPage() {
  const { login } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(email, password);
    } catch (err) {
      setError(err.status === 429 ? 'Too many attempts. Wait a few minutes and try again.' : err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="login-wrap">
      <form className="login" onSubmit={submit}>
        <div className="login-brand">
          <BrandMark size={32} />
          <div>
            <strong>Pure Insights</strong>
            <span>Command Center</span>
          </div>
        </div>
        <p className="secondary">Sign in to see report health, alerts and cost for the analytics portal.</p>
        <label>
          Email
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="username"
            required
          />
        </label>
        <label>
          Password
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
        </label>
        {error && (
          <div className="form-error" role="alert">
            {error}
          </div>
        )}
        <button className="btn primary" disabled={busy}>
          {busy ? 'Signing in...' : 'Sign in'}
        </button>

        <div className="demo">
          <div className="muted">Demo accounts (development only):</div>
          {DEMO.map(([e, p, role]) => (
            <button
              type="button"
              key={role}
              className="link"
              onClick={() => {
                setEmail(e);
                setPassword(p);
              }}
            >
              Use {role}
            </button>
          ))}
        </div>
      </form>
    </main>
  );
}
