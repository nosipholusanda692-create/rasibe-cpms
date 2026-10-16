import { useState } from 'react';
import {
  api, useLoad, useAuth, initials, fmtDate, fmtHours, money,
  Banner, Loading, Empty,
} from '../lib';

/**
 * Client manager approvals (UC-18).
 *
 * The client asked for this to be two taps from the notification (FB-01), so
 * approve sits on the row itself. Rejecting opens a sheet, because a reason is
 * required and typing one needs room.
 */
export default function Approvals() {
  const { user } = useAuth();
  const [flash, setFlash] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [rejecting, setRejecting] = useState<any | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const list = useLoad<any>(() => api.get('/timesheets?status=SUBMITTED'));

  async function approve(t: any) {
    setBusy(t.timesheet_id);
    try {
      await api.post(`/timesheets/${t.timesheet_id}/decision`, { decision: 'APPROVE' });
      setFlash({ kind: 'ok', text: `Approved ${t.consultant_name}, week of ${fmtDate(t.week_start)}.` });
      list.reload();
    } catch (e) {
      setFlash({ kind: 'error', text: e instanceof Error ? e.message : 'Could not approve' });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="screen has-tabs">
      <header className="appbar">
        <div className="brand-mark">R</div>
        <div style={{ flex: 1 }}>
          <h1>Approvals</h1>
          <div className="sub">{user?.clients?.[0]?.name ?? 'Timesheets awaiting you'}</div>
        </div>
      </header>

      {flash && <Banner kind={flash.kind}>{flash.text}</Banner>}

      {list.loading ? <Loading />
        : list.error ? <Banner kind="error">{list.error}</Banner>
        : !list.data?.items?.length ? (
          <Empty>Nothing is waiting for you.</Empty>
        ) : (
          <section className="card">
            {list.data.items.map((t: any) => {
              const total = Number(t.total_standard_hours) + Number(t.total_overtime_hours);
              const open = expanded === t.timesheet_id;
              return (
                <div className="approval" key={t.timesheet_id}>
                  <div className="approval-top">
                    <div className="avatar">{initials(t.consultant_name ?? '')}</div>
                    <div className="stack" style={{ flex: 1 }}>
                      <span className="approval-name">{t.consultant_name}</span>
                      <span className="approval-meta">{t.job_title}</span>
                      <span className="approval-meta">
                        Week of {fmtDate(t.week_start)}
                        {t.days_since_week_end > 7 && (
                          <span className="pill pill-red" style={{ marginLeft: 6 }}>
                            {t.days_since_week_end} days
                          </span>
                        )}
                      </span>
                    </div>
                    <div className="approval-hours">
                      <div className="n">{fmtHours(total)}</div>
                      <div className="l">hours</div>
                      {t.bill_rate && (
                        <div className="l">{money(total * Number(t.bill_rate))}</div>
                      )}
                    </div>
                  </div>

                  {open && <DayBreakdown timesheetId={t.timesheet_id} />}

                  <div className="approval-actions">
                    <button
                      className="btn btn-ghost"
                      onClick={() => setExpanded(open ? null : t.timesheet_id)}
                    >
                      {open ? 'Hide days' : 'View days'}
                    </button>
                    <div className="spacer" />
                    <button className="btn btn-danger" onClick={() => setRejecting(t)}>
                      Reject
                    </button>
                    <button
                      className="btn btn-success"
                      disabled={busy === t.timesheet_id}
                      onClick={() => approve(t)}
                    >
                      {busy === t.timesheet_id ? '…' : 'Approve'}
                    </button>
                  </div>
                </div>
              );
            })}
          </section>
        )}

      {rejecting && (
        <RejectSheet
          timesheet={rejecting}
          onClose={() => setRejecting(null)}
          onDone={() => {
            setRejecting(null);
            list.reload();
            setFlash({ kind: 'ok', text: 'Returned to the consultant with your reason.' });
          }}
        />
      )}
    </div>
  );
}

function DayBreakdown({ timesheetId }: { timesheetId: string }) {
  const d = useLoad<any>(() => api.get(`/timesheets/${timesheetId}`), [timesheetId]);
  if (d.loading) return <div className="small muted" style={{ padding: '10px 0' }}>Loading days…</div>;
  return (
    <div style={{ marginTop: 10, borderTop: '1px solid var(--line-soft)' }}>
      {(d.data?.lines ?? []).map((l: any) => (
        <div className="list-row" key={l.lineId} style={{ paddingLeft: 0, paddingRight: 0 }}>
          <span style={{ flex: 1 }}>{fmtDate(l.workDate)}</span>
          <span className="muted small">{fmtHours(l.normalHours)} h</span>
          {Number(l.overtimeHours) > 0 && (
            <span className="pill pill-amber">+{fmtHours(l.overtimeHours)} OT</span>
          )}
        </div>
      ))}
    </div>
  );
}

/**
 * A reason of at least five characters is required (BR-005). Without one the
 * consultant cannot tell what to correct, so the button stays disabled.
 */
function RejectSheet({
  timesheet, onClose, onDone,
}: { timesheet: any; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const [touched, setTouched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // BR-005. Checked here so the person sees it as they type, and again on the
  // server and as a check constraint, which are the ones that count.
  const tooShort = reason.trim().length < 5;
  const showError = touched && tooShort;

  async function send() {
    setTouched(true);
    if (tooShort) return;
    setBusy(true);
    setError(null);
    try {
      await api.post(`/timesheets/${timesheet.timesheet_id}/decision`, {
        decision: 'REJECT',
        reason: reason.trim(),
      });
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not send');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="screen" style={{
      position: 'fixed', inset: 0, background: 'var(--canvas)', zIndex: 40, overflowY: 'auto',
    }}>
      <header className="appbar">
        <button className="appbar-btn" onClick={onClose}>Cancel</button>
        <h1 style={{ textAlign: 'center' }}>Return week</h1>
        <span style={{ width: 60 }} />
      </header>

      <section className="card">
        <div className="card-body">
          <div className="sheet-title">{timesheet.consultant_name}</div>
          <div className="sheet-sub">Week of {fmtDate(timesheet.week_start)}</div>
        </div>
      </section>

      {error && <Banner kind="error">{error}</Banner>}

      <section className="card">
        <div className="card-body">
          <div className="field">
            <label>Reason</label>
            <textarea
              value={reason}
              aria-invalid={showError ? true : undefined}
              onChange={(e) => setReason(e.target.value)}
              onBlur={() => setTouched(true)}
              placeholder="Tuesday shows 10 hours but you were on site for 8."
              autoFocus
            />
            {showError ? (
              <div className="field-error">
                Give a reason of at least five characters, so the consultant knows what to correct
              </div>
            ) : (
              <div className="field-hint">
                {reason.trim().length > 0
                  ? `${reason.trim().length} characters`
                  : 'Without a reason the consultant cannot correct the week.'}
              </div>
            )}
          </div>
        </div>
      </section>

      <div className="actions">
        <button className="btn btn-grow" onClick={onClose}>Cancel</button>
        <button
          className="btn btn-danger btn-grow"
          disabled={busy || (touched && tooShort)}
          onClick={send}
        >
          {busy ? 'Sending…' : 'Return with reason'}
        </button>
      </div>
    </div>
  );
}
