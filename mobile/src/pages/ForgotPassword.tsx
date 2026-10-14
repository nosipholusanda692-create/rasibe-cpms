import { useState } from 'react';
import { api, Banner } from '../lib';

/**
 * FR-AUT-005 on the phone. Answers identically whether or not the address is
 * registered, so the form cannot be used to discover who has an account.
 */
export default function ForgotPassword({ onBack }: { onBack: () => void }) {
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
    <div className="signin">
      <div className="signin-brand">
        <div className="brand-mark">R</div>
        <div>
          <div className="n">Rasibe</div>
          <div className="s">Timesheets</div>
        </div>
      </div>

      <h1>Reset password</h1>
      <p className="lead">The link is valid for one hour and can be used once.</p>

      <div className="signin-panel">
        {sent ? (
          <>
            <Banner kind="ok">{sent}</Banner>
            {devLink && (
              <Banner kind="pending">
                No mail server is configured. Open this on a desktop browser:
                <div style={{ wordBreak: 'break-all', fontSize: 12, marginTop: 6 }}>{devLink}</div>
              </Banner>
            )}
            <button className="btn btn-block" onClick={onBack} style={{ marginTop: 14 }}>
              Back to sign in
            </button>
          </>
        ) : (
          <form onSubmit={submit}>
            <div className="field">
              <label>Email address</label>
              <input type="email" value={email} required inputMode="email" autoCapitalize="none"
                autoComplete="username" onChange={(e) => setEmail(e.target.value)} />
            </div>
            <button className="btn btn-primary btn-block" type="submit" disabled={busy}>
              {busy ? 'Sending…' : 'Send reset link'}
            </button>
            <button type="button" className="btn btn-block" style={{ marginTop: 10 }} onClick={onBack}>
              Back to sign in
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
