import { api, useAuth, useLoad, Card, Tile, Status, Loading, Alert, money, hours, date, Person, Empty } from '../lib';
import { Link } from 'react-router-dom';

/** Administrator and recruiter landing page (UC-26). */
export default function Dashboard() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'ADMINISTRATOR';

  const dash = useLoad<any>(() => api.get('/dashboard'));
  const outstanding = useLoad<any>(() => api.get('/reports/outstanding-timesheets'));
  const ending = useLoad<any>(() => api.get('/reports/placements-ending?days=90'));
  const requests = useLoad<any>(() => api.get('/requests?status=OPEN,SHORTLISTING,INTERVIEWING'));

  if (dash.loading) return <Loading />;
  if (dash.error) return <Alert kind="error">{dash.error}</Alert>;
  const d = dash.data;

  return (
    <>
      <div className="grid grid-4" style={{ marginBottom: 16 }}>
        <Tile tone="amber" label="Timesheets awaiting approval"
          value={d.timesheets.awaiting_approval}
          note={d.timesheets.overdue > 0 ? `${d.timesheets.overdue} overdue` : 'None overdue'} />
        <Tile label="Invoices outstanding"
          value={money(d.invoices.outstanding_value)}
          note={`${d.invoices.outstanding_count} invoices · ${d.invoices.overdue_count} past terms`} />
        <Tile tone="amber" label="Placements ending in 90 days"
          value={d.placements.ending_90}
          note={`${d.placements.active} active in total`} />
        {isAdmin ? (
          <Tile tone="brand" label="Margin to date" value={money(d.margin?.margin)} restricted
            note={`Revenue ${money(d.margin?.revenue)}`} />
        ) : (
          <Tile label="Open role requests" value={d.requests.open} note="Awaiting candidates" />
        )}
      </div>

      <div className="grid grid-main">
        <div>
          <Card title="Timesheets outstanding" subtitle="Weeks that have ended and are not yet approved"
            action={<Link className="btn btn-sm" to="/timesheets">View all</Link>}>
            {outstanding.loading ? <Loading /> : !outstanding.data?.items.length ? (
              <Empty message="Every week that has ended is approved. Nothing to chase." />
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>Consultant</th><th>Client</th><th>Week</th>
                    <th>Status</th><th className="num">Days since</th>
                  </tr>
                </thead>
                <tbody>
                  {outstanding.data.items.slice(0, 8).map((t: any) => (
                    <tr key={t.timesheet_id}>
                      <td><Person name={t.consultant_name} /></td>
                      <td>{t.client_name}</td>
                      <td className="mono">{date(t.week_start)}</td>
                      <td><Status value={t.status} /></td>
                      <td className="num">
                        {t.days_since_week_end > 7
                          ? <span className="pill pill-red">{t.days_since_week_end} days</span>
                          : <span className="muted">{t.days_since_week_end}</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>

          <Card title="Open role requests"
            action={<Link className="btn btn-sm" to="/requests">View all</Link>}>
            {requests.loading ? <Loading /> : !requests.data?.items.length ? (
              <Empty message="No open requests." />
            ) : (
              <table>
                <thead>
                  <tr><th>Role</th><th>Client</th><th>Start</th>
                    <th className="num">Shortlisted</th><th className="num">Age</th></tr>
                </thead>
                <tbody>
                  {requests.data.items.slice(0, 6).map((r: any) => (
                    <tr key={r.request_id}>
                      <td>
                        <Link to={`/requests/${r.request_id}`}>{r.title}</Link>
                        <div className="person-role">
                          {r.duration_months ? `${r.duration_months} months · ` : ''}
                          {r.work_mode?.toLowerCase().replace('_', ' ')}
                        </div>
                      </td>
                      <td>{r.client_name}</td>
                      <td className="mono">{date(r.start_date)}</td>
                      <td className="num">{r.shortlisted_count} of {r.submitted_count}</td>
                      <td className="num">
                        <span className={`pill pill-${r.age_days > 5 ? 'red' : 'amber'}`}>
                          {r.age_days} d
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
        </div>

        <div>
          <Card title="Placements ending" subtitle="Next 90 days">
            {ending.loading ? <Loading /> : !ending.data?.items.length ? (
              <Empty message="Nothing ending soon." />
            ) : (
              <table>
                <tbody>
                  {ending.data.items.slice(0, 6).map((p: any) => (
                    <tr key={p.placement_id}>
                      <td>
                        <div className="person-name">{p.consultant_name}</div>
                        <div className="person-role">{p.client_name} · ends {date(p.end_date)}</div>
                      </td>
                      <td className="num">
                        <span className={`pill pill-${p.days_remaining <= 14 ? 'red'
                          : p.days_remaining <= 30 ? 'amber' : 'grey'}`}>
                          {p.days_remaining} d
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>

          {isAdmin && (
            <Card title="Pool utilisation">
              <div className="card-body">
                <div className="row">
                  <div style={{ flex: 1 }}>
                    <div className="tile-label">On placement</div>
                    <div className="tile-value">{d.utilisation?.on_placement ?? 0}</div>
                  </div>
                  <div style={{ flex: 1 }}>
                    <div className="tile-label">Available</div>
                    <div className="tile-value">{d.utilisation?.available ?? 0}</div>
                  </div>
                  <div style={{ flex: 1 }}>
                    <div className="tile-label">Utilisation</div>
                    <div className="tile-value">{d.utilisation?.utilisation_pct ?? 0}%</div>
                  </div>
                </div>
              </div>
            </Card>
          )}

          <Card title="Needs attention">
            <table>
              <tbody>
                <tr><td>Rates awaiting approval</td>
                  <td className="num"><strong>{d.placements.pending_rates}</strong></td></tr>
                <tr><td>Timesheets rejected</td>
                  <td className="num"><strong>{d.timesheets.rejected}</strong></td></tr>
                <tr><td>Weeks not submitted</td>
                  <td className="num"><strong>{d.timesheets.not_submitted}</strong></td></tr>
                <tr><td>Documents expiring in 30 days</td>
                  <td className="num"><strong>{d.documents.expiring_30}</strong></td></tr>
              </tbody>
            </table>
          </Card>
        </div>
      </div>
    </>
  );
}
