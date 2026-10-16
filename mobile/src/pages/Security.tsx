import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import QRCode from 'qrcode';
import { api, ApiError, useAuth, Banner } from '../lib';

/**
 * Two-factor authentication on the phone (docs/TWO-FACTOR.md).
 *
 * Off: password, then scan the QR code, then confirm with a code, then save the
 * recovery codes. On: turning it off needs the password and a current code.
 *
 * Everything here needs a connection: the server holds the secret and checks
 * the code, so there is nothing sensible to queue for later.
 */

/** What to say, and which fields the server objected to. */
function describe(e: unknown): { message: string; fields: Record<string, string[]> } {
  if (e instanceof ApiError) return { message: e.message, fields: e.detail ?? {} };
  // fetch rejects with a TypeError when there is no connection at all.
  if (e instanceof TypeError) {
    return { message: 'No connection. Try again when you are online.', fields: {} };
  }
  return { message: e instanceof Error ? e.message : 'Something went wrong', fields: {} };
}

function useFormError() {
  const [state, setState] = useState<{ message: string; fields: Record<string, string[]> } | null>(null);
  return {
    message: state?.message ?? null,
    field: (name: string) => state?.fields[name]?.[0],
    capture: (e: unknown) => setState(describe(e)),
    clear: () => setState(null),
  };
}

export default function Security() {
  const nav = useNavigate();
  const { twoFactor } = useAuth();
  const [done, setDone] = useState<string | null>(null);

  return (
    <div className="screen has-tabs">
      <header className="appbar">
        <button className="appbar-btn" aria-label="Back to account" onClick={() => nav('/account')}>‹</button>
        <h1>Sign-in security</h1>
      </header>

      {done && <Banner kind="ok">{done}</Banner>}

      {twoFactor.enabled
        ? <TurnOff onDone={() => setDone('Two-factor authentication is off.')} />
        : <TurnOn onDone={() => setDone('Two-factor authentication is on. You will be asked for a code each time you sign in.')} />}
    </div>
  );
}

function TurnOn({ onDone }: { onDone: () => void }) {
  const { reload } = useAuth();
  const err = useFormError();
  const [busy, setBusy] = useState(false);
  const [password, setPassword] = useState('');
  const [setup, setSetup] = useState<{ secret: string; otpauthUri: string } | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!setup) return;
    // Drawn on the phone, so the secret never goes to a third-party QR service.
    QRCode.toDataURL(setup.otpauthUri, { margin: 1, width: 220 })
      .then(setQr)
      .catch(() => setQr(null));
  }, [setup]);

  async function start() {
    setBusy(true); err.clear();
    try {
      setSetup(await api.post<{ secret: string; otpauthUri: string }>('/auth/2fa/setup', { currentPassword: password }));
      setPassword('');
    } catch (e) { err.capture(e); } finally { setBusy(false); }
  }

  async function confirm() {
    setBusy(true); err.clear();
    try {
      const r = await api.post<{ recoveryCodes: string[] }>('/auth/2fa/enable', { code });
      setRecoveryCodes(r.recoveryCodes);
      setSetup(null);
    } catch (e) { err.capture(e); setCode(''); } finally { setBusy(false); }
  }

  async function finish() {
    try { await reload(); } catch { /* the account is set up; the next load will show it */ }
    onDone();
  }

  function download() {
    const text = `Rasibe CPMS recovery codes\nEach code works once. Keep them somewhere safe.\n\n${recoveryCodes!.join('\n')}\n`;
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'rasibe-recovery-codes.txt';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(recoveryCodes!.join('\n'));
      setCopied(true);
    } catch { setCopied(false); }
  }

  if (recoveryCodes) {
    return (
      <section className="card">
        <div className="card-head">
          <div>
            <h2>Save your recovery codes</h2>
            <div className="sub">Each one signs you in once if your phone is lost. They will not be shown again.</div>
          </div>
        </div>
        <div className="card-body">
          <div className="codes">
            {recoveryCodes.map((c) => <div key={c}>{c}</div>)}
          </div>
          <label className="check">
            <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
            <span>I have saved these codes somewhere other than this phone</span>
          </label>
          <div className="btn-stack">
            <button className="btn btn-block" onClick={download}>Download as a file</button>
            <button className="btn btn-block" onClick={() => void copy()}>{copied ? 'Copied' : 'Copy'}</button>
            <button className="btn btn-primary btn-block" disabled={!saved} onClick={() => void finish()}>Done</button>
          </div>
        </div>
      </section>
    );
  }

  if (setup) {
    return (
      <section className="card">
        <div className="card-head">
          <div>
            <h2>Scan with your authenticator app</h2>
            <div className="sub">Google Authenticator, Microsoft Authenticator, Authy or similar</div>
          </div>
        </div>
        <div className="card-body">
          {err.message && <Banner kind="error">{err.message}</Banner>}
          <p className="small muted" style={{ marginTop: 0 }}>
            Setting up on this phone? You cannot scan your own screen. Open the link below, or enter the
            key in your authenticator app. On another device, scan the code.
          </p>
          <a className="btn btn-block" href={setup.otpauthUri} style={{ marginBottom: 14 }}>
            Open in authenticator app
          </a>
          {qr
            ? <img className="qr" src={qr} width={220} height={220} alt="QR code for your authenticator app" />
            : <Banner kind="pending">The QR code could not be drawn. Enter the key below by hand.</Banner>}
          <div className="field">
            <label>Or enter this key by hand</label>
            <input type="text" readOnly value={setup.secret} className="mono"
              onFocus={(e) => e.target.select()} />
            <div className="field-hint">Time-based, six digits</div>
          </div>
          <div className="field">
            <label>Code from the app</label>
            <input type="text" value={code} autoComplete="one-time-code" inputMode="numeric"
              maxLength={6} placeholder="123456" onChange={(e) => setCode(e.target.value)} />
            {err.field('code') && <div className="field-error">{err.field('code')}</div>}
            <div className="field-hint">Enter the six digits the app now shows, to confirm it is set up.</div>
          </div>
          <div className="btn-stack">
            <button className="btn btn-primary btn-block" disabled={busy || code.trim().length < 6}
              onClick={() => void confirm()}>{busy ? 'Checking…' : 'Turn on'}</button>
            <button className="btn btn-block"
              onClick={() => { setSetup(null); setCode(''); err.clear(); }}>Cancel</button>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="card">
      <div className="card-head">
        <div>
          <h2>Two-factor authentication</h2>
          <div className="sub">Off</div>
        </div>
      </div>
      <div className="card-body">
        <p className="small muted" style={{ marginTop: 0 }}>
          After your password, you will also enter a six-digit code from an app on your phone.
          Someone who learns your password still cannot sign in as you.
        </p>
        {err.message && <Banner kind="error">{err.message}</Banner>}
        <div className="field">
          <label>Your current password</label>
          <input type="password" autoComplete="current-password" value={password}
            onChange={(e) => setPassword(e.target.value)} />
          {err.field('currentPassword') && <div className="field-error">{err.field('currentPassword')}</div>}
        </div>
        <button className="btn btn-primary btn-block" disabled={busy || !password}
          onClick={() => void start()}>{busy ? 'Checking…' : 'Set up'}</button>
      </div>
    </section>
  );
}

function TurnOff({ onDone }: { onDone: () => void }) {
  const { reload, twoFactor } = useAuth();
  const err = useFormError();
  const [busy, setBusy] = useState(false);
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');

  async function turnOff() {
    if (!window.confirm('Turn off two-factor authentication? Your recovery codes will stop working.')) return;
    setBusy(true); err.clear();
    try {
      await api.post('/auth/2fa/disable', { currentPassword: password, code });
      setPassword(''); setCode('');
      try { await reload(); } catch { /* it is off; the next load will show it */ }
      onDone();
    } catch (e) { err.capture(e); setCode(''); } finally { setBusy(false); }
  }

  return (
    <section className="card">
      <div className="card-head">
        <div>
          <h2>Two-factor authentication</h2>
          <div className="sub">On</div>
        </div>
        <span className="spacer" />
        <span className="pill pill-green">On</span>
      </div>
      <div className="card-body">
        <p className="small muted" style={{ marginTop: 0 }}>
          You enter a code from your authenticator app each time you sign in. Lost your phone?
          Sign in with a recovery code, or ask an administrator to reset it.
        </p>
        {twoFactor.required && (
          <Banner kind="pending">Administrators must keep two-factor on, so it cannot be turned off here.</Banner>
        )}
        {err.message && <Banner kind="error">{err.message}</Banner>}
        <div className="field">
          <label>Your current password</label>
          <input type="password" autoComplete="current-password" value={password}
            onChange={(e) => setPassword(e.target.value)} />
          {err.field('currentPassword') && <div className="field-error">{err.field('currentPassword')}</div>}
        </div>
        <div className="field">
          <label>Code from the app, or a recovery code</label>
          <input type="text" value={code} autoComplete="one-time-code" autoCapitalize="none"
            maxLength={20} onChange={(e) => setCode(e.target.value)} />
          {err.field('code') && <div className="field-error">{err.field('code')}</div>}
        </div>
        <button className="btn btn-danger btn-block" disabled={busy || !password || code.trim().length < 6}
          onClick={() => void turnOff()}>{busy ? 'Turning off…' : 'Turn off'}</button>
      </div>
    </section>
  );
}
