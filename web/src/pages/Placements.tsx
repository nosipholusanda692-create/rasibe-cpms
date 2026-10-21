import { useState } from 'react';
import { api, useAuth, useLoad, useFormError, Card, Status, Loading, Alert, Empty, Person, Field, Modal, ReasonModal, Pager, usePaging, money, date, titleCase } from '../lib';
import { useForm, required, reason } from '../validation';

/** Placement list. `mine` serves the consultant's own view. */
export default function Placements({ mine }: { mine?: boolean }) {
  const { user, can } = useAuth();
  const [status, setStatus] = useState('');
  const [msg, setMsg] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  const [rateChange, setRateChange] = useState<any | null>(null);
  const [terminating, setTerminating] = useState<any | null>(null);
  const [extending, setExtending] = useState<any | null>(null);

  const qs = new URLSearchParams();
  if (status) qs.set('status', status);
  if (mine && user?.consultantId) qs.set('consultantId', user.consultantId);

  const { page, setPage } = usePaging([status, mine]);
  qs.set('page', String(page));

  const list = useLoad<any>(() => api.get(`/placements?${qs}`),
    [status, mine, user?.consultantId, page]);
  const isAdmin = user?.role === 'ADMINISTRATOR';
  const isConsultant = user?.role === 'CONSULTANT';
  const isClient = user?.role === 'CLIENT_MANAGER';

  async function approveRates(id: string) {
    try {
      await api.post(`/placements/${id}/approve-rates`, { reason: 'Rates approved' });
      setMsg({ kind: 'success', text: 'Rates approved. The placement is now live.' });
      list.reload();
    } catch (e) {
      setMsg({ kind: 'error', text: e instanceof Error ? e.message : 'Could not approve' });
    }
  }

  return (
    <>
      {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}
      {isConsultant && (
        <Alert kind="info">
          Your placements show the rate you are paid. The rate charged to the client
          is held on the agency side and is not part of your record.
        </Alert>
      )}

      <Card title={mine ? 'My placements' : 'Placements'}
        subtitle={list.data ? `${list.data.total ?? list.data.items.length} placements` : undefined}
        footer={list.data && (
          <Pager page={list.data.page} pageSize={list.data.pageSize} total={list.data.total}
            pageCount={list.data.pageCount} onPage={setPage} noun="placements" />
        )}>
        <div className="filters">
          <Field label="Status">
            <select value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">All</option>
              <option value="ACTIVE,ENDING_SOON">Live</option>
              <option value="PENDING_RATE_APPROVAL">Awaiting rate approval</option>
              <option value="PENDING_START">Not started</option>
              <option value="ENDED,TERMINATED">Finished</option>
            </select>
          </Field>
        </div>

        {list.loading ? <Loading />
          : list.error ? <Alert kind="error">{list.error}</Alert>
          : !list.data?.items.length ? <Empty message="No placements match that filter." />
          : (
            <table>
              <thead>
                <tr>
                  <th>{isConsultant ? 'Client' : 'Consultant'}</th>
                  {!isConsultant && <th>Client</th>}
                  <th>Role</th><th>Period</th>
                  {!isConsultant && <th className="num">Bill</th>}
                  {!isClient && <th className="num">Pay</th>}
                  {isAdmin && <th className="num">Margin</th>}
                  <th>Status</th>
                  {isAdmin && <th className="right">Action</th>}
                </tr>
              </thead>
              <tbody>
                {list.data.items.map((p: any) => (
                  <tr key={p.placement_id}>
                    <td>
                      {isConsultant
                        ? <><strong>{p.client_name}</strong><div className="person-role">{p.reference}</div></>
                        : <Person name={p.consultant_name} sub={p.reference} />}
                    </td>
                    {!isConsultant && <td>{p.client_name}</td>}
                    <td>{p.job_title}
                      <div className="person-role">{titleCase(p.engagement_type)} · {titleCase(p.work_mode)}</div>
                    </td>
                    <td className="mono small">
                      {date(p.start_date)} – {date(p.end_date)}
                      {p.extension_count > 0 && (
                        <div className="person-role">
                          Extended {p.extension_count === 1 ? 'once' : `${p.extension_count} times`}
                          {p.original_end_date && ` · originally to ${date(p.original_end_date)}`}
                        </div>
                      )}
                      {p.days_remaining <= 30 && p.days_remaining >= 0 && (
                        <div><span className={`pill pill-${p.days_remaining <= 14 ? 'red' : 'amber'}`}>
                          {p.days_remaining} days left</span></div>
                      )}
                    </td>
                    {!isConsultant && <td className="num">{money(p.bill_rate)}</td>}
                    {!isClient && <td className="num">{money(p.pay_rate)}</td>}
                    {isAdmin && <td className="num"><strong>{money(p.margin_amount)}</strong></td>}
                    <td><Status value={p.status} /></td>
                    {isAdmin && (
                      <td className="right">
                        <div className="btn-row" style={{ justifyContent: 'flex-end' }}>
                          {p.status === 'PENDING_RATE_APPROVAL' && (
                            <button className="btn btn-sm btn-success"
                              onClick={() => approveRates(p.placement_id)}>Approve rates</button>
                          )}
                          {['ACTIVE', 'ENDING_SOON', 'PENDING_START'].includes(p.status) && (
                            <>
                              <button className="btn btn-sm" onClick={() => setRateChange(p)}>Change rates</button>
                              <button className="btn btn-sm"
                                onClick={() => setExtending(p)}>Extend</button>
                              <button className="btn btn-sm btn-danger"
                                onClick={() => setTerminating(p)}>End early</button>
                            </>
                          )}
                        </div>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
      </Card>

      {extending && (
        <ExtendPlacement
          placement={extending}
          onClose={() => setExtending(null)}
          onSaved={(text) => { setExtending(null); list.reload(); setMsg({ kind: 'success', text }); }} />
      )}

      {terminating && (
        <ReasonModal
          title={`End ${terminating.reference} early`}
          intent={`${terminating.consultant_name} at ${terminating.client_name} is scheduled to run to ${date(terminating.end_date)}. Ending it now stops further timesheets. Hours already approved remain billable, and an invoice already issued is unaffected.`}
          confirmLabel="End placement"
          danger
          onClose={() => setTerminating(null)}
          onConfirm={async (reason) => {
            await api.post(`/placements/${terminating.placement_id}/terminate`, { reason });
            setTerminating(null);
            list.reload();
            setMsg({
              kind: 'success',
              text: 'Placement ended. The consultant returns to the available pool.',
            });
          }} />
      )}

      {rateChange && (
        <RateChange placement={rateChange} onClose={() => setRateChange(null)}
          onSaved={() => {
            setRateChange(null); list.reload();
            setMsg({ kind: 'success', text: 'Rates changed. The placement is awaiting approval again, and weeks already approved keep their original rate.' });
          }} />
      )}
    </>
  );
}

function RateChange({ placement, onClose, onSaved }: { placement: any; onClose: () => void; onSaved: () => void }) {
  const [bill, setBill] = useState(String(placement.bill_rate ?? ''));
  const [pay, setPay] = useState(String(placement.pay_rate ?? ''));
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true); setError(null);
    try {
      await api.patch(`/placements/${placement.placement_id}/rates`, {
        billRate: Number(bill), payRate: Number(pay), reason,
      });
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not change the rates');
    } finally { setBusy(false); }
  }

  return (
    <Modal title={`Change rates — ${placement.reference}`} onClose={onClose}
      footer={<>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={busy || reason.trim().length < 5} onClick={save}>
          {busy ? 'Saving…' : 'Change rates'}
        </button>
      </>}>
      {error && <Alert kind="error">{error}</Alert>}
      <div className="form-row">
        <Field label="Bill rate" required><input type="number" value={bill}
          onChange={(e) => setBill(e.target.value)} /></Field>
        <Field label="Pay rate" required><input type="number" value={pay}
          onChange={(e) => setPay(e.target.value)} /></Field>
      </div>
      <Field label="Reason" required hint="At least five characters. Recorded in the audit log.">
        <textarea value={reason} onChange={(e) => setReason(e.target.value)} />
      </Field>
      <Alert kind="warn">
        Changing a rate returns this placement to awaiting approval. Weeks that have
        already been submitted keep the rate they were submitted at.
      </Alert>
    </Modal>
  );
}

/**
 * Extending a placement (FR-PLC-006).
 *
 * An extension moves the end date of the same placement. It does not create a
 * second one: a consultant who stays six months longer at the same client is
 * one engagement, and splitting it would double-count the placement in every
 * report and risk tripping the overlap rule against itself.
 *
 * The original end date is kept, so the history of an engagement that ran twice
 * as long as agreed is still legible a year later.
 */
function ExtendPlacement({
  placement, onClose, onSaved,
}: { placement: any; onClose: () => void; onSaved: (text: string) => void }) {
  const err = useFormError();
  const [busy, setBusy] = useState(false);

  const currentEnd = String(placement.end_date).slice(0, 10);

  const form = useForm(
    { newEndDate: '', reason: '' },
    {
      newEndDate: [
        required('A new end date'),
        (v) => (v && v <= currentEnd
          ? `The new end date must be later than ${date(currentEnd)}` : undefined),
        (v) => {
          if (!v) return undefined;
          const limit = new Date(currentEnd);
          limit.setFullYear(limit.getFullYear() + 2);
          return v > limit.toISOString().slice(0, 10)
            ? 'That is more than two years past the current end date. Check the year.'
            : undefined;
        },
      ],
      reason: [reason],
    },
  );

  const f = form.values;

  // what the extension actually buys, in plain terms
  const extraDays = f.newEndDate && f.newEndDate > currentEnd
    ? Math.round((new Date(f.newEndDate).getTime() - new Date(currentEnd).getTime()) / 86_400_000)
    : 0;
  const extraMonths = extraDays ? Math.round(extraDays / 30.44) : 0;

  async function save() {
    if (!form.attemptSubmit()) return;
    setBusy(true); err.clear();
    try {
      await api.post(`/placements/${placement.placement_id}/extend`, {
        newEndDate: f.newEndDate,
        reason: f.reason.trim(),
      });
      onSaved(
        `${placement.consultant_name} now runs to ${date(f.newEndDate)} at ${placement.client_name}.`,
      );
    } catch (e) {
      err.capture(e);
      form.applyServerErrors((e as any)?.detail);
    } finally { setBusy(false); }
  }

  return (
    <Modal title={`Extend ${placement.reference}`} onClose={onClose}
      footer={<>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" onClick={save}
          disabled={busy || (form.submitted && !form.isValid)}>
          {busy ? 'Extending…' : 'Extend placement'}
        </button>
      </>}>
      {err.error && <Alert kind="error">{err.error}</Alert>}

      <dl className="def-list" style={{ marginBottom: 16 }}>
        <div><dt>Consultant</dt><dd>{placement.consultant_name}</dd></div>
        <div><dt>Client</dt><dd>{placement.client_name}</dd></div>
        <div><dt>Currently runs to</dt><dd>{date(currentEnd)}</dd></div>
      </dl>

      {placement.extension_count > 0 && (
        <Alert kind="info">
          This placement has already been extended
          {placement.extension_count === 1 ? ' once' : ` ${placement.extension_count} times`}
          {placement.original_end_date && `, from ${date(placement.original_end_date)}`}.
        </Alert>
      )}

      <Field label="New end date" required error={form.errorFor('newEndDate')}>
        <input type="date" min={currentEnd} {...form.fieldProps('newEndDate')} />
      </Field>

      {extraDays > 0 && !form.errorFor('newEndDate') && (
        <Alert kind="info">
          {extraMonths >= 1
            ? `${extraMonths} month${extraMonths === 1 ? '' : 's'} longer`
            : `${extraDays} day${extraDays === 1 ? '' : 's'} longer`}
          . The rates stay as they are; change them separately if they have been renegotiated.
        </Alert>
      )}

      <Field label="Reason" required error={form.errorFor('reason')}
        hint="Recorded in the audit log with the dates before and after.">
        <textarea {...form.fieldProps('reason')}
          placeholder="Client extended the project to the end of the financial year." />
      </Field>

      <Alert kind="warn">
        The same placement continues, so its timesheets, approvals and invoices stay together
        as one engagement. The original end date is kept.
      </Alert>
    </Modal>
  );
}
