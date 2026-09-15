import { useState } from 'react';
import { Link, useParams, useNavigate } from 'react-router-dom';
import { api, useAuth, useLoad, Card, Status, Loading, Alert, Empty, Field, Modal, money, hours, date, titleCase } from '../lib';

/** Invoice run and list (UC-20, UC-21). */
export default function Invoices() {
  const { user } = useAuth();
  const [status, setStatus] = useState('');
  const [preparing, setPreparing] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'success' | 'error' | 'warn'; text: string } | null>(null);
  const list = useLoad<any>(() => api.get(`/invoices${status ? `?status=${status}` : ''}`), [status]);
  const isAdmin = user?.role === 'ADMINISTRATOR';

  return (
    <>
      {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}
      <Card title="Invoices"
        subtitle={list.data ? `${list.data.items.length} invoices` : undefined}
        action={isAdmin && (
          <button className="btn btn-primary btn-sm" onClick={() => setPreparing(true)}>
            New invoice run
          </button>
        )}>
        <div className="filters">
          <Field label="Status">
            <select value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">All</option>
              <option value="DRAFT,AWAITING_APPROVAL,APPROVED">Not yet issued</option>
              <option value="ISSUED,OVERDUE,PART_PAID">Outstanding</option>
              <option value="PAID">Paid</option>
            </select>
          </Field>
        </div>

        {list.loading ? <Loading />
          : list.error ? <Alert kind="error">{list.error}</Alert>
          : !list.data?.items.length ? <Empty message="No invoices match that filter." />
          : (
            <table>
              <thead>
                <tr><th>Invoice</th><th>Client</th><th>Period</th>
                  <th className="num">Total</th><th className="num">Outstanding</th>
                  <th>Status</th><th>Due</th></tr>
              </thead>
              <tbody>
                {list.data.items.map((i: any) => (
                  <tr key={i.invoice_id} className="clickable">
                    <td>
                      <Link to={`/invoices/${i.invoice_id}`}>
                        <strong>{i.invoice_number ?? 'Draft'}</strong>
                      </Link>
                      <div className="person-role">{i.line_count} lines</div>
                    </td>
                    <td>{i.client_name}</td>
                    <td className="mono small">{date(i.period_start)} – {date(i.period_end)}</td>
                    <td className="num">{money(i.total)}</td>
                    <td className="num">{money(Number(i.total) - Number(i.amount_paid))}</td>
                    <td><Status value={i.status} /></td>
                    <td className="mono small">
                      {date(i.due_date)}
                      {i.days_overdue > 0 && (
                        <div><span className="pill pill-red">{i.days_overdue} d late</span></div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
      </Card>

      {preparing && (
        <PrepareRun onClose={() => setPreparing(false)}
          onDone={(text, kind) => { setPreparing(false); setMsg({ kind, text }); list.reload(); }} />
      )}
    </>
  );
}

function PrepareRun({ onClose, onDone }: {
  onClose: () => void; onDone: (t: string, k: 'success' | 'warn' | 'error') => void;
}) {
  const clients = useLoad<any>(() => api.get('/clients'));
  const [clientId, setClientId] = useState('');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<any | null>(null);

  async function run() {
    setBusy(true); setError(null);
    try {
      const r = await api.post<any>('/invoices/prepare', {
        clientId, periodStart: start, periodEnd: end,
      });
      if (!r.invoice) { setPreview(r); setError(r.message); return; }
      setPreview(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not prepare the invoice');
    } finally { setBusy(false); }
  }

  return (
    <Modal title="Prepare an invoice" onClose={onClose}
      footer={preview?.invoice ? (
        <>
          <button className="btn" onClick={onClose}>Close</button>
          <button className="btn btn-primary" onClick={() =>
            onDone(`Draft ${money(preview.invoice.total)} prepared for approval.`, 'success')}>
            Done
          </button>
        </>
      ) : (
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy || !clientId || !start || !end} onClick={run}>
            {busy ? 'Preparing…' : 'Prepare'}
          </button>
        </>
      )}>
      {error && <Alert kind="warn">{error}</Alert>}

      {!preview?.invoice ? (
        <>
          <Field label="Client" required>
            <select value={clientId} onChange={(e) => setClientId(e.target.value)}>
              <option value="">Choose a client</option>
              {(clients.data?.items ?? []).map((c: any) => (
                <option key={c.client_id} value={c.client_id}>{c.legal_name}</option>
              ))}
            </select>
          </Field>
          <div className="form-row">
            <Field label="Period from" required>
              <input type="date" value={start} onChange={(e) => setStart(e.target.value)} />
            </Field>
            <Field label="Period to" required>
              <input type="date" value={end} onChange={(e) => setEnd(e.target.value)} />
            </Field>
          </div>
          <Alert kind="info">
            Only approved weeks are drawn in. Any week still awaiting approval is
            listed so you can see what is being left out.
          </Alert>
        </>
      ) : (
        <>
          <Alert kind="success">
            Draft prepared: {money(preview.invoice.total)} across {preview.lines.length} lines.
          </Alert>
          {preview.outstanding?.length > 0 && (
            <Alert kind="warn">
              {preview.outstanding.length} week(s) are not yet approved and have been left out:
              <ul style={{ margin: '6px 0 0 16px' }}>
                {preview.outstanding.map((o: any) => (
                  <li key={o.timesheet_id}>{o.consultant_name} — week of {date(o.week_start)} ({titleCase(o.status)})</li>
                ))}
              </ul>
            </Alert>
          )}
          <table>
            <thead><tr><th>Line</th><th className="num">Hours</th>
              <th className="num">Rate</th><th className="num">Total</th></tr></thead>
            <tbody>
              {preview.lines.map((l: any) => (
                <tr key={l.invoice_line_id}>
                  <td className="small">{l.description}</td>
                  <td className="num">{hours(l.quantity)}</td>
                  <td className="num">{money(l.unit_rate)}</td>
                  <td className="num">{money(l.line_total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </Modal>
  );
}

/** Invoice detail with approve, issue, credit and export (prototype screen H6). */
export function InvoiceDetailPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const { user } = useAuth();
  const [msg, setMsg] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  const inv = useLoad<any>(() => api.get(`/invoices/${id}`), [id]);
  const isAdmin = user?.role === 'ADMINISTRATOR';

  async function act(path: string, body: unknown, ok: string) {
    try {
      await api.post(`/invoices/${id}/${path}`, body);
      setMsg({ kind: 'success', text: ok });
      inv.reload();
    } catch (e) {
      setMsg({ kind: 'error', text: e instanceof Error ? e.message : 'Could not complete that' });
    }
  }

  if (inv.loading) return <Loading />;
  if (inv.error) return <Alert kind="error">{inv.error}</Alert>;
  const d = inv.data;
  const issued = ['ISSUED', 'OVERDUE', 'PART_PAID', 'PAID'].includes(d.status);

  return (
    <>
      <button className="btn btn-sm" style={{ marginBottom: 12 }} onClick={() => nav('/invoices')}>
        Back to invoices
      </button>
      {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}

      <Card title={d.invoice_number ?? 'Draft invoice'} subtitle={d.client_name}
        action={<Status value={d.status} />}
        footer={isAdmin && (
          <div className="btn-row">
            {d.status === 'AWAITING_APPROVAL' && (
              <button className="btn btn-primary" onClick={() => act('approve', {}, 'Invoice approved.')}>
                Approve
              </button>
            )}
            {d.status === 'APPROVED' && (
              <button className="btn btn-primary" onClick={() => act('issue', {}, 'Invoice issued and sent to the client.')}>
                Issue invoice
              </button>
            )}
            {issued && (
              <>
                <a className="btn" href={`/api/invoices/${id}/export`} onClick={(e) => {
                  e.preventDefault();
                  void act('export', {}, 'Exported for the bookkeeper.');
                }}>Export for bookkeeper</a>
                <button className="btn btn-danger" onClick={() => {
                  const reason = window.prompt('Reason for the credit note:');
                  if (reason && reason.length >= 5) void act('credit-note', { reason }, 'Credit note raised.');
                }}>Raise credit note</button>
              </>
            )}
          </div>
        )}>
        <div className="card-body">
          <dl className="def-list">
            <div><dt>Period</dt><dd>{date(d.period_start)} – {date(d.period_end)}</dd></div>
            <div><dt>Issued</dt><dd>{date(d.issued_at)}</dd></div>
            <div><dt>Due</dt><dd>{date(d.due_date)}</dd></div>
            <div><dt>Payment terms</dt><dd>{d.payment_terms_days} days</dd></div>
            <div><dt>Client registration</dt><dd>{d.registration_number ?? '—'}</dd></div>
            <div><dt>VAT number</dt><dd>{d.vat_number ?? 'Not VAT registered'}</dd></div>
          </dl>
          {d.billing_address && (
            <div style={{ marginTop: 14 }}>
              <div className="tile-label">Billing address</div>
              <div className="small">{d.billing_address}</div>
            </div>
          )}
        </div>

        <table>
          <thead><tr><th>Description</th><th>Type</th><th className="num">Quantity</th>
            <th className="num">Rate</th><th className="num">Total</th></tr></thead>
          <tbody>
            {(d.lines ?? []).map((l: any) => (
              <tr key={l.lineId}>
                <td>{l.description}</td>
                <td>{l.type === 'OVERTIME'
                  ? <span className="pill pill-amber">Overtime</span>
                  : l.type === 'CREDIT' ? <span className="pill pill-red">Credit</span>
                  : <span className="muted small">Standard</span>}</td>
                <td className="num">{hours(l.quantity)}</td>
                <td className="num">{money(l.unitRate)}</td>
                <td className="num">{money(l.lineTotal)}</td>
              </tr>
            ))}
          </tbody>
          <tbody style={{ borderTop: '2px solid var(--line)' }}>
            <tr><td colSpan={4} className="right"><strong>Subtotal</strong></td>
              <td className="num"><strong>{money(d.subtotal)}</strong></td></tr>
            <tr><td colSpan={4} className="right">VAT ({d.vat_rate}%)</td>
              <td className="num">{money(d.vat_amount)}</td></tr>
            <tr><td colSpan={4} className="right"><strong>Total</strong></td>
              <td className="num"><strong>{money(d.total)}</strong></td></tr>
            {Number(d.amount_paid) > 0 && (
              <tr><td colSpan={4} className="right">Paid</td>
                <td className="num">{money(d.amount_paid)}</td></tr>
            )}
          </tbody>
        </table>

        {issued && (
          <div className="card-body">
            <Alert kind="info">
              This invoice has been issued and can no longer be amended. A correction
              is made by raising a credit note and issuing a replacement.
            </Alert>
          </div>
        )}
      </Card>
    </>
  );
}
