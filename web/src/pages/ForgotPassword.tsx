import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, Alert, Field } from '../lib';

/**
 * FR-AUT-005. Answers identically whether or not the address is registered, so
 * the form cannot be used to discover who has an account.
 */
export default function ForgotPassword() {
  const nav = useNavigate();
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState<string | null>(null);
  const [devLink, setDevLink] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await api.post<any>('/auth/forgot-password', { email });
      setSent(r.message);
      if (r.resetLink) setDevLink(r.resetLink);
    } catch {
      setSent('If that address has an account, a reset link is on its way.');
    } finally { setBusy(false); }
  }

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
        <h2>Forgotten your password?</h2>
        <p>Give us the address your account was created with and we will send a link.</p>
      </div>

      <div className="login-right">
        <form className="login-form" onSubmit={submit}>
          <h1>Reset password</h1>

          {sent ? (
            <>
              <Alert kind="success">{sent}</Alert>
              {devLink && (
                <Alert kind="info">
                  No mail server is configured, so the link was not delivered.
                  <div style={{ marginTop: 8, wordBreak: 'break-all', fontSize: 12 }}>
                    <a href={devLink}>{devLink}</a>
                  </div>
                </Alert>
              )}
              <button type="button" className="btn btn-block" onClick={() => nav('/signin')}>
                Back to sign in
              </button>
            </>
          ) : (
            <>
              <p className="muted small" style={{ marginTop: 0, marginBottom: 20 }}>
                The link is valid for one hour and can be used once.
              </p>
              <Field label="Email address" required>
                <input type="email" value={email} required autoComplete="username"
                  onChange={(e) => setEmail(e.target.value)} />
              </Field>
              <button className="btn btn-primary btn-block" type="submit" disabled={busy}>
                {busy ? 'Sending…' : 'Send reset link'}
              </button>
              <button type="button" className="btn btn-block" style={{ marginTop: 10 }}
                onClick={() => nav('/signin')}>
                Back to sign in
              </button>
            </>
          )}
        </form>
      </div>
    </div>
  );
}
