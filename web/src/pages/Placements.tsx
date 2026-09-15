import { useState } from 'react';
import { api, useAuth, useLoad, Card, Status, Loading, Alert, Empty, Person, Field, Modal, money, date, titleCase } from '../lib';

/** Placement list. `mine` serves the consultant's own view. */
export default function Placements({ mine }: { mine?: boolean }) {
  const { user, can } = useAuth();
  const [status, setStatus] = useState('');
  const [msg, setMsg] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  const [rateChange, setRateChange] = useState<any | null>(null);

  const qs = new URLSearchParams();
  if (status) qs.set('status', status);
  if (mine && user?.consultantId) qs.set('consultantId', user.consultantId);

  const list = useLoad<any>(() => api.get(`/placements?${qs}`), [status, mine, user?.consultantId]);
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
        subtitle={list.data ? `${list.data.items.length} placements` : undefined}>
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
                            <button className="btn btn-sm" onClick={() => setRateChange(p)}>Change rates</button>
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
