import { useState } from 'react';
import { api, useAuth, useLoad, useFormError, Card, Loading, Alert, Empty, Field, Modal, date } from '../lib';
import { useForm, required, minLength, maxLength, integer, min, max } from '../validation';

/** Client companies and their contacts (UC-06). */
export default function Clients() {
  const { can } = useAuth();
  const [search, setSearch] = useState('');
  const [adding, setAdding] = useState(false);
  const list = useLoad<any>(() => api.get(`/clients${search ? `?search=${encodeURIComponent(search)}` : ''}`), [search]);

  return (
    <>
      <Card title="Client companies"
        subtitle={list.data ? `${list.data.items.length} companies` : undefined}
        action={can('manage_clients') && (
          <button className="btn btn-primary btn-sm" onClick={() => setAdding(true)}>Add client</button>
        )}>
        <div className="filters">
          <Field label="Search">
            <input placeholder="Company name" value={search} onChange={(e) => setSearch(e.target.value)} />
          </Field>
        </div>

        {list.loading ? <Loading />
          : list.error ? <Alert kind="error">{list.error}</Alert>
          : !list.data?.items.length ? <Empty message="No client companies yet." />
          : (
            <table>
              <thead>
                <tr>
                  <th>Company</th><th>Primary contact</th><th>Terms</th>
                  <th className="num">Active placements</th><th className="num">Open requests</th>
                </tr>
              </thead>
              <tbody>
                {list.data.items.map((c: any) => {
                  const primary = (c.contacts ?? []).find((x: any) => x.isPrimary) ?? c.contacts?.[0];
                  return (
                    <tr key={c.client_id}>
                      <td>
                        <strong>{c.legal_name}</strong>
                        <div className="person-role">
                          {c.industry ?? '—'}{c.registration_number ? ` · ${c.registration_number}` : ''}
                        </div>
                      </td>
                      <td>
                        {primary ? (
                          <>
                            <div>{primary.firstName} {primary.lastName}</div>
                            <div className="person-role">{primary.jobTitle ?? primary.email}</div>
                          </>
                        ) : <span className="muted">—</span>}
                      </td>
                      <td>{c.payment_terms_days} days</td>
                      <td className="num">{c.active_placements}</td>
                      <td className="num">
                        {c.open_requests > 0
                          ? <span className="pill pill-amber">{c.open_requests}</span>
                          : <span className="muted">0</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
      </Card>

      {adding && <AddClient onClose={() => setAdding(false)}
        onSaved={() => { setAdding(false); list.reload(); }} />}
    </>
  );
}

function AddClient({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const err = useFormError();
  const [busy, setBusy] = useState(false);

  const form = useForm(
    {
      legalName: '', tradingName: '', registrationNumber: '', vatNumber: '',
      industry: '', billingAddress: '', paymentTermsDays: '30',
    },
    {
      legalName: [required('A registered name'), minLength(2, 'The name'), maxLength(200, 'The name')],
      tradingName: [maxLength(200, 'The trading name')],
      // South African company registration numbers take the form 2025/123456/07
      registrationNumber: [(v) => (v && !/^\d{4}\/\d{6}\/\d{2}$/.test(String(v).trim())
        ? 'Use the form 2025/123456/07' : undefined)],
      // a VAT number is ten digits and starts with a 4
      vatNumber: [(v) => (v && !/^4\d{9}$/.test(String(v).replace(/\s/g, ''))
        ? 'A VAT number is ten digits beginning with 4' : undefined)],
      paymentTermsDays: [
        required('Payment terms'), integer('Payment terms'),
        min(0, 'Payment terms'), max(180, 'Payment terms'),
      ],
    },
  );

  const f = form.values;

  async function save() {
    if (!form.attemptSubmit()) return;
    setBusy(true); err.clear();
    try {
      await api.post('/clients', {
        legalName: f.legalName,
        tradingName: f.tradingName || undefined,
        registrationNumber: f.registrationNumber || undefined,
        vatNumber: f.vatNumber || undefined,
        industry: f.industry || undefined,
        billingAddress: f.billingAddress || undefined,
        paymentTermsDays: Number(f.paymentTermsDays),
      });
      onSaved();
    } catch (e) {
      err.capture(e);
      form.applyServerErrors((e as any)?.detail);
    } finally { setBusy(false); }
  }

  return (
    <Modal title="Add a client company" onClose={onClose}
      footer={<>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" onClick={save}
          disabled={busy || (form.submitted && !form.isValid)}>
          {busy ? 'Saving…' : 'Add client'}
        </button>
      </>}>
      {err.error && <Alert kind="error">{err.error}</Alert>}

      <Field label="Registered name" required error={form.errorFor('legalName')}>
        <input {...form.fieldProps('legalName')} />
      </Field>

      <div className="form-row">
        <Field label="Trading name" error={form.errorFor('tradingName')}>
          <input {...form.fieldProps('tradingName')} />
        </Field>
        <Field label="Industry">
          <input {...form.fieldProps('industry')} />
        </Field>
      </div>

      <div className="form-row">
        <Field label="Registration number" error={form.errorFor('registrationNumber')}
          hint="2025/123456/07">
          <input {...form.fieldProps('registrationNumber')} />
        </Field>
        <Field label="VAT number" error={form.errorFor('vatNumber')}
          hint="Leave blank if not VAT registered">
          <input {...form.fieldProps('vatNumber')} />
        </Field>
      </div>

      <Field label="Billing address">
        <textarea {...form.fieldProps('billingAddress')} />
      </Field>

      <Field label="Payment terms (days)" required error={form.errorFor('paymentTermsDays')}
        hint="How long the client has to pay an invoice">
        <input type="number" min={0} max={180} {...form.fieldProps('paymentTermsDays')} />
      </Field>
    </Modal>
  );
}
