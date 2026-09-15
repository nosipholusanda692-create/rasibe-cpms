import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';

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

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    credentials: 'include', // the session cookie is httpOnly, so it travels here
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await res.text();
  const data = text ? JSON.parse(text) : null;

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

interface Me {
  user: CurrentUser;
  capabilities: string[];
  landing: string;
}

// =====================================================================
// Auth context
// =====================================================================
interface AuthValue {
  user: CurrentUser | null;
  capabilities: string[];
  landing: string;
  loading: boolean;
  can: (capability: string) => boolean;
  signIn: (email: string, password: string) => Promise<string>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [capabilities, setCapabilities] = useState<string[]>([]);
  const [landing, setLanding] = useState('/dashboard');
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const me = await api.get<Me>('/auth/me');
      setUser(me.user);
      setCapabilities(me.capabilities);
      setLanding(me.landing);
    } catch {
      setUser(null);
      setCapabilities([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const signIn = useCallback(async (email: string, password: string) => {
    const r = await api.post<{ landing: string }>('/auth/login', { email, password });
    const me = await api.get<Me>('/auth/me');
    setUser(me.user);
    setCapabilities(me.capabilities);
    setLanding(me.landing);
    return r.landing;
  }, []);

  const signOut = useCallback(async () => {
    await api.post('/auth/logout');
    setUser(null);
    setCapabilities([]);
  }, []);

  const can = useCallback((c: string) => capabilities.includes(c), [capabilities]);

  return (
    <AuthContext.Provider value={{ user, capabilities, landing, loading, can, signIn, signOut }}>
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
