import { useState } from 'react';
import { api, useAuth, useLoad, Card, Status, Loading, Alert, Empty, money, hours, date, titleCase } from '../lib';

/** Reporting (UC-27, UC-28). Margin is administrator only. */
export default function Reports() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'ADMINISTRATOR';
  const [tab, setTab] = useState(isAdmin ? 'margin' : 'outstanding');

  const margin = useLoad<any>(
    () => isAdmin ? api.get('/reports/margin') : Promise.resolve({ items: [] }), [isAdmin]);
  const outstanding = useLoad<any>(() => api.get('/reports/outstanding-timesheets'));
  const ending = useLoad<any>(() => api.get('/reports/placements-ending?days=90'));
  const ageing = useLoad<any>(() => api.get('/reports/invoice-ageing'));
  const util = useLoad<any>(() => api.get('/reports/utilisation'));
  const audit = useLoad<any>(
    () => isAdmin ? api.get('/reports/audit?limit=60') : Promise.resolve({ items: [] }), [isAdmin]);

  const tabs = [
    ...(isAdmin ? [{ key: 'margin', label: 'Revenue, cost and margin' }] : []),
    { key: 'outstanding', label: 'Outstanding timesheets' },
    { key: 'ending', label: 'Placements ending' },
    { key: 'ageing', label: 'Invoice ageing' },
    { key: 'utilisation', label: 'Pool utilisation' },
    ...(isAdmin ? [{ key: 'audit', label: 'Audit log' }] : []),
  ];

  return (
    <Card>
      <div className="tabs">
        {tabs.map((t) => (
          <button key={t.key} className={`tab${tab === t.key ? ' active' : ''}`}
            onClick={() => setTab(t.key)}>
            {t.label}{t.key === 'margin' && <span className="restricted">ADMIN</span>}
          </button>
        ))}
      </div>

      {tab === 'margin' && (
        margin.loading ? <Loading /> : !margin.data?.items.length ? <Empty message="No approved hours yet." /> : (
          <table>
            <thead><tr><th>Placement</th><th>Consultant</th><th>Client</th>
              <th className="num">Hours</th><th className="num">Revenue</th>
              <th className="num">Cost</th><th className="num">Margin</th></tr></thead>
            <tbody>
              {margin.data.items.map((m: any) => (
                <tr key={m.placement_id}>
                  <td className="mono">{m.reference}</td>
                  <td>{m.consultant_name}</td>
                  <td>{m.client_name}</td>
                  <td className="num">{hours(m.hours_approved)}</td>
                  <td className="num">{money(m.revenue)}</td>
                  <td className="num">{money(m.cost)}</td>
                  <td className="num"><strong>{money(m.margin)}</strong></td>
                </tr>
              ))}
            </tbody>
          </table>
        )
      )}

      {tab === 'outstanding' && (
        outstanding.loading ? <Loading /> : !outstanding.data?.items.length
          ? <Empty message="Nothing outstanding." /> : (
          <table>
            <thead><tr><th>Consultant</th><th>Client</th><th>Week</th>
              <th>Status</th><th className="num">Days since</th></tr></thead>
            <tbody>
              {outstanding.data.items.map((t: any) => (
                <tr key={t.timesheet_id}>
                  <td>{t.consultant_name}</td><td>{t.client_name}</td>
                  <td className="mono">{date(t.week_start)}</td>
                  <td><Status value={t.status} /></td>
                  <td className="num">{t.days_since_week_end}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )
      )}

      {tab === 'ending' && (
        ending.loading ? <Loading /> : !ending.data?.items.length
          ? <Empty message="Nothing ending in the next 90 days." /> : (
          <table>
            <thead><tr><th>Reference</th><th>Consultant</th><th>Client</th>
              <th>Ends</th><th className="num">Days left</th><th>Status</th></tr></thead>
            <tbody>
              {ending.data.items.map((p: any) => (
                <tr key={p.placement_id}>
                  <td className="mono">{p.reference}</td>
                  <td>{p.consultant_name}</td><td>{p.client_name}</td>
                  <td className="mono">{date(p.end_date)}</td>
                  <td className="num">
                    <span className={`pill pill-${p.days_remaining <= 14 ? 'red' : p.days_remaining <= 30 ? 'amber' : 'grey'}`}>
                      {p.days_remaining}
                    </span>
                  </td>
                  <td><Status value={p.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )
      )}

      {tab === 'ageing' && (
        ageing.loading ? <Loading /> : !ageing.data?.items.length
          ? <Empty message="Nothing outstanding." /> : (
          <table>
            <thead><tr><th>Client</th><th className="num">Within terms</th>
              <th className="num">1–30 days late</th><th className="num">Over 30 days</th></tr></thead>
            <tbody>
              {ageing.data.items.map((a: any) => (
                <tr key={a.client_name}>
                  <td>{a.client_name}</td>
                  <td className="num">{money(a.current_due)}</td>
                  <td className="num">{money(a.overdue_30)}</td>
                  <td className="num">
                    {Number(a.overdue_60_plus) > 0
                      ? <strong style={{ color: 'var(--red)' }}>{money(a.overdue_60_plus)}</strong>
                      : money(a.overdue_60_plus)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )
      )}

      {tab === 'utilisation' && (
        util.loading ? <Loading /> : (
          <div className="card-body">
            <div className="grid grid-4">
              <div className="tile"><div className="tile-label">Pool size</div>
                <div className="tile-value">{util.data?.pool_size ?? 0}</div></div>
              <div className="tile"><div className="tile-label">On placement</div>
                <div className="tile-value">{util.data?.on_placement ?? 0}</div></div>
              <div className="tile"><div className="tile-label">Available</div>
                <div className="tile-value">{util.data?.available ?? 0}</div></div>
              <div className="tile accent-brand"><div className="tile-label">Utilisation</div>
                <div className="tile-value">{util.data?.utilisation_pct ?? 0}%</div></div>
            </div>
          </div>
        )
      )}

      {tab === 'audit' && (
        audit.loading ? <Loading /> : !audit.data?.items.length ? <Empty message="No entries yet." /> : (
          <table>
            <thead><tr><th>When</th><th>Who</th><th>Action</th><th>Entity</th><th>Reason</th></tr></thead>
            <tbody>
              {audit.data.items.map((a: any) => (
                <tr key={a.audit_id}>
                  <td className="mono small">{new Date(a.occurred_at).toLocaleString('en-ZA')}</td>
                  <td>{a.actor_name ?? '—'}</td>
                  <td>
                    <span className={`pill pill-${a.action.includes('OVERRIDDEN') ? 'amber'
                      : a.action.includes('REJECT') ? 'red' : 'grey'}`}>
                      {titleCase(a.action)}
                    </span>
                  </td>
                  <td className="muted small">{a.entity_table}</td>
                  <td className="small">{a.reason ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )
      )}
    </Card>
  );
}
