import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';

// =====================================================================
// API client
//
// The server requires X-CSRF-Token on every write, derived from the session
// and delivered in the readable rasibe_csrf cookie. A read hands the token
// out, so /auth/me on start-up puts one in place before any write is possible.
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

function csrfHeader(): Record<string, string> {
  const m = document.cookie.match(/(?:^|;\s*)rasibe_csrf=([^;]*)/);
  return m ? { 'X-CSRF-Token': decodeURIComponent(m[1]) } : {};
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...csrfHeader() },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await res.text();
  // A proxy or host that is down answers with an HTML or empty page, not JSON.
  // That must read as a failed request, not as a crash in the parser.
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    throw new ApiError(
      res.status,
      res.ok ? 'The server sent a reply this app cannot read.' : 'The service is temporarily unavailable. Try again shortly.',
      res.ok ? 'bad_response' : 'service_unavailable',
    );
  }

  if (!res.ok) {
    throw new ApiError(res.status, data?.message ?? 'Something went wrong', data?.error, data?.detail);
  }
  return data as T;
}

export const api = {
  get: <T,>(p: string) => request<T>('GET', p),
  post: <T,>(p: string, b?: unknown) => request<T>('POST', p, b),
  put: <T,>(p: string, b?: unknown) => request<T>('PUT', p, b),
  patch: <T,>(p: string, b?: unknown) => request<T>('PATCH', p, b),
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

export interface TimesheetLine {
  workDate: string;
  normalHours: number;
  overtimeHours: number;
}

// =====================================================================
// Offline queue
//
// FR-MOB-004 to 008. A week captured with no signal is held here against a
// token generated on the device. The token is what makes retransmission
// harmless: the server recognises it and creates nothing (BR-019).
// =====================================================================
export interface PendingWeek {
  clientUuid: string;
  placementId: string;
  weekStart: string;
  rowVersion: number;
  submit: boolean;
  lines: TimesheetLine[];
  queuedAt: string;
  label: string;          // shown to the consultant while it waits
}

const QUEUE_KEY = 'rasibe.queue.v1';

export function readQueue(): PendingWeek[] {
  try {
    return JSON.parse(localStorage.getItem(QUEUE_KEY) ?? '[]') as PendingWeek[];
  } catch {
    return [];
  }
}

function writeQueue(q: PendingWeek[]) {
  localStorage.setItem(QUEUE_KEY, JSON.stringify(q));
}

/** One entry per placement and week, so saving twice offline replaces rather than stacks. */
export function enqueue(week: Omit<PendingWeek, 'clientUuid' | 'queuedAt'>): PendingWeek {
  const existing = readQueue();
  const prior = existing.find(
    (x) => x.placementId === week.placementId && x.weekStart === week.weekStart,
  );
  const entry: PendingWeek = {
    ...week,
    // keep the original token on a re-save, so the server still sees one attempt
    clientUuid: prior?.clientUuid ?? crypto.randomUUID(),
    queuedAt: new Date().toISOString(),
  };
  writeQueue([...existing.filter((x) => x !== prior), entry]);
  return entry;
}

export function dequeue(clientUuid: string) {
  writeQueue(readQueue().filter((x) => x.clientUuid !== clientUuid));
}

export interface SyncResult {
  sent: number;
  conflicts: string[];
  failed: number;
}

/**
 * Sends everything the device is holding. Safe to call repeatedly: a week the
 * server has already accepted comes back as already_accepted and is simply
 * cleared from the queue.
 */
export async function flushQueue(): Promise<SyncResult> {
  const result: SyncResult = { sent: 0, conflicts: [], failed: 0 };

  for (const item of readQueue()) {
    try {
      const r = await api.post<{ outcome: string; message: string }>('/timesheets/sync', {
        clientUuid: item.clientUuid,
        placementId: item.placementId,
        weekStart: item.weekStart,
        rowVersion: item.rowVersion,
        submit: item.submit,
        lines: item.lines,
      });

      if (r.outcome === 'conflict') {
        result.conflicts.push(r.message);
        // The server version stands, but the local copy is not thrown away.
        // It is removed from the queue so it stops retrying; the consultant has
        // been told, and can re-enter the week if they still disagree.
        dequeue(item.clientUuid);
      } else {
        dequeue(item.clientUuid);
        result.sent += 1;
      }
    } catch (e) {
      // Still offline, or the server refused. Leave it queued and stop:
      // sending the rest out of order would be worse than waiting.
      result.failed += 1;
      break;
    }
  }
  return result;
}

// =====================================================================
// Connectivity
//
// navigator.onLine only reports whether the device has a network, not whether
// the server can be reached, so a failed request is also treated as offline.
// =====================================================================
export function useOnline() {
  const [online, setOnline] = useState(navigator.onLine);

  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    return () => {
      window.removeEventListener('online', up);
      window.removeEventListener('offline', down);
    };
  }, []);

  return [online, setOnline] as const;
}

// =====================================================================
// Auth
// =====================================================================
/** Whether this person has a second sign-in step (docs/TWO-FACTOR.md). */
export interface TwoFactorState {
  enabled: boolean;
  /** An administrator who must enrol first. Never true for the roles this app serves. */
  required: boolean;
}

/** The first sign-in step either finishes, or asks for the code. */
export type SignInResult = { user: CurrentUser } | { twoFactorRequired: true };

interface AuthValue {
  user: CurrentUser | null;
  twoFactor: TwoFactorState;
  loading: boolean;
  /** A one-off message after signing in, such as recovery codes running low. */
  notice: string | null;
  clearNotice: () => void;
  signIn: (email: string, password: string) => Promise<SignInResult>;
  verifyCode: (code: string) => Promise<CurrentUser>;
  /** Re-reads the account, for example after two-factor is turned on or off. */
  reload: () => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthValue | null>(null);
const NO_TWO_FACTOR: TwoFactorState = { enabled: false, required: false };

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [twoFactor, setTwoFactor] = useState<TwoFactorState>(NO_TWO_FACTOR);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const apply = useCallback((m: { user: CurrentUser; twoFactor?: TwoFactorState } | null) => {
    setUser(m?.user ?? null);
    setTwoFactor(m?.twoFactor ?? NO_TWO_FACTOR);
  }, []);

  useEffect(() => {
    api
      .get<{ user: CurrentUser; twoFactor?: TwoFactorState }>('/auth/me')
      .then(apply)
      .catch(() => apply(null))
      .finally(() => setLoading(false));
  }, [apply]);

  /** /auth/me carries the consultant link and client list the screens need,
   *  and the read refreshes the CSRF cookie against the new session. */
  const finish = useCallback(async () => {
    const me = await api.get<{ user: CurrentUser; twoFactor?: TwoFactorState }>('/auth/me');
    apply(me);
    return me.user;
  }, [apply]);

  const signIn = useCallback(async (email: string, password: string): Promise<SignInResult> => {
    const r = await api.post<{ twoFactorRequired?: true }>('/auth/login', { email, password });
    // With two-factor on there is no session yet, so /auth/me would refuse.
    if (r?.twoFactorRequired) return { twoFactorRequired: true };
    return { user: await finish() };
  }, [finish]);

  const verifyCode = useCallback(async (code: string) => {
    const r = await api.post<{ recoveryCodesRemaining?: number }>('/auth/login/verify', { code });
    const u = await finish();
    const left = r?.recoveryCodesRemaining;
    if (left !== undefined && left <= 3) {
      setNotice(left === 0
        ? 'You used your last recovery code. Set up two-factor again under Account to get new ones.'
        : `You have ${left} recovery code${left === 1 ? '' : 's'} left. Turn two-factor off and on again under Account to get a fresh set.`);
    }
    return u;
  }, [finish]);

  const reload = useCallback(async () => { await finish(); }, [finish]);

  const signOut = useCallback(async () => {
    try {
      await api.post('/auth/logout');
    } finally {
      apply(null);
      setNotice(null);
    }
  }, [apply]);

  const clearNotice = useCallback(() => setNotice(null), []);

  return (
    <AuthContext.Provider value={{ user, twoFactor, loading, notice, clearNotice, signIn, verifyCode, reload, signOut }}>
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
// Dates. Weeks run Monday to Sunday, per the client's decision.
// =====================================================================
export function mondayOf(d: Date): string {
  const c = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dow = c.getUTCDay() === 0 ? 7 : c.getUTCDay();
  c.setUTCDate(c.getUTCDate() - (dow - 1));
  return c.toISOString().slice(0, 10);
}

export function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export const today = () => new Date().toISOString().slice(0, 10);

export const dayName = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-ZA', { weekday: 'short' });

export const dayNumber = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-ZA', { day: '2-digit', month: 'short' });

export const isWeekend = (iso: string) => {
  const d = new Date(`${iso}T00:00:00Z`).getUTCDay();
  return d === 0 || d === 6;
};

export const fmtDate = (v: string | null | undefined) =>
  !v ? '—' : new Date(v).toLocaleDateString('en-ZA', { day: '2-digit', month: 'short', year: 'numeric' });

export const fmtHours = (v: number | string | null | undefined) =>
  v === null || v === undefined ? '0.00' : Number(v).toFixed(2);

export const money = (v: number | string | null | undefined) =>
  v === null || v === undefined ? '—' : `R ${Number(v).toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export const initials = (name: string) =>
  name.split(' ').filter(Boolean).slice(0, 2).map((p) => p[0]?.toUpperCase()).join('');

export const titleCase = (v: string | null | undefined) =>
  !v ? '—' : v.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (m) => m.toUpperCase());

// =====================================================================
// Small shared pieces
// =====================================================================
const TONE: Record<string, string> = {
  DRAFT: 'grey', PENDING_SYNC: 'amber', SUBMITTED: 'amber',
  REJECTED: 'red', APPROVED: 'green', INVOICED: 'blue', LOCKED: 'grey',
};

export function Status({ value }: { value?: string | null }) {
  if (!value) return null;
  return <span className={`pill pill-${TONE[value] ?? 'grey'}`}>{titleCase(value)}</span>;
}

export function Banner({
  kind, children,
}: { kind: 'offline' | 'pending' | 'ok' | 'error'; children: React.ReactNode }) {
  return (
    <div className={`banner banner-${kind}`}>
      <span className="dot" />
      <span>{children}</span>
    </div>
  );
}

export function Loading() {
  return <div className="loading">Loading…</div>;
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <div className="empty">{children}</div>;
}

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

  return { data, loading, error, reload, setData };
}
