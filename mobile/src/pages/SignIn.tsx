import { useState } from 'react';
import { useAuth, Banner } from '../lib';
import ForgotPassword from './ForgotPassword';


export default function SignIn() {
  const { signIn } = useAuth();
  const [forgot, setForgot] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [touched, setTouched] = useState<{ email?: boolean; password?: boolean }>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const emailError = email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.trim())
    ? 'Enter a valid email address' : undefined;
  const showEmailError = touched.email && !!emailError;
  const canSubmit = email.trim() !== '' && password !== '' && !emailError;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setTouched({ email: true, password: true });
    if (!canSubmit) return;
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
              aria-invalid={showEmailError ? true : undefined}
              onChange={(e) => setEmail(e.target.value)}
              onBlur={() => setTouched((t) => ({ ...t, email: true }))} />
            {showEmailError && <div className="field-error">{emailError}</div>}
          </div>

          <div className="field">
            <label>Password</label>
            <input type="password" value={password} autoComplete="current-password" required
              onChange={(e) => setPassword(e.target.value)} />
          </div>

          <button className="btn btn-primary btn-block" type="submit"
            disabled={busy || (touched.email && !canSubmit)}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>

          <div className="center" style={{ marginTop: 14 }}>
            <button type="button" className="btn btn-ghost"
              onClick={() => setForgot(true)}>Forgotten your password?</button>
          </div>
        </form>

      </div>
    </div>
  );
}
