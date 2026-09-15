import { useState } from 'react';
import { api, useAuth, useLoad, useFormError, Card, Loading, Alert, Empty, Field, Modal, date } from '../lib';

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
  const [f, setF] = useState({
    legalName: '', tradingName: '', registrationNumber: '', vatNumber: '',
    industry: '', billingAddress: '', paymentTermsDays: '30',
  });
  const set = (k: string, v: string) => setF((p) => ({ ...p, [k]: v }));

  async function save() {
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
    } catch (e) { err.capture(e); } finally { setBusy(false); }
  }

  return (
    <Modal title="Add a client company" onClose={onClose}
      footer={<>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" onClick={save} disabled={busy}>
          {busy ? 'Saving…' : 'Add client'}
        </button>
      </>}>
      {err.error && <Alert kind="error">{err.error}</Alert>}
      <Field label="Registered name" required error={err.fieldError('legalName')}>
        <input value={f.legalName} onChange={(e) => set('legalName', e.target.value)} />
      </Field>
      <div className="form-row">
        <Field label="Trading name"><input value={f.tradingName} onChange={(e) => set('tradingName', e.target.value)} /></Field>
        <Field label="Industry"><input value={f.industry} onChange={(e) => set('industry', e.target.value)} /></Field>
      </div>
      <div className="form-row">
        <Field label="Registration number">
          <input value={f.registrationNumber} onChange={(e) => set('registrationNumber', e.target.value)} />
        </Field>
        <Field label="VAT number" hint="Leave blank if not VAT registered">
          <input value={f.vatNumber} onChange={(e) => set('vatNumber', e.target.value)} />
        </Field>
      </div>
      <Field label="Billing address">
        <textarea value={f.billingAddress} onChange={(e) => set('billingAddress', e.target.value)} />
      </Field>
      <Field label="Payment terms (days)" required>
        <input type="number" min={0} max={180} value={f.paymentTermsDays}
          onChange={(e) => set('paymentTermsDays', e.target.value)} />
      </Field>
    </Modal>
  );
}
