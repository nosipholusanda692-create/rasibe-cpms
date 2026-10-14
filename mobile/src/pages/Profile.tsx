import { useAuth, useLoad, api, readQueue, fmtDate, titleCase, Banner, Empty } from '../lib';

/** Account, placements and anything still held on the device. */
export default function Profile() {
  const { user, signOut } = useAuth();
  const placements = useLoad<any>(() => api.get('/placements'));
  const queued = readQueue();

  return (
    <div className="screen has-tabs">
      <header className="appbar">
        <div className="brand-mark">R</div>
        <h1>Account</h1>
      </header>

      <section className="card">
        <div className="card-body">
          <div className="sheet-title">{user?.fullName}</div>
          <div className="sheet-sub">{user?.email}</div>
          <div className="sheet-sub">{titleCase(user?.role)}</div>
        </div>
      </section>

      {queued.length > 0 && (
        <section className="card">
          <div className="card-head"><h2>Waiting to send</h2></div>
          {queued.map((q) => (
            <div className="list-row" key={q.clientUuid}>
              <div className="stack" style={{ flex: 1 }}>
                <span className="sheet-title">{q.label}</span>
                <span className="sheet-sub">
                  {q.lines.length} day{q.lines.length === 1 ? '' : 's'} · saved {fmtDate(q.queuedAt)}
                </span>
              </div>
              <span className="pill pill-amber">Pending</span>
            </div>
          ))}
          <div className="card-body small muted">
            These are held on this phone and sent automatically when you are online.
          </div>
        </section>
      )}

      {user?.role === 'CONSULTANT' && (
        <section className="card">
          <div className="card-head"><h2>My placements</h2></div>
          {placements.loading ? <div className="loading">Loading…</div>
            : !placements.data?.items?.length ? <Empty>No placements.</Empty>
            : placements.data.items.map((p: any) => (
              <div className="list-row" key={p.placement_id}>
                <div className="stack" style={{ flex: 1 }}>
                  <span className="sheet-title">{p.client_name}</span>
                  <span className="sheet-sub">{p.job_title}</span>
                  <span className="sheet-sub">
                    {fmtDate(p.start_date)} – {fmtDate(p.end_date)}
                  </span>
                </div>
                <span className={`pill pill-${p.status === 'ACTIVE' ? 'green' : 'amber'}`}>
                  {titleCase(p.status)}
                </span>
              </div>
            ))}
          <div className="card-body">
            <Banner kind="pending">
              Your placement shows the rate you are paid. The rate charged to the client is held
              on the agency side and is not part of your record.
            </Banner>
          </div>
        </section>
      )}

      <section className="card">
        <div className="card-body">
          <button className="btn btn-block" onClick={signOut}>Sign out</button>
        </div>
      </section>
    </div>
  );
}
