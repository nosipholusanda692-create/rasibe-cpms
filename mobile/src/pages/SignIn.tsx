import { useState } from 'react';
import { useAuth, Banner } from '../lib';
import ForgotPassword from './ForgotPassword';

const DEMO = [
  ['Consultant', 'thabo.m@example.co.za'],
  ['Client manager', 's.naidoo@nedgroupit.co.za'],
];

export default function SignIn() {
  const { signIn } = useAuth();
  const [forgot, setForgot] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await signIn(email, password);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not sign in');
    } finally {
      setBusy(false);
    }
  }

  if (forgot) return <ForgotPassword onBack={() => setForgot(false)} />;

  return (
    <div className="signin">
      <div className="signin-brand">
        <div className="brand-mark">R</div>
        <div>
          <div className="n">Rasibe</div>
          <div className="s">Timesheets</div>
        </div>
      </div>

      <h1>Your week, from site.</h1>
      <p className="lead">
        Record hours whether or not you have a signal. Approvals take two taps.
      </p>

      <div className="signin-panel">
        <form onSubmit={submit}>
          {error && <Banner kind="error">{error}</Banner>}

          <div className="field">
            <label>Email address</label>
            <input type="email" value={email} autoComplete="username" required
              inputMode="email" autoCapitalize="none"
              onChange={(e) => setEmail(e.target.value)} />
          </div>

          <div className="field">
            <label>Password</label>
            <input type="password" value={password} autoComplete="current-password" required
              onChange={(e) => setPassword(e.target.value)} />
          </div>

          <button className="btn btn-primary btn-block" type="submit" disabled={busy}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>

          <div className="center" style={{ marginTop: 14 }}>
            <button type="button" className="btn btn-ghost"
              onClick={() => setForgot(true)}>Forgotten your password?</button>
          </div>
        </form>

        {import.meta.env.DEV && (
        <div style={{ marginTop: 18, borderTop: '1px solid var(--line-soft)', paddingTop: 12 }}>
          <div className="field-hint" style={{ marginBottom: 6 }}>Demonstration accounts</div>
          {DEMO.map(([role, mail]) => (
            <div className="demo-row" key={mail}
              onClick={() => { setEmail(mail); setPassword('Password123!'); }}>
              <div className="stack" style={{ flex: 1 }}>
                <span className="demo-role">{role}</span>
                <span className="demo-mail">{mail}</span>
              </div>
              <span className="pill pill-grey">Use</span>
            </div>
          ))}
          <div className="field-hint">Password: Password123!</div>
        </div>
        )}
      </div>
    </div>
  );
}
