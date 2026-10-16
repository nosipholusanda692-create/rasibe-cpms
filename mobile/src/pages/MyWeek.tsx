import { useEffect, useMemo, useState } from 'react';
import {
  api, useAuth, useLoad, useOnline, enqueue, flushQueue, readQueue,
  addDays, dayName, dayNumber, isWeekend, mondayOf, today, fmtHours, fmtDate,
  Status, Banner, Loading, Empty, type TimesheetLine, type PendingWeek,
} from '../lib';

/**
 * The consultant's week (UC-16, UC-17, UC-32).
 *
 * One row per day rather than a table, because a seven-column grid on a phone
 * is unusable. Hours are captured whether or not there is a signal; with no
 * connection the week is held on the device and sent when one returns.
 */
export default function MyWeek() {
  const { user } = useAuth();
  const [weekStart, setWeekStart] = useState(() => mondayOf(new Date()));
  const [online, setOnline] = useOnline();
  const [pending, setPending] = useState<PendingWeek[]>(readQueue);
  const [flash, setFlash] = useState<{ kind: 'ok' | 'error' | 'pending'; text: string } | null>(null);

  const sheets = useLoad<any>(
    () => api.get(`/timesheets/my/current?weekStart=${weekStart}`),
    [weekStart],
  );

  // When connectivity returns, send whatever the device is holding.
  useEffect(() => {
    if (!online || pending.length === 0) return;
    let cancelled = false;

    void (async () => {
      const r = await flushQueue();
      if (cancelled) return;
      setPending(readQueue());

      if (r.conflicts.length) {
        setFlash({ kind: 'error', text: r.conflicts[0] });
      } else if (r.sent > 0) {
        setFlash({ kind: 'ok', text: `${r.sent} week${r.sent > 1 ? 's' : ''} sent to the office.` });
      }
      sheets.reload();
    })();

    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [online, pending.length]);

  const pendingForWeek = (placementId: string) =>
    pending.find((p) => p.placementId === placementId && p.weekStart === weekStart);

  const isCurrentWeek = weekStart === mondayOf(new Date());

  return (
    <div className="screen has-tabs">
      <header className="appbar">
        <div className="brand-mark">R</div>
        <div style={{ flex: 1 }}>
          <h1>My week</h1>
          <div className="sub">{user?.fullName}</div>
        </div>
        {!online && <span className="pill pill-amber">Offline</span>}
      </header>

      {!online && (
        <Banner kind="offline">
          No connection. Hours are saved on this phone and sent automatically when you are back online.
        </Banner>
      )}
      {online && pending.length > 0 && (
        <Banner kind="pending">
          {pending.length} week{pending.length > 1 ? 's' : ''} waiting to be sent…
        </Banner>
      )}
      {flash && <Banner kind={flash.kind === 'pending' ? 'pending' : flash.kind}>{flash.text}</Banner>}

      <div className="weeknav">
        <button onClick={() => setWeekStart(addDays(weekStart, -7))} aria-label="Previous week">‹</button>
        <div className="label">
          {fmtDate(weekStart)} – {fmtDate(addDays(weekStart, 6))}
          {isCurrentWeek && <div className="sheet-sub">This week</div>}
        </div>
        <button
          onClick={() => setWeekStart(addDays(weekStart, 7))}
          disabled={weekStart >= mondayOf(new Date())}
          aria-label="Next week"
        >›</button>
      </div>

      {sheets.loading ? <Loading />
        : sheets.error ? <Banner kind="error">{sheets.error}</Banner>
        : !sheets.data?.items?.length ? (
          <Empty>You have no active placement for this week.</Empty>
        ) : (
          sheets.data.items.map((sheet: any) => (
            <WeekCard
              key={sheet.timesheet_id}
              sheet={sheet}
              weekStart={weekStart}
              online={online}
              queued={pendingForWeek(sheet.placement_id)}
              onQueued={() => {
                setPending(readQueue());
                setFlash({
                  kind: 'pending',
                  text: 'Saved on this phone. It will be sent when you are back online.',
                });
              }}
              onSaved={(text) => { setFlash({ kind: 'ok', text }); sheets.reload(); }}
              onError={(text) => { setFlash({ kind: 'error', text }); setOnline(navigator.onLine); }}
            />
          ))
        )}
    </div>
  );
}

function WeekCard({
  sheet, weekStart, online, queued, onSaved, onQueued, onError,
}: {
  sheet: any;
  weekStart: string;
  online: boolean;
  queued?: PendingWeek;
  onSaved: (m: string) => void;
  onQueued: () => void;
  onError: (m: string) => void;
}) {
  const days = useMemo(
    () => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)),
    [weekStart],
  );

  const [rows, setRows] = useState<Record<string, { normal: string; overtime: string }>>(() => {
    const init: Record<string, { normal: string; overtime: string }> = {};
    for (const d of days) {
      // a queued copy is what the consultant last typed, so it wins over the server copy
      const q = queued?.lines.find((l) => l.workDate === d);
      const line = (sheet.lines ?? []).find((l: any) => String(l.work_date).slice(0, 10) === d);
      init[d] = q
        ? { normal: String(q.normalHours || ''), overtime: String(q.overtimeHours || '') }
        : { normal: line ? String(Number(line.normal_hours) || '') : '',
            overtime: line ? String(Number(line.overtime_hours) || '') : '' };
    }
    return init;
  });

  const [busy, setBusy] = useState(false);

  /**
   * Per-day checks, shown as the hours are typed.
   *
   * The ceiling comes from the placement's own standard day where there is one.
   * These are also enforced on the server and by a check constraint; here they
   * exist so a mistake is visible before the week is submitted.
   */
  const dayErrors = useMemo(() => {
    const out: Record<string, string> = {};
    for (const d of days) {
      const n = Number(rows[d]?.normal || 0);
      const o = Number(rows[d]?.overtime || 0);
      if (rows[d]?.normal !== '' && Number.isNaN(n)) { out[d] = 'Hours must be a number'; continue; }
      if (rows[d]?.overtime !== '' && Number.isNaN(o)) { out[d] = 'Overtime must be a number'; continue; }
      if (n < 0 || o < 0) { out[d] = 'Hours cannot be negative'; continue; }
      if (n + o > 16) { out[d] = 'More than 16 hours in one day'; continue; }
      if (n + o > 24) { out[d] = 'A day has 24 hours'; }
    }
    return out;
  }, [rows, days]);

  const hasDayError = Object.keys(dayErrors).length > 0;
  const status = queued ? 'PENDING_SYNC' : sheet.status;
  const editable = ['DRAFT', 'PENDING_SYNC', 'REJECTED'].includes(sheet.status);

  const totalNormal = days.reduce((s, d) => s + Number(rows[d]?.normal || 0), 0);
  const totalOvertime = days.reduce((s, d) => s + Number(rows[d]?.overtime || 0), 0);
  const total = totalNormal + totalOvertime;

  function set(day: string, field: 'normal' | 'overtime', value: string) {
    setRows((r) => ({ ...r, [day]: { ...r[day], [field]: value } }));
  }

  /** The common case is a standard week, so offer it rather than making them type it seven times. */
  function fillStandardWeek() {
    const hoursPerDay = String(Number(sheet.placement?.standard_hours_per_day ?? 8));
    setRows((r) => {
      const next = { ...r };
      for (const d of days) {
        if (isWeekend(d) || d > today()) continue;
        next[d] = { normal: hoursPerDay, overtime: next[d]?.overtime ?? '' };
      }
      return next;
    });
  }

  function clearWeek() {
    setRows(Object.fromEntries(days.map((d) => [d, { normal: '', overtime: '' }])));
  }

  function lines(): TimesheetLine[] {
    return days
      .filter((d) => Number(rows[d]?.normal || 0) > 0 || Number(rows[d]?.overtime || 0) > 0)
      .map((d) => ({
        workDate: d,
        normalHours: Number(rows[d].normal || 0),
        overtimeHours: Number(rows[d].overtime || 0),
      }));
  }

  async function save(submit: boolean) {
    if (hasDayError) {
      onError('Correct the hours shown in red before saving.');
      return;
    }
    const payload = lines();

    if (submit && payload.length === 0) {
      onError('Record some hours before submitting the week.');
      return;
    }

    // No connection: hold it on the device against a token generated here.
    if (!online) {
      enqueue({
        placementId: sheet.placement_id,
        weekStart,
        rowVersion: Number(sheet.row_version ?? 0),
        submit,
        lines: payload,
        label: `${sheet.placement?.client_name ?? ''} — ${fmtDate(weekStart)}`,
      });
      onQueued();
      return;
    }

    setBusy(true);
    try {
      await api.put(`/timesheets/${sheet.timesheet_id}/lines`, { lines: payload });
      if (submit) {
        await api.post(`/timesheets/${sheet.timesheet_id}/submit`);
        onSaved('Week submitted. Your approver has been told.');
      } else {
        onSaved('Week saved.');
      }
    } catch (e) {
      // A failed write may mean the connection dropped between the check and
      // the send, so keep the work rather than losing it.
      enqueue({
        placementId: sheet.placement_id,
        weekStart,
        rowVersion: Number(sheet.row_version ?? 0),
        submit,
        lines: payload,
        label: `${sheet.placement?.client_name ?? ''} — ${fmtDate(weekStart)}`,
      });
      onQueued();
      onError(e instanceof Error ? e.message : 'Could not send. The week is saved on this phone.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <section className="card">
        <div className="card-head">
          <div style={{ flex: 1, minWidth: 0 }}>
            <h2>{sheet.placement?.client_name ?? sheet.client_name}</h2>
            <div className="sub">{sheet.placement?.job_title}</div>
          </div>
          <Status value={status} />
        </div>

        {sheet.status === 'REJECTED' && (
          <div style={{ padding: '12px 14px' }}>
            <Banner kind="error">
              <strong>Returned for correction.</strong> {sheet.rejected_reason}
            </Banner>
          </div>
        )}

        {editable && (
          <div className="quickfill">
            <button className="chip" onClick={fillStandardWeek}>
              Fill standard week
            </button>
            <button className="chip" onClick={clearWeek}>Clear</button>
          </div>
        )}

        {days.map((d) => {
          const future = d > today();
          return (
            <div key={d} className={`day${isWeekend(d) ? ' weekend' : ''}${future ? ' future' : ''}`}>
              <div className="day-label">
                <div className="day-name">{dayName(d)}</div>
                <div className="day-date">{dayNumber(d)}</div>
              </div>
              <div className="day-inputs">
                <div className="hour-field">
                  <label>Hours</label>
                  <input
                    type="number" inputMode="decimal" min={0} max={24} step={0.5}
                    disabled={!editable || future}
                    value={rows[d]?.normal ?? ''}
                    placeholder={future ? '–' : '0'}
                    aria-invalid={dayErrors[d] ? true : undefined}
                    onChange={(e) => set(d, 'normal', e.target.value)}
                  />
                </div>
                <div className="hour-field">
                  <label>Overtime</label>
                  <input
                    type="number" inputMode="decimal" min={0} max={24} step={0.5}
                    disabled={!editable || future}
                    value={rows[d]?.overtime ?? ''}
                    placeholder={future ? '–' : '0'}
                    aria-invalid={dayErrors[d] ? true : undefined}
                    onChange={(e) => set(d, 'overtime', e.target.value)}
                  />
                </div>
              </div>
            </div>
          );
        })}

        {hasDayError && (
          <div style={{ padding: '0 14px 12px' }}>
            {Object.entries(dayErrors).map(([d, message]) => (
              <div className="field-error" key={d}>{dayName(d)} {dayNumber(d)}: {message}</div>
            ))}
          </div>
        )}

        <div className="week-total">
          <span className="n">{fmtHours(total)}</span>
          <span className="l">
            hours this week
            {totalOvertime > 0 && ` · ${fmtHours(totalOvertime)} overtime`}
          </span>
        </div>

        {!editable && (
          <div className="card-body small muted">
            {sheet.status === 'SUBMITTED' && 'Waiting for your approver.'}
            {sheet.status === 'APPROVED' && `Approved ${fmtDate(sheet.approved_at)}.`}
            {sheet.status === 'INVOICED' && 'Included on an invoice.'}
            {sheet.status === 'LOCKED' && 'This week is closed.'}
          </div>
        )}
      </section>

      {editable && (
        <div className="actions above-tabs">
          <button className="btn btn-grow" disabled={busy || hasDayError} onClick={() => save(false)}>
            Save
          </button>
          <button className="btn btn-primary btn-grow"
            disabled={busy || hasDayError || total <= 0}
            onClick={() => save(true)}>
            {online ? 'Submit' : 'Save on phone'}
          </button>
        </div>
      )}
    </>
  );
}
