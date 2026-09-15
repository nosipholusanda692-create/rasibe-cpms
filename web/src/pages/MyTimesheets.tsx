import { useEffect, useState } from 'react';
import {
  api, useAuth, useLoad, Card, Status, Loading, Alert, Empty, Person, Field, Modal,
  money, hours, date, dateShort, titleCase,
} from '../lib';

// =====================================================================
// Offline queue
//
// Realises FR-MOB-004 to 008. A week captured without connectivity is held in
// localStorage against a client token generated on the device. The token is
// what makes retransmission harmless: the server recognises it and creates no
// duplicate (BR-019).
// =====================================================================
interface PendingWeek {
  clientUuid: string;
  placementId: string;
  weekStart: string;
  rowVersion: number;
  submit: boolean;
  lines: { workDate: string; normalHours: number; overtimeHours: number }[];
  queuedAt: string;
}

const QUEUE_KEY = 'rasibe.pendingWeeks';

function readQueue(): PendingWeek[] {
  try { return JSON.parse(localStorage.getItem(QUEUE_KEY) ?? '[]'); } catch { return []; }
}
function writeQueue(q: PendingWeek[]) {
  localStorage.setItem(QUEUE_KEY, JSON.stringify(q));
}
function enqueue(p: PendingWeek) {
  writeQueue([...readQueue().filter((x) => x.clientUuid !== p.clientUuid), p]);
}
function dequeue(clientUuid: string) {
  writeQueue(readQueue().filter((x) => x.clientUuid !== clientUuid));
}

/** Attempts to send everything held on the device. Safe to call repeatedly. */
async function flushQueue(): Promise<{ sent: number; conflicts: string[] }> {
  let sent = 0;
  const conflicts: string[] = [];
  for (const item of readQueue()) {
    try {
      const r = await api.post<any>('/timesheets/sync', item);
      if (r.outcome === 'conflict') conflicts.push(r.message);
      dequeue(item.clientUuid);
      sent++;
    } catch {
      // still offline, or the server refused; leave it queued and try later
      break;
    }
  }
  return { sent, conflicts };
}

// =====================================================================
// Consultant timesheet capture (UC-16, UC-17, UC-32)
// =====================================================================
export default function MyTimesheets() {
  const [weekStart, setWeekStart] = useState(() => mondayOf(new Date()));
  const [online, setOnline] = useState(navigator.onLine);
  const [pending, setPending] = useState<PendingWeek[]>(readQueue());
  const [msg, setMsg] = useState<{ kind: 'success' | 'error' | 'warn'; text: string } | null>(null);

  const data = useLoad<any>(
    () => api.get(`/timesheets/my/current?weekStart=${weekStart}`), [weekStart]);

  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off); };
  }, []);

  // when connectivity returns, send whatever the device is holding
  useEffect(() => {
    if (!online || !pending.length) return;
    void (async () => {
      const { sent, conflicts } = await flushQueue();
      setPending(readQueue());
      if (conflicts.length) {
        setMsg({ kind: 'warn', text: conflicts[0] });
      } else if (sent) {
        setMsg({ kind: 'success', text: `${sent} week(s) sent to the office.` });
      }
      data.reload();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [online, pending.length]);

  return (
    <>
      {!online && (
        <div className="sync-banner sync-pending">
          You are offline. Hours are saved on this device and sent automatically when you reconnect.
        </div>
      )}
      {online && pending.length > 0 && (
        <div className="sync-banner sync-pending">
          {pending.length} week(s) waiting to be sent.
        </div>
      )}
      {msg && <Alert kind={msg.kind === 'warn' ? 'warn' : msg.kind}>{msg.text}</Alert>}

      <Card title="My timesheets" subtitle="Weeks run Monday to Sunday"
        action={
          <div className="btn-row">
            <button className="btn btn-sm" onClick={() => setWeekStart(shiftWeek(weekStart, -7))}>
              Previous week
            </button>
            <button className="btn btn-sm" onClick={() => setWeekStart(mondayOf(new Date()))}>
              This week
            </button>
            <button className="btn btn-sm" disabled={weekStart >= mondayOf(new Date())}
              onClick={() => setWeekStart(shiftWeek(weekStart, 7))}>
              Next week
            </button>
          </div>
        }>
        <div className="card-body">
          <strong>Week of {date(weekStart)}</strong>
          <span className="muted small"> — {date(shiftWeek(weekStart, 6))}</span>
        </div>
      </Card>

      {data.loading ? <Loading />
        : data.error ? <Alert kind="error">{data.error}</Alert>
        : !data.data?.items.length ? (
          <Card><Empty message="You have no active placement for this week." /></Card>
        ) : data.data.items.map((sheet: any) => (
          <WeekSheet key={sheet.timesheet_id} sheet={sheet} weekStart={weekStart}
            online={online}
            onQueued={() => { setPending(readQueue()); setMsg({
              kind: 'success',
              text: 'Saved on this device. It will be sent when you are back online.',
            }); }}
            onSaved={(text) => { setMsg({ kind: 'success', text }); data.reload(); }}
            onError={(text) => setMsg({ kind: 'error', text })} />
        ))}
    </>
  );
}

function WeekSheet({
  sheet, weekStart, online, onSaved, onQueued, onError,
}: {
  sheet: any; weekStart: string; online: boolean;
  onSaved: (m: string) => void; onQueued: () => void; onError: (m: string) => void;
}) {
  const days = Array.from({ length: 7 }, (_, i) => shiftWeek(weekStart, i));
  const today = new Date().toISOString().slice(0, 10);

  const [rows, setRows] = useState<Record<string, { normal: string; overtime: string }>>(() => {
    const init: Record<string, { normal: string; overtime: string }> = {};
    for (const d of days) {
      const line = (sheet.lines ?? []).find((l: any) => l.work_date?.slice(0, 10) === d);
      init[d] = { normal: line ? String(line.normal_hours) : '', overtime: line ? String(line.overtime_hours) : '' };
    }
    return init;
  });
  const [busy, setBusy] = useState(false);

  const editable = ['DRAFT', 'PENDING_SYNC', 'REJECTED'].includes(sheet.status);
  const totalNormal = days.reduce((s, d) => s + Number(rows[d]?.normal || 0), 0);
  const totalOt = days.reduce((s, d) => s + Number(rows[d]?.overtime || 0), 0);

  function linePayload() {
    return days
      .filter((d) => Number(rows[d]?.normal || 0) > 0 || Number(rows[d]?.overtime || 0) > 0)
      .map((d) => ({
        workDate: d,
        normalHours: Number(rows[d].normal || 0),
        overtimeHours: Number(rows[d].overtime || 0),
      }));
  }

  async function save(submit: boolean) {
    const lines = linePayload();
    if (submit && !lines.length) {
      onError('Record some hours before submitting the week.');
      return;
    }

    // offline: hold it on the device against a token generated here
    if (!online) {
      enqueue({
        clientUuid: crypto.randomUUID(),
        placementId: sheet.placement_id,
        weekStart,
        rowVersion: Number(sheet.row_version ?? 0),
        submit,
        lines,
        queuedAt: new Date().toISOString(),
      });
      onQueued();
      return;
    }

    setBusy(true);
    try {
      await api.put(`/timesheets/${sheet.timesheet_id}/lines`, { lines });
      if (submit) {
        await api.post(`/timesheets/${sheet.timesheet_id}/submit`);
        onSaved('Week submitted. Your approver has been notified.');
      } else {
        onSaved('Week saved.');
      }
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Could not save the week');
    } finally { setBusy(false); }
  }

  return (
    <Card
      title={sheet.placement?.client_name ?? sheet.client_name}
      subtitle={`${sheet.placement?.job_title ?? ''} · ${sheet.placement?.reference ?? ''}`}
      action={<Status value={sheet.status} />}
      footer={editable ? (
        <>
          <div className="week-total">{hours(totalNormal + totalOt)} hours</div>
          <div className="spacer" />
          <button className="btn" disabled={busy} onClick={() => save(false)}>Save draft</button>
          <button className="btn btn-primary" disabled={busy} onClick={() => save(true)}>
            {online ? 'Submit for approval' : 'Save on device'}
          </button>
        </>
      ) : (
        <>
          <div className="week-total">{hours(Number(sheet.total_standard_hours) + Number(sheet.total_overtime_hours))} hours</div>
          <div className="spacer" />
          <span className="muted small">
            {sheet.status === 'SUBMITTED' ? 'Waiting for your approver'
              : sheet.status === 'APPROVED' ? `Approved ${date(sheet.approved_at)}`
              : sheet.status === 'INVOICED' ? 'Included on an invoice'
              : titleCase(sheet.status)}
          </span>
        </>
      )}>

      {sheet.status === 'REJECTED' && (
        <div style={{ padding: '12px 16px' }}>
          <Alert kind="error">
            <strong>Returned for correction.</strong> {sheet.rejected_reason}
          </Alert>
        </div>
      )}

      <div className="week-grid">
        <div className="head">Day</div>
        <div className="head">Normal hours</div>
        <div className="head">Overtime</div>
        <div className="head">Total</div>
        {days.map((d) => {
          const dow = new Date(d + 'T00:00:00Z').getUTCDay();
          const weekend = dow === 0 || dow === 6;
          const future = d > today;
          const total = Number(rows[d]?.normal || 0) + Number(rows[d]?.overtime || 0);
          return (
            <>
              <div key={`${d}-l`} className={weekend ? 'day-weekend' : ''}>
                <strong>{new Date(d + 'T00:00:00Z').toLocaleDateString('en-ZA', { weekday: 'short' })}</strong>
                <div className="person-role">{dateShort(d)}</div>
              </div>
              <div key={`${d}-n`} className={weekend ? 'day-weekend' : ''}>
                <input type="number" min={0} max={24} step={0.5}
                  disabled={!editable || future}
                  value={rows[d]?.normal ?? ''}
                  placeholder={future ? 'future' : '0'}
                  onChange={(e) => setRows((r) => ({ ...r, [d]: { ...r[d], normal: e.target.value } }))} />
              </div>
              <div key={`${d}-o`} className={weekend ? 'day-weekend' : ''}>
                <input type="number" min={0} max={24} step={0.5}
                  disabled={!editable || future}
                  value={rows[d]?.overtime ?? ''}
                  placeholder={future ? 'future' : '0'}
                  onChange={(e) => setRows((r) => ({ ...r, [d]: { ...r[d], overtime: e.target.value } }))} />
              </div>
              <div key={`${d}-t`} className={`mono ${weekend ? 'day-weekend' : ''}`}>
                {total > 0 ? hours(total) : <span className="muted">—</span>}
              </div>
            </>
          );
        })}
      </div>
    </Card>
  );
}

function mondayOf(d: Date): string {
  const c = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dow = c.getUTCDay() === 0 ? 7 : c.getUTCDay();
  c.setUTCDate(c.getUTCDate() - (dow - 1));
  return c.toISOString().slice(0, 10);
}
function shiftWeek(iso: string, days: number): string {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// =====================================================================
// Internal timesheet view (prototype screen H12)
// =====================================================================
export function TimesheetsPage() {
  const { user } = useAuth();
  const [status, setStatus] = useState('');
  const [outstanding, setOutstanding] = useState(true);
  const [msg, setMsg] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  const [override, setOverride] = useState<any | null>(null);

  const qs = new URLSearchParams();
  if (status) qs.set('status', status);
  if (outstanding && !status) qs.set('outstanding', 'true');

  const list = useLoad<any>(() => api.get(`/timesheets?${qs}`), [status, outstanding]);
  const isAdmin = user?.role === 'ADMINISTRATOR';

  return (
    <>
      {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}
      <Card title="Timesheets"
        subtitle={list.data ? `${list.data.items.length} weeks` : undefined}>
        <div className="filters">
          <Field label="Status">
            <select value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">Outstanding only</option>
              <option value="SUBMITTED">Awaiting approval</option>
              <option value="APPROVED">Approved</option>
              <option value="REJECTED">Rejected</option>
              <option value="INVOICED">Invoiced</option>
            </select>
          </Field>
        </div>

        {list.loading ? <Loading />
          : list.error ? <Alert kind="error">{list.error}</Alert>
          : !list.data?.items.length ? <Empty message="Nothing outstanding. Every week that has ended is approved." />
          : (
            <table>
              <thead>
                <tr>
                  <th>Consultant</th><th>Client</th><th>Approver</th><th>Week</th>
                  <th className="num">Hours</th><th>Status</th>
                  {isAdmin && <th className="right">Action</th>}
                </tr>
              </thead>
              <tbody>
                {list.data.items.map((t: any) => (
                  <tr key={t.timesheet_id}>
                    <td><Person name={t.consultant_name} sub={t.job_title} /></td>
                    <td>{t.client_name}</td>
                    <td className="muted">{t.approver_name ?? '—'}</td>
                    <td className="mono">{date(t.week_start)}</td>
                    <td className="num">
                      {hours(Number(t.total_standard_hours) + Number(t.total_overtime_hours))}
                    </td>
                    <td>
                      <Status value={t.status} />
                      {t.status === 'SUBMITTED' && t.days_since_week_end > 7 && (
                        <div><span className="pill pill-red">Overdue {t.days_since_week_end} d</span></div>
                      )}
                      {t.is_override && <div><span className="pill pill-amber">Override</span></div>}
                    </td>
                    {isAdmin && (
                      <td className="right">
                        {t.status === 'APPROVED' && (
                          <button className="btn btn-sm" onClick={() => setOverride(t)}>
                            Return for correction
                          </button>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
      </Card>

      {override && (
        <OverrideModal timesheet={override} onClose={() => setOverride(null)}
          onSaved={() => {
            setOverride(null); list.reload();
            setMsg({ kind: 'success', text: 'Week returned for correction. The action is recorded as an override.' });
          }} />
      )}
    </>
  );
}

function OverrideModal({ timesheet, onClose, onSaved }: { timesheet: any; onClose: () => void; onSaved: () => void }) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true); setError(null);
    try {
      await api.post(`/timesheets/${timesheet.timesheet_id}/override`, { reason });
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not override');
    } finally { setBusy(false); }
  }

  return (
    <Modal title="Return an approved week" onClose={onClose}
      footer={<>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={busy || reason.trim().length < 5} onClick={save}>
          {busy ? 'Saving…' : 'Return for correction'}
        </button>
      </>}>
      {error && <Alert kind="error">{error}</Alert>}
      <p className="small">
        {timesheet.consultant_name} · week of {date(timesheet.week_start)}
      </p>
      <Field label="Reason" required hint="At least five characters. Recorded as an override in the audit log.">
        <textarea value={reason} onChange={(e) => setReason(e.target.value)} />
      </Field>
    </Modal>
  );
}

// =====================================================================
// Client manager approvals (UC-18) — two interactions to approve
// =====================================================================
export function ApprovalsPage() {
  const [msg, setMsg] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  const [rejecting, setRejecting] = useState<any | null>(null);
  const [openSheet, setOpenSheet] = useState<any | null>(null);
  const list = useLoad<any>(() => api.get('/timesheets?status=SUBMITTED'));

  async function approve(t: any) {
    try {
      await api.post(`/timesheets/${t.timesheet_id}/decision`, { decision: 'APPROVE' });
      setMsg({ kind: 'success', text: `Approved ${t.consultant_name}, week of ${date(t.week_start)}.` });
      list.reload();
    } catch (e) {
      setMsg({ kind: 'error', text: e instanceof Error ? e.message : 'Could not approve' });
    }
  }

  return (
    <>
      {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}
      <Card title="Timesheets awaiting your approval"
        subtitle={list.data ? `${list.data.items.length} waiting` : undefined}>
        {list.loading ? <Loading />
          : !list.data?.items.length ? <Empty message="Nothing is waiting for you. " />
          : (
            <table>
              <thead>
                <tr><th>Consultant</th><th>Week</th><th className="num">Hours</th>
                  <th className="num">Value</th><th className="right">Decision</th></tr>
              </thead>
              <tbody>
                {list.data.items.map((t: any) => {
                  const total = Number(t.total_standard_hours) + Number(t.total_overtime_hours);
                  return (
                    <tr key={t.timesheet_id}>
                      <td><Person name={t.consultant_name} sub={t.job_title} /></td>
                      <td className="mono">{date(t.week_start)}
                        <div className="person-role">to {date(t.week_end)}</div></td>
                      <td className="num"><strong>{hours(total)}</strong></td>
                      <td className="num">{t.bill_rate ? money(total * Number(t.bill_rate)) : '—'}</td>
                      <td className="right">
                        <div className="btn-row" style={{ justifyContent: 'flex-end' }}>
                          <button className="btn btn-sm" onClick={() => setOpenSheet(t)}>View days</button>
                          <button className="btn btn-sm btn-danger" onClick={() => setRejecting(t)}>Reject</button>
                          <button className="btn btn-sm btn-success" onClick={() => approve(t)}>Approve</button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
      </Card>

      {rejecting && (
        <RejectModal timesheet={rejecting} onClose={() => setRejecting(null)}
          onSaved={() => {
            setRejecting(null); list.reload();
            setMsg({ kind: 'success', text: 'Week returned to the consultant with your reason.' });
          }} />
      )}
      {openSheet && <DayDetail timesheet={openSheet} onClose={() => setOpenSheet(null)} />}
    </>
  );
}

function RejectModal({ timesheet, onClose, onSaved }: { timesheet: any; onClose: () => void; onSaved: () => void }) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true); setError(null);
    try {
      await api.post(`/timesheets/${timesheet.timesheet_id}/decision`, { decision: 'REJECT', reason });
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not reject');
    } finally { setBusy(false); }
  }

  return (
    <Modal title="Return this week to the consultant" onClose={onClose}
      footer={<>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-danger" disabled={busy || reason.trim().length < 5} onClick={save}>
          {busy ? 'Sending…' : 'Return with reason'}
        </button>
      </>}>
      {error && <Alert kind="error">{error}</Alert>}
      <p className="small">{timesheet.consultant_name} · week of {date(timesheet.week_start)}</p>
      <Field label="Reason" required
        hint="At least five characters. Without a reason the consultant cannot correct the week.">
        <textarea value={reason} onChange={(e) => setReason(e.target.value)}
          placeholder="Tuesday shows 10 hours but you were on site for 8." />
      </Field>
    </Modal>
  );
}

function DayDetail({ timesheet, onClose }: { timesheet: any; onClose: () => void }) {
  const d = useLoad<any>(() => api.get(`/timesheets/${timesheet.timesheet_id}`), [timesheet.timesheet_id]);
  return (
    <Modal title={`${timesheet.consultant_name} — week of ${date(timesheet.week_start)}`} onClose={onClose}>
      {d.loading ? <Loading /> : (
        <table>
          <thead><tr><th>Day</th><th className="num">Normal</th>
            <th className="num">Overtime</th><th>Note</th></tr></thead>
          <tbody>
            {(d.data?.lines ?? []).map((l: any) => (
              <tr key={l.lineId}>
                <td>{date(l.workDate)}</td>
                <td className="num">{hours(l.normalHours)}</td>
                <td className="num">{hours(l.overtimeHours)}</td>
                <td className="muted small">{l.note ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Modal>
  );
}
