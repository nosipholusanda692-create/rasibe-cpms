import { useState } from 'react';
import { useAuth, ApiError, Banner } from '../lib';
import ForgotPassword from './ForgotPassword';


export default function SignIn() {
  const { signIn, verifyCode } = useAuth();
  const [forgot, setForgot] = useState(false);
  // After a correct password, an account with two-factor is asked for a code.
  const [step, setStep] = useState<'password' | 'code'>('password');
  const [code, setCode] = useState('');
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
      const r = await signIn(email, password);
      if ('twoFactorRequired' in r) {
        setPassword('');
        setCode('');
        setStep('code');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not sign in');
    } finally {
      setBusy(false);
    }
  }

  async function submitCode(e: React.FormEvent) {
    e.preventDefault();
    if (code.trim().length < 6) return;
    setBusy(true);
    setError(null);
    try {
      await verifyCode(code);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'two_factor_expired') {
        // Five minutes passed or five wrong codes: the password step starts again.
        setStep('password');
        setError(err.message);
      } else {
        setError(err instanceof Error ? err.message : 'Could not check that code');
        setCode('');
      }
    } finally {
      setBusy(false);
    }
  }

  function backToPassword() {
    setStep('password');
    setCode('');
    setError(null);
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
        {step === 'code' ? (
          <form onSubmit={submitCode}>
            {error && <Banner kind="error">{error}</Banner>}
            <div className="sheet-title">Enter your code</div>
            <p className="small muted" style={{ marginTop: 4 }}>
              Open your authenticator app and enter the six digits it shows for Rasibe.
              Lost your phone? Enter one of your recovery codes instead.
            </p>
            <div className="field">
              <label>Code</label>
              <input type="text" value={code} autoComplete="one-time-code" inputMode="text"
                autoCapitalize="none" autoFocus maxLength={20} placeholder="123456"
                onChange={(e) => setCode(e.target.value)} />
            </div>
            <button className="btn btn-primary btn-block" type="submit"
              disabled={busy || code.trim().length < 6}>
              {busy ? 'Checking…' : 'Sign in'}
            </button>
            <button type="button" className="btn btn-block" style={{ marginTop: 10 }}
              onClick={backToPassword}>Use a different account</button>
          </form>
        ) : (
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
        )}

      </div>
    </div>
  );
}
