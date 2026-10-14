import { useState } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { api, useLoad, Alert, Field, Loading } from '../lib';

/**
 * Setting a password from an invitation or a reset link (FR-AUT-005, FR-AUT-010).
 *
 * Runs with no session. The token in the query string is the only credential,
 * and it is spent the moment the password is set.
 */
export default function SetPassword({ purpose }: { purpose: 'invite' | 'reset' }) {
  const [params] = useSearchParams();
  const nav = useNavigate();
  const token = params.get('token') ?? '';

  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  const subject = useLoad<any>(
    () => token
      ? api.get(`/auth/token/${purpose}?token=${encodeURIComponent(token)}`)
      : Promise.reject(new Error('That link is not valid.')),
    [token, purpose],
  );

  const rules = [
    { ok: password.length >= 10, text: 'At least 10 characters' },
    { ok: /[A-Z]/.test(password), text: 'An upper case letter' },
    { ok: /[a-z]/.test(password), text: 'A lower case letter' },
    { ok: /[0-9]/.test(password), text: 'A number' },
  ];
  const allOk = rules.every((r) => r.ok) && password === confirm && confirm.length > 0;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null); setFieldError(null);
    try {
      await api.post(`/auth/token/${purpose}`, { token, password });
      setDone(true);
    } catch (err: any) {
      setError(err?.message ?? 'Could not set the password');
      setFieldError(err?.detail?.password?.[0] ?? null);
    } finally { setBusy(false); }
  }

  if (subject.loading) return <div className="login-page"><div className="login-right"><Loading /></div></div>;

  return (
    <div className="login-page">
      <div className="login-left">
        <div className="row" style={{ marginBottom: 30 }}>
          <div className="brand-mark">R</div>
          <div>
            <div className="brand-name">Rasibe Global Solutions</div>
            <div className="brand-sub">Consultant placement management</div>
          </div>
        </div>
        <h2>{purpose === 'invite' ? 'Welcome.' : 'Set a new password.'}</h2>
        <p>
          {purpose === 'invite'
            ? 'Choose a password and the account is yours. Nobody else will know it, including the administrator who created the account.'
            : 'Choose a new password. Every other session will be signed out.'}
        </p>
      </div>

      <div className="login-right">
        <form className="login-form" onSubmit={submit}>
          {subject.error ? (
            <>
              <h1>Link not valid</h1>
              <Alert kind="error">
                {purpose === 'invite'
                  ? 'This invitation has already been used or has expired. Ask an administrator to send a new one.'
                  : 'This reset link has already been used or has expired. Request a new one.'}
              </Alert>
              <button type="button" className="btn btn-block" onClick={() => nav('/signin')}>
                Back to sign in
              </button>
            </>
          ) : done ? (
            <>
              <h1>All set</h1>
              <Alert kind="success">
                Your password has been set. You can sign in now.
              </Alert>
              <button type="button" className="btn btn-primary btn-block" onClick={() => nav('/signin')}>
                Sign in
              </button>
            </>
          ) : (
            <>
              <h1>{purpose === 'invite' ? 'Choose a password' : 'New password'}</h1>
              <p className="muted small" style={{ marginTop: 0, marginBottom: 20 }}>
                {subject.data?.fullName} · {subject.data?.email}
              </p>

              {error && <Alert kind="error">{fieldError ?? error}</Alert>}

              <Field label="Password" required>
                <input type="password" value={password} autoComplete="new-password" required
                  onChange={(e) => setPassword(e.target.value)} />
              </Field>

              <Field label="Confirm password" required
                error={confirm && password !== confirm ? 'The two do not match' : undefined}>
                <input type="password" value={confirm} autoComplete="new-password" required
                  onChange={(e) => setConfirm(e.target.value)} />
              </Field>

              <ul style={{ listStyle: 'none', padding: 0, margin: '0 0 18px', fontSize: 13 }}>
                {rules.map((r) => (
                  <li key={r.text} style={{ color: r.ok ? 'var(--green)' : 'var(--ink-faint)' }}>
                    {r.ok ? '✓' : '○'} {r.text}
                  </li>
                ))}
              </ul>

              <button className="btn btn-primary btn-block" type="submit" disabled={busy || !allOk}>
                {busy ? 'Setting…' : 'Set password'}
              </button>
            </>
          )}
        </form>
      </div>
    </div>
  );
}
