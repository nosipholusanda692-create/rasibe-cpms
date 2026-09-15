import React, { useState } from 'react';
import {
  BrowserRouter, Routes, Route, NavLink, Navigate, useNavigate, useLocation,
} from 'react-router-dom';
import {
  AuthProvider, useAuth, useLoad, api, Alert, Field, Loading, initials,
} from './lib';

import Dashboard from './pages/Dashboard';
import Consultants from './pages/Consultants';
import ConsultantProfile from './pages/ConsultantProfile';
import Clients from './pages/Clients';
import Requests from './pages/Requests';
import RequestDetail from './pages/RequestDetail';
import Placements from './pages/Placements';
import Timesheets from './pages/Timesheets';
import MyTimesheets from './pages/MyTimesheets';
import Approvals from './pages/Approvals';
import Invoices from './pages/Invoices';
import InvoiceDetail from './pages/InvoiceDetail';
import Reports from './pages/Reports';
import Settings from './pages/Settings';

// =====================================================================
// Sign in
// =====================================================================
function SignIn() {
  const { signIn } = useAuth();
  const nav = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const landing = await signIn(email, password);
      nav(landing, { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not sign in');
    } finally {
      setBusy(false);
    }
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
        <h2>From open request<br />to paid invoice.</h2>
        <p>One place for your consultant pool, client requests, placements, weekly timesheets and invoicing.</p>
        <div className="login-points">
          <div className="login-point"><span>1</span><span>Search the pool by skill and availability in seconds</span></div>
          <div className="login-point"><span>2</span><span>Timesheets approved on a phone in two taps</span></div>
          <div className="login-point"><span>3</span><span>Invoices raised from approved hours only</span></div>
        </div>
      </div>

      <div className="login-right">
        <form className="login-form" onSubmit={submit}>
          <h1>Sign in</h1>
          <p className="muted small" style={{ marginTop: 0, marginBottom: 22 }}>
            Use the email address your account was created with.
          </p>

          {error && <Alert kind="error">{error}</Alert>}

          <Field label="Email address" required>
            <input type="email" value={email} autoComplete="username" required
              onChange={(e) => setEmail(e.target.value)} placeholder="you@rasibe.co.za" />
          </Field>
          <Field label="Password" required>
            <input type="password" value={password} autoComplete="current-password" required
              onChange={(e) => setPassword(e.target.value)} />
          </Field>

          <button className="btn btn-primary btn-block" disabled={busy} type="submit">
            {busy ? 'Signing in…' : 'Sign in'}
          </button>

          <div className="card" style={{ marginTop: 22, boxShadow: 'none' }}>
            <div className="card-body small">
              <strong>Consultants</strong> — submit your timesheets from the same sign in.
            </div>
          </div>

          <div style={{ marginTop: 20, borderTop: '1px solid var(--line)', paddingTop: 14 }}>
            <div className="tile-label" style={{ marginBottom: 8 }}>Demonstration accounts</div>
            <table className="small">
              <tbody>
                {[
                  ['Administrator', 'christinah@rasibe.co.za'],
                  ['Recruiter', 'nosipho@rasibe.co.za'],
                  ['Consultant', 'thabo.m@example.co.za'],
                  ['Client manager', 's.naidoo@nedgroupit.co.za'],
                ].map(([role, mail]) => (
                  <tr key={mail} className="clickable"
                    onClick={() => { setEmail(mail); setPassword('Password123!'); }}>
                    <td style={{ padding: '4px 0', border: 0 }}><strong>{role}</strong></td>
                    <td style={{ padding: '4px 0', border: 0 }} className="muted">{mail}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="field-hint">Password for all: Password123! — click a row to fill it in.</div>
          </div>
        </form>
      </div>
    </div>
  );
}

// =====================================================================
// Navigation, built from the signed-in role
// =====================================================================
interface NavEntry { to: string; label: string; count?: number }
interface NavGroup { label: string; items: NavEntry[] }

function useNav(): NavGroup[] {
  const { user } = useAuth();
  const { data } = useLoad<any>(() => api.get('/dashboard').catch(() => null), [user?.role]);
  const role = user?.role;

  if (role === 'CONSULTANT') {
    return [
      { label: 'My work', items: [
        { to: '/my/timesheets', label: 'My timesheets' },
        { to: '/my/placements', label: 'My placements' },
      ] },
      { label: 'Account', items: [{ to: '/my/profile', label: 'My profile' }] },
    ];
  }

  if (role === 'CLIENT_MANAGER') {
    return [
      { label: 'Delivery', items: [
        { to: '/approvals', label: 'Timesheet approvals', count: data?.timesheets?.awaiting_approval },
        { to: '/placements', label: 'Our placements' },
      ] },
      { label: 'Demand', items: [
        { to: '/requests', label: 'Role requests', count: data?.requests?.open },
      ] },
      { label: 'Finance', items: [{ to: '/invoices', label: 'Invoices' }] },
    ];
  }

  const groups: NavGroup[] = [
    { label: 'Overview', items: [{ to: '/dashboard', label: 'Dashboard' }] },
    { label: 'Talent', items: [
      { to: '/consultants', label: 'Consultants' },
      { to: '/skills', label: 'Skills' },
    ] },
    { label: 'Demand', items: [
      { to: '/clients', label: 'Clients' },
      { to: '/requests', label: 'Role requests', count: data?.requests?.open },
    ] },
    { label: 'Delivery', items: [
      { to: '/placements', label: 'Placements' },
      { to: '/timesheets', label: 'Timesheets', count: data?.timesheets?.awaiting_approval },
    ] },
    { label: 'Finance', items: [
      { to: '/invoices', label: 'Invoices', count: data?.invoices?.outstanding_count },
      { to: '/reports', label: 'Reports' },
    ] },
  ];
  if (role === 'ADMINISTRATOR') {
    groups.push({ label: 'System', items: [{ to: '/settings', label: 'Settings' }] });
  }
  return groups;
}

function Shell({ children }: { children: React.ReactNode }) {
  const { user, signOut } = useAuth();
  const groups = useNav();
  const nav = useNavigate();
  const loc = useLocation();

  const titles: Record<string, string> = {
    '/dashboard': 'Dashboard', '/consultants': 'Consultants', '/clients': 'Clients',
    '/requests': 'Role requests', '/placements': 'Placements', '/timesheets': 'Timesheets',
    '/invoices': 'Invoices', '/reports': 'Reports', '/settings': 'Settings',
    '/approvals': 'Timesheet approvals', '/my/timesheets': 'My timesheets',
    '/my/placements': 'My placements', '/my/profile': 'My profile', '/skills': 'Skills',
  };
  const title = titles[loc.pathname] ?? 'Rasibe';

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="sidebar-brand">
          <div className="brand-mark">R</div>
          <div>
            <div className="brand-name">Rasibe</div>
            <div className="brand-sub">Placement system</div>
          </div>
        </div>

        <nav className="nav">
          {groups.map((g) => (
            <div className="nav-group" key={g.label}>
              <div className="nav-group-label">{g.label}</div>
              {g.items.map((it) => (
                <NavLink key={it.to} to={it.to}
                  className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}>
                  <span>{it.label}</span>
                  {it.count ? <span className="nav-count">{it.count}</span> : null}
                </NavLink>
              ))}
            </div>
          ))}
        </nav>

        <div className="sidebar-user">
          <div className="avatar">{initials(user?.fullName ?? '')}</div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ color: '#fff', fontSize: 12.5 }}>{user?.fullName}</div>
            <small>{user?.role?.replace('_', ' ')}</small>
          </div>
          <button className="btn btn-sm" title="Sign out"
            onClick={async () => { await signOut(); nav('/signin'); }}>Out</button>
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <div>
            <h1>{title}</h1>
            <div className="sub">
              {new Date().toLocaleDateString('en-ZA', {
                weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
              })}
            </div>
          </div>
        </header>
        <main className="content">{children}</main>
      </div>
    </div>
  );
}

function Protected({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) return <Loading />;
  if (!user) return <Navigate to="/signin" replace />;
  return <Shell>{children}</Shell>;
}

function Landing() {
  const { user, landing, loading } = useAuth();
  if (loading) return <Loading />;
  if (!user) return <Navigate to="/signin" replace />;
  return <Navigate to={landing} replace />;
}

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/signin" element={<SignIn />} />
          <Route path="/" element={<Landing />} />
          <Route path="/dashboard" element={<Protected><Dashboard /></Protected>} />
          <Route path="/consultants" element={<Protected><Consultants /></Protected>} />
          <Route path="/consultants/:id" element={<Protected><ConsultantProfile /></Protected>} />
          <Route path="/skills" element={<Protected><Consultants skillsView /></Protected>} />
          <Route path="/clients" element={<Protected><Clients /></Protected>} />
          <Route path="/requests" element={<Protected><Requests /></Protected>} />
          <Route path="/requests/:id" element={<Protected><RequestDetail /></Protected>} />
          <Route path="/placements" element={<Protected><Placements /></Protected>} />
          <Route path="/my/placements" element={<Protected><Placements mine /></Protected>} />
          <Route path="/timesheets" element={<Protected><Timesheets /></Protected>} />
          <Route path="/approvals" element={<Protected><Approvals /></Protected>} />
          <Route path="/my/timesheets" element={<Protected><MyTimesheets /></Protected>} />
          <Route path="/my/profile" element={<Protected><ConsultantProfile self /></Protected>} />
          <Route path="/invoices" element={<Protected><Invoices /></Protected>} />
          <Route path="/invoices/:id" element={<Protected><InvoiceDetail /></Protected>} />
          <Route path="/reports" element={<Protected><Reports /></Protected>} />
          <Route path="/settings" element={<Protected><Settings /></Protected>} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
}
