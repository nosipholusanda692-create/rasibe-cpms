import { BrowserRouter, Routes, Route, NavLink, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth, Loading, readQueue } from './lib';
import SignIn from './pages/SignIn';
import MyWeek from './pages/MyWeek';
import Approvals from './pages/Approvals';
import Notifications from './pages/Notifications';
import Profile from './pages/Profile';

/**
 * The mobile client serves two roles only: the consultant who records hours and
 * the client manager who approves them. Everything a recruiter or administrator
 * does stays on the web client, which is why there is no navigation for it here.
 */
function TabBar() {
  const { user } = useAuth();
  const isConsultant = user?.role === 'CONSULTANT';
  const pending = readQueue().length;

  return (
    <nav className="tabbar">
      {isConsultant ? (
        <NavLink to="/week" className={({ isActive }) => (isActive ? 'active' : '')}>
          <span className="glyph">▦</span>My week
        </NavLink>
      ) : (
        <NavLink to="/approvals" className={({ isActive }) => (isActive ? 'active' : '')}>
          <span className="glyph">✓</span>Approvals
        </NavLink>
      )}
      <NavLink to="/notifications" className={({ isActive }) => (isActive ? 'active' : '')}>
        <span className="glyph">◉</span>Alerts
      </NavLink>
      <NavLink to="/account" className={({ isActive }) => (isActive ? 'active' : '')}>
        <span className="glyph">☰</span>
        Account{pending > 0 ? ` (${pending})` : ''}
      </NavLink>
    </nav>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) return <Loading />;
  if (!user) return <SignIn />;

  // An administrator or recruiter signing in here is told where to go rather
  // than shown a client that was never meant for them.
  if (user.role === 'ADMINISTRATOR' || user.role === 'RECRUITER') {
    return (
      <div className="screen">
        <header className="appbar">
          <div className="brand-mark">R</div>
          <h1>Rasibe</h1>
        </header>
        <section className="card">
          <div className="card-body">
            <div className="sheet-title">This app is for consultants and approvers.</div>
            <p className="small muted">
              Consultant search, placements, invoicing and reporting are on the web
              application. Sign in there instead.
            </p>
          </div>
        </section>
      </div>
    );
  }

  return (<>{children}<TabBar /></>);
}

function Home() {
  const { user } = useAuth();
  return <Navigate to={user?.role === 'CONSULTANT' ? '/week' : '/approvals'} replace />;
}

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<Shell><Home /></Shell>} />
          <Route path="/week" element={<Shell><MyWeek /></Shell>} />
          <Route path="/approvals" element={<Shell><Approvals /></Shell>} />
          <Route path="/notifications" element={<Shell><Notifications /></Shell>} />
          <Route path="/account" element={<Shell><Profile /></Shell>} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
}
