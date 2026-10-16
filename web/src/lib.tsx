import React, { createContext, useContext, useEffect, useRef, useState, useCallback } from 'react';

// =====================================================================
// API client
// =====================================================================
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
    public detail?: Record<string, string[]>,
  ) {
    super(message);
  }
}

// NFR-SEC-008. The server sets rasibe_csrf on reads and requires it back as a
// header on writes. Another site can make the browser send our cookies, but it
// cannot read them, so it cannot produce this header.
function csrfHeader(): Record<string, string> {
  const match = document.cookie.match(/(?:^|;\s*)rasibe_csrf=([^;]*)/);
  return match ? { 'X-CSRF-Token': decodeURIComponent(match[1]) } : {};
}

// =====================================================================
// When the server cannot be reached, or answers with something that is not ours
//
// fetch() rejects with a bare "Failed to fetch" when there is no connection or
// the server is down, and a proxy or host in front of the API answers an outage
// with an HTML page, which JSON.parse turns into "Unexpected token <". Neither
// means anything to the person using the screen. Both become an ApiError, so
// every screen that already shows an ApiError's message shows these too.
// =====================================================================
export const UNREACHABLE = "Can't reach the server. Check your connection and try again.";

async function send(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch {
    throw new ApiError(0, UNREACHABLE, 'network_error');
  }
}

/** Reads a body as text; a connection that drops part-way is also "unreachable". */
async function readText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    throw new ApiError(0, UNREACHABLE, 'network_error');
  }
}

function parseJson(text: string): any {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** The server's own message when it sent one, else words suited to the status. */
function failureMessage(status: number, data: any): string {
  if (typeof data?.message === 'string' && data.message) {
    // A server fault carries a reference the support team can find in the log.
    const ref = status >= 500 && typeof data?.errorId === 'string' ? ` (reference ${data.errorId.slice(0, 8)})` : '';
    return `${data.message}${ref}`;
  }
  if (status === 413) return 'That is too large to send.';
  // Our API always answers an error with JSON. A server error with no JSON in it
  // came from something in front of the API (a proxy or host with nothing behind it).
  if (status === 502 || status === 503 || status === 504 || (status >= 500 && data === null)) {
    return 'The service is temporarily unavailable. Please try again in a moment.';
  }
  if (status >= 500) return 'Something went wrong on our side. Please try again.';
  return `The request could not be completed (${status}).`;
}

/** The error code for a failure: the API's own, or one for an outage in front of it. */
function failureCode(status: number, data: any): string | undefined {
  if (data?.error) return data.error;
  if (status === 502 || status === 503 || status === 504 || (status >= 500 && data === null)) return 'service_unavailable';
  return undefined;
}

/** True when the failure says "the server is not there", not "your request was wrong". */
export function isUnreachable(e: unknown): boolean {
  return e instanceof ApiError && (e.status === 0 || e.code === 'service_unavailable');
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await send(`/api${path}`, {
    method,
    credentials: 'include', // the session cookie is httpOnly, so it travels here
    headers: { 'Content-Type': 'application/json', ...csrfHeader() },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await readText(res);
  const data = parseJson(text);

  // A success that is not JSON is not from this API: a proxy's page, a captive
  // portal. Returning null would only crash the screen a moment later.
  if (res.ok && text && data === null) {
    throw new ApiError(res.status, 'The server sent a reply that could not be read. Please try again.', 'bad_response');
  }

  if (!res.ok) {
    const error = new ApiError(res.status, failureMessage(res.status, data), failureCode(res.status, data), data?.detail);
    // A 401 outside /auth means the session is gone (idle, signed out
    // elsewhere, two-factor reset). Inside /auth it can also mean a wrong
    // password or code on a form, so only /auth/me and an explicit
    // session_idle count there. AuthProvider listens.
    const sessionGone = data?.error === 'session_idle' || !path.startsWith('/auth/') || path === '/auth/me';
    if (res.status === 401 && sessionGone) {
      window.dispatchEvent(new CustomEvent(SESSION_ENDED, { detail: error }));
    }
    throw error;
  }
  return data as T;
}

const SESSION_ENDED = 'rasibe:session-ended';

/** POSTs (so the CSRF header goes with it) and saves the response as a file. */
async function download(path: string, filename: string): Promise<void> {
  const res = await send(`/api${path}`, {
    method: 'POST',
    credentials: 'include',
    headers: csrfHeader(),
  });
  if (!res.ok) {
    const data = parseJson(await readText(res));
    throw new ApiError(res.status, failureMessage(res.status, data), failureCode(res.status, data), data?.detail);
  }

  let blob: Blob;
  try {
    blob = await res.blob();
  } catch {
    throw new ApiError(0, UNREACHABLE, 'network_error');
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0); // some browsers start the save after click() returns
}

export const api = {
  get: <T,>(p: string) => request<T>('GET', p),
  post: <T,>(p: string, b?: unknown) => request<T>('POST', p, b),
  put: <T,>(p: string, b?: unknown) => request<T>('PUT', p, b),
  patch: <T,>(p: string, b?: unknown) => request<T>('PATCH', p, b),
  download,
};

// =====================================================================
// Types
// =====================================================================
export type Role = 'ADMINISTRATOR' | 'RECRUITER' | 'CONSULTANT' | 'CLIENT_MANAGER';

export interface CurrentUser {
  userId: string;
  email: string;
  fullName: string;
  role: Role;
  consultantId: string | null;
  clients: { clientId: string; name: string }[];
}

export interface TwoFactorState {
  enabled: boolean;
  /** An administrator who must enrol before anything else will answer. */
  required: boolean;
}

interface Me {
  user: CurrentUser;
  capabilities: string[];
  landing: string;
  twoFactor?: TwoFactorState;
}

/** The first sign-in step either finishes, or asks for the code. */
export type SignInResult = { landing: string } | { twoFactorRequired: true };

// =====================================================================
// Auth context
// =====================================================================
interface AuthValue {
  user: CurrentUser | null;
  capabilities: string[];
  landing: string;
  twoFactor: TwoFactorState;
  loading: boolean;
  /** The server could not be reached when the page opened, so sign-in state is unknown. */
  unreachable: boolean;
  retry: () => void;
  /** Why the last session ended without the person signing out, for the sign-in page. */
  endedReason: string | null;
  /** A one-off message to show after signing in (recovery codes running low). */
  notice: string | null;
  clearNotice: () => void;
  can: (capability: string) => boolean;
  signIn: (email: string, password: string) => Promise<SignInResult>;
  verifyCode: (code: string) => Promise<string>;
  reload: () => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthValue | null>(null);
const NO_TWO_FACTOR: TwoFactorState = { enabled: false, required: false };

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [capabilities, setCapabilities] = useState<string[]>([]);
  const [landing, setLanding] = useState('/dashboard');
  const [twoFactor, setTwoFactor] = useState<TwoFactorState>(NO_TWO_FACTOR);
  const [loading, setLoading] = useState(true);
  const [unreachable, setUnreachable] = useState(false);
  const [endedReason, setEndedReason] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const signedIn = useRef(false);

  const apply = useCallback((me: Me | null) => {
    signedIn.current = me !== null;
    setUser(me?.user ?? null);
    setCapabilities(me?.capabilities ?? []);
    if (me) setLanding(me.landing);
    setTwoFactor(me?.twoFactor ?? NO_TWO_FACTOR);
  }, []);

  const load = useCallback(async () => {
    try {
      apply(await api.get<Me>('/auth/me'));
      setUnreachable(false);
    } catch (e) {
      // If the server cannot be reached we do not know whether this person is
      // signed in. Saying "signed out" would send them to a sign-in form that
      // cannot work either; say so, and offer to try again.
      if (isUnreachable(e)) {
        setUnreachable(true);
      } else {
        setUnreachable(false);
        // Reopening the tab after the idle limit lands here, not in the listener.
        if (e instanceof ApiError && e.code === 'session_idle') setEndedReason(e.message);
        apply(null);
      }
    } finally {
      setLoading(false);
    }
  }, [apply]);

  const retry = useCallback(() => {
    setLoading(true);
    void load();
  }, [load]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const onEnded = (ev: Event) => {
      if (!signedIn.current) return; // not signed in: a 401 is expected, not news
      const e = (ev as CustomEvent<ApiError>).detail;
      setEndedReason(e.code === 'session_idle' ? e.message : 'Your session has ended. Sign in again.');
      apply(null);
    };
    window.addEventListener(SESSION_ENDED, onEnded);
    return () => window.removeEventListener(SESSION_ENDED, onEnded);
  }, [apply]);

  const finish = useCallback(async (r: { landing: string; recoveryCodesRemaining?: number }) => {
    apply(await api.get<Me>('/auth/me'));
    setEndedReason(null);
    if (r.recoveryCodesRemaining !== undefined && r.recoveryCodesRemaining <= 3) {
      setNotice(r.recoveryCodesRemaining === 0
        ? 'You have used your last recovery code. Set up two-factor again under Sign-in security to get new ones.'
        : `You have ${r.recoveryCodesRemaining} recovery code${r.recoveryCodesRemaining === 1 ? '' : 's'} left. Turn two-factor off and on again under Sign-in security to get a fresh set.`);
    }
    return r.landing;
  }, [apply]);

  const signIn = useCallback(async (email: string, password: string): Promise<SignInResult> => {
    const r = await api.post<{ landing: string } | { twoFactorRequired: true }>('/auth/login', { email, password });
    if ('twoFactorRequired' in r) return r;
    return { landing: await finish(r) };
  }, [finish]);

  const verifyCode = useCallback(async (code: string) => {
    const r = await api.post<{ landing: string; recoveryCodesRemaining?: number }>('/auth/login/verify', { code });
    return finish(r);
  }, [finish]);

  const reload = useCallback(async () => {
    apply(await api.get<Me>('/auth/me'));
  }, [apply]);

  const signOut = useCallback(async () => {
    try {
      await api.post('/auth/logout');
    } catch (e) {
      // 401: the session was already gone, which is what signing out wanted.
      // Anything else (no connection) means the server still holds the session,
      // so stay signed in and let the caller say so.
      if (!(e instanceof ApiError && e.status === 401)) throw e;
    }
    setEndedReason(null);
    setNotice(null);
    apply(null);
  }, [apply]);

  const can = useCallback((c: string) => capabilities.includes(c), [capabilities]);
  const clearNotice = useCallback(() => setNotice(null), []);

  return (
    <AuthContext.Provider value={{
      user, capabilities, landing, twoFactor, loading, unreachable, retry, endedReason, notice, clearNotice,
      can, signIn, verifyCode, reload, signOut,
    }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const v = useContext(AuthContext);
  if (!v) throw new Error('useAuth must be used inside AuthProvider');
  return v;
}

// =====================================================================
// Formatting
// =====================================================================
export const money = (v: number | string | null | undefined, currency = 'R') =>
  v === null || v === undefined || v === ''
    ? '—'
    : `${currency} ${Number(v).toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export const hours = (v: number | string | null | undefined) =>
  v === null || v === undefined ? '—' : Number(v).toFixed(2);

export const date = (v: string | null | undefined) =>
  !v ? '—' : new Date(v).toLocaleDateString('en-ZA', { day: '2-digit', month: 'short', year: 'numeric' });

export const dateShort = (v: string | null | undefined) =>
  !v ? '—' : new Date(v).toLocaleDateString('en-ZA', { day: '2-digit', month: 'short' });

export const initials = (name: string) =>
  name.split(' ').filter(Boolean).slice(0, 2).map((p) => p[0]?.toUpperCase()).join('');

export const titleCase = (v: string | null | undefined) =>
  !v ? '—' : v.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (m) => m.toUpperCase());

// =====================================================================
// Shared components
// =====================================================================
const STATUS_TONE: Record<string, string> = {
  // waiting
  SUBMITTED: 'amber', PENDING_SYNC: 'amber', AWAITING_APPROVAL: 'amber',
  PENDING_RATE_APPROVAL: 'amber', PENDING_START: 'amber', SHORTLISTING: 'amber',
  INTERVIEWING: 'amber', OFFERED: 'amber', ENDING_SOON: 'amber',
  // trouble
  REJECTED: 'red', OVERDUE: 'red', TERMINATED: 'red', CANCELLED: 'red',
  DECLINED_BY_CLIENT: 'red', WITHDRAWN: 'red',
  // settled
  APPROVED: 'green', PAID: 'green', ACTIVE: 'green', PLACED: 'green', FILLED: 'green',
  // neutral
  DRAFT: 'grey', LOCKED: 'grey', ENDED: 'grey', OPEN: 'blue', ISSUED: 'blue',
  INVOICED: 'blue', PART_PAID: 'blue', RENEWED: 'blue', SHORTLISTED: 'blue',
};

export function Status({ value }: { value: string | null | undefined }) {
  if (!value) return <span className="muted">—</span>;
  const tone = STATUS_TONE[value] ?? 'grey';
  return <span className={`pill pill-${tone}`}>{titleCase(value)}</span>;
}

export function Card({
  title, subtitle, action, children, footer,
}: {
  title?: string; subtitle?: string; action?: React.ReactNode;
  children: React.ReactNode; footer?: React.ReactNode;
}) {
  return (
    <section className="card">
      {(title || action) && (
        <div className="card-head">
          <div>
            {title && <h2>{title}</h2>}
            {subtitle && <div className="sub">{subtitle}</div>}
          </div>
          <div className="spacer" />
          {action}
        </div>
      )}
      {children}
      {footer && <div className="card-foot">{footer}</div>}
    </section>
  );
}

export function Tile({
  label, value, note, tone, restricted,
}: {
  label: string; value: React.ReactNode; note?: React.ReactNode;
  tone?: 'amber' | 'red' | 'green' | 'brand'; restricted?: boolean;
}) {
  return (
    <div className={`tile${tone ? ` accent-${tone}` : ''}`}>
      <div className="tile-label">{label}</div>
      <div className="tile-value">{value}</div>
      {note && <div className="tile-note">{note}</div>}
      {restricted && <div className="tile-restricted">Administrator only</div>}
    </div>
  );
}

export function Field({
  label, required, error, hint, children,
}: {
  label: string; required?: boolean; error?: string; hint?: string; children: React.ReactNode;
}) {
  return (
    <div className="field">
      <label>
        {label} {required && <span className="req">*</span>}
      </label>
      {children}
      {error && <div className="field-error">{error}</div>}
      {hint && !error && <div className="field-hint">{hint}</div>}
    </div>
  );
}

export function Alert({ kind, children }: { kind: 'error' | 'success' | 'info' | 'warn'; children: React.ReactNode }) {
  return <div className={`alert alert-${kind}`}>{children}</div>;
}

export function Empty({ message }: { message: string }) {
  return <div className="empty">{message}</div>;
}

export function Loading() {
  return <div className="loading">Loading…</div>;
}

export function Person({ name, sub }: { name: string; sub?: string }) {
  return (
    <div className="person">
      <div className="avatar">{initials(name)}</div>
      <div className="stack">
        <span className="person-name">{name}</span>
        {sub && <span className="person-role">{sub}</span>}
      </div>
    </div>
  );
}

export function Modal({
  title, onClose, children, footer,
}: {
  title: string; onClose: () => void; children: React.ReactNode; footer?: React.ReactNode;
}) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="card-head">
          <h2>{title}</h2>
          <div className="spacer" />
          <button className="btn btn-sm" onClick={onClose}>Close</button>
        </div>
        <div className="card-body">{children}</div>
        {footer && <div className="card-foot">{footer}</div>}
      </div>
    </div>
  );
}

/** Turns an ApiError into a message plus per-field errors. */
export function useFormError() {
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string[]>>({});

  const capture = (e: unknown) => {
    if (e instanceof ApiError) {
      setError(e.message);
      setFields(e.detail ?? {});
    } else {
      setError(e instanceof Error ? e.message : 'Something went wrong');
      setFields({});
    }
  };
  const clear = () => { setError(null); setFields({}); };
  const fieldError = (name: string) => fields[name]?.[0];

  return { error, fieldError, capture, clear };
}

/** Simple data loader with loading and error state. */
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    setLoading(true);
    fn()
      .then((d) => { setData(d); setError(null); })
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not load'))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => { reload(); }, [reload]);

  return { data, loading, error, reload };
}
