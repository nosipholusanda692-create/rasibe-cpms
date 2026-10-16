import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { api, useAuth, useFormError, Card, Alert, Field } from '../lib';

/**
 * Two-factor authentication for the signed-in person (docs/TWO-FACTOR.md).
 *
 * Off: password, then scan the QR code, then confirm with a code, then save the
 * recovery codes. On: turning it off needs the password and a current code.
 */
export default function Security() {
  const { twoFactor } = useAuth();
  const [done, setDone] = useState<string | null>(null);

  return (
    <>
      {twoFactor.required && !twoFactor.enabled && (
        <Alert kind="warn">
          Administrators must use two-factor authentication. Set it up below to
          continue; nothing else is available until you do.
        </Alert>
      )}
      {done && <Alert kind="success">{done}</Alert>}

      {twoFactor.enabled
        ? <TurnOff onDone={() => setDone('Two-factor authentication is off.')} />
        : <TurnOn onDone={() => setDone('Two-factor authentication is on. You will be asked for a code each time you sign in.')} />}
    </>
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

  useEffect(() => {
    if (!setup) return;
    // Drawn here, so the secret never goes to a third-party QR service.
    QRCode.toDataURL(setup.otpauthUri, { margin: 1, width: 200 })
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
    await reload();
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

  if (recoveryCodes) {
    return (
      <Card title="Save your recovery codes"
        subtitle="Each one signs you in once if your phone is not to hand. They will not be shown again."
        footer={
          <div className="btn-row">
            <button className="btn" onClick={download}>Download as a file</button>
            <button className="btn" onClick={() => void navigator.clipboard?.writeText(recoveryCodes.join('\n'))}>
              Copy
            </button>
            <button className="btn btn-primary" disabled={!saved} onClick={() => void finish()}>Done</button>
          </div>
        }>
        <div className="card-body">
          <div className="mono" style={{ display: 'grid', gridTemplateColumns: 'repeat(2, max-content)', gap: '6px 32px' }}>
            {recoveryCodes.map((c) => <div key={c}>{c}</div>)}
          </div>
          <label className="small" style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 16 }}>
            <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
            I have saved these codes somewhere other than this computer
          </label>
        </div>
      </Card>
    );
  }

  if (setup) {
    return (
      <Card title="Scan the code with your authenticator app"
        subtitle="Google Authenticator, Microsoft Authenticator, Authy or similar"
        footer={
          <div className="btn-row">
            <button className="btn" onClick={() => { setSetup(null); setCode(''); err.clear(); }}>Cancel</button>
            <button className="btn btn-primary" disabled={busy || code.trim().length < 6} onClick={() => void confirm()}>
              {busy ? 'Checking…' : 'Turn on'}
            </button>
          </div>
        }>
        <div className="card-body">
          {err.error && <Alert kind="error">{err.error}</Alert>}
          {qr
            ? <img src={qr} width={200} height={200} alt="QR code for your authenticator app" />
            : <Alert kind="info">The QR code could not be drawn. Enter the key below by hand.</Alert>}
          <Field label="Or enter this key by hand" hint="Time-based, six digits">
            <input type="text" readOnly value={setup.secret} className="mono" onFocus={(e) => e.target.select()} />
          </Field>
          <Field label="Code from the app" required error={err.fieldError('code')}
            hint="Enter the six digits the app now shows, to confirm it is set up correctly.">
            <input type="text" value={code} autoComplete="one-time-code" inputMode="numeric" maxLength={6}
              onChange={(e) => setCode(e.target.value)} placeholder="123456" />
          </Field>
        </div>
      </Card>
    );
  }

  return (
    <Card title="Two-factor authentication" subtitle="Off"
      footer={
        <button className="btn btn-primary" disabled={busy || !password} onClick={() => void start()}>
          {busy ? 'Checking…' : 'Set up'}
        </button>
      }>
      <div className="card-body">
        <p className="small" style={{ marginTop: 0 }}>
          After your password, you will also enter a six-digit code from an app on
          your phone. Someone who learns your password still cannot sign in as you.
        </p>
        {err.error && <Alert kind="error">{err.error}</Alert>}
        <Field label="Your current password" required error={err.fieldError('currentPassword')}>
          <input type="password" autoComplete="current-password" value={password}
            onChange={(e) => setPassword(e.target.value)} />
        </Field>
      </div>
    </Card>
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
      await reload();
      onDone();
    } catch (e) { err.capture(e); setCode(''); } finally { setBusy(false); }
  }

  return (
    <Card title="Two-factor authentication" subtitle="On"
      footer={
        <button className="btn btn-danger" disabled={busy || !password || code.trim().length < 6}
          onClick={() => void turnOff()}>
          {busy ? 'Turning off…' : 'Turn off'}
        </button>
      }>
      <div className="card-body">
        <p className="small" style={{ marginTop: 0 }}>
          You are asked for a code from your authenticator app each time you sign in.
          Lost your phone? Sign in with a recovery code, or ask an administrator to reset it.
        </p>
        {twoFactor.required && (
          <Alert kind="info">Administrators must keep two-factor on, so it cannot be turned off here.</Alert>
        )}
        {err.error && <Alert kind="error">{err.error}</Alert>}
        <div className="form-row">
          <Field label="Your current password" required error={err.fieldError('currentPassword')}>
            <input type="password" autoComplete="current-password" value={password}
              onChange={(e) => setPassword(e.target.value)} />
          </Field>
          <Field label="Code from the app, or a recovery code" required error={err.fieldError('code')}>
            <input type="text" value={code} autoComplete="one-time-code" maxLength={20}
              onChange={(e) => setCode(e.target.value)} />
          </Field>
        </div>
      </div>
    </Card>
  );
}
