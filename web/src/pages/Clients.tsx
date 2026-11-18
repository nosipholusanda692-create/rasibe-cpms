import { useState } from 'react';
import { api, useAuth, useLoad, useFormError, Card, Loading, Alert, Empty, Field, Modal, date } from '../lib';
import { useForm, required, minLength, maxLength, integer, min, max, email, phone } from '../validation';

/** Client companies and their contacts (UC-06). */
export default function Clients() {
  const { can } = useAuth();
  const [search, setSearch] = useState('');
  const [adding, setAdding] = useState(false);
  const [contactsFor, setContactsFor] = useState<string | null>(null);
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
                  {can('manage_clients') && <th />}
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
                      {can('manage_clients') && (
                        <td className="right">
                          <button className="btn btn-sm" onClick={() => setContactsFor(c.client_id)}>
                            Contacts ({(c.contacts ?? []).length})
                          </button>
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
      </Card>

      {adding && <AddClient onClose={() => setAdding(false)}
        onSaved={() => { setAdding(false); list.reload(); }} />}

      {contactsFor && list.data?.items.find((c: any) => c.client_id === contactsFor) && (
        <Contacts client={list.data.items.find((c: any) => c.client_id === contactsFor)}
          onClose={() => setContactsFor(null)} onChanged={list.reload} />
      )}
    </>
  );
}

/**
 * The people at a client company, and a form to add one.
 *
 * A client-manager account is linked to a contact (the user form offers the
 * contacts that have no account yet), so a company with no contact cannot be
 * given a login. Contacts are listed from the company list, so a new one shows
 * as soon as the list reloads.
 */
function Contacts({ client, onClose, onChanged }: { client: any; onClose: () => void; onChanged: () => void }) {
  const err = useFormError();
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const contacts: any[] = client.contacts ?? [];

  const form = useForm(
    { firstName: '', lastName: '', jobTitle: '', email: '', phone: '' },
    {
      firstName: [required('A first name'), maxLength(100, 'The first name')],
      lastName: [required('A last name'), maxLength(100, 'The last name')],
      jobTitle: [maxLength(120, 'The job title')],
      email: [required('An email address'), email, maxLength(255, 'The email address')],
      phone: [phone],
    },
  );
  const f = form.values;
  const [approver, setApprover] = useState(false);
  const [primary, setPrimary] = useState(false);

  function open() { form.reset(); setApprover(false); setPrimary(false); err.clear(); setAdding(true); }

  async function save() {
    if (!form.attemptSubmit()) return;
    setBusy(true); err.clear();
    try {
      await api.post(`/clients/${client.client_id}/contacts`, {
        firstName: f.firstName.trim(),
        lastName: f.lastName.trim(),
        jobTitle: f.jobTitle.trim() || undefined,
        email: f.email.trim(),
        phone: f.phone.trim() || undefined,
        isTimesheetApprover: approver,
        isPrimary: primary,
      });
      setSaved(`${f.firstName.trim()} ${f.lastName.trim()} added.`);
      setAdding(false);
      onChanged();
    } catch (e) {
      err.capture(e);
      form.applyServerErrors((e as any)?.detail);
    } finally { setBusy(false); }
  }

  return (
    <Modal title={`Contacts at ${client.legal_name}`} onClose={onClose}
      footer={adding
        ? <>
            <button className="btn" onClick={() => { setAdding(false); err.clear(); }}>Cancel</button>
            <button className="btn btn-primary" onClick={save} disabled={busy || (form.submitted && !form.isValid)}>
              {busy ? 'Saving…' : 'Add contact'}
            </button>
          </>
        : <>
            <button className="btn" onClick={onClose}>Close</button>
            <button className="btn btn-primary" onClick={open}>Add contact</button>
          </>}>
      {saved && !adding && <Alert kind="success">{saved}</Alert>}

      {!adding && (
        contacts.length === 0
          ? <Empty message="No contacts yet. Add one so a client manager account can be created for this company." />
          : (
            <table>
              <thead><tr><th>Name</th><th>Email</th><th>Phone</th><th /></tr></thead>
              <tbody>
                {contacts.map((x) => (
                  <tr key={x.contactId}>
                    <td>
                      <strong>{x.firstName} {x.lastName}</strong>
                      <div className="person-role">{x.jobTitle ?? '—'}</div>
                    </td>
                    <td>{x.email}</td>
                    <td>{x.phone ?? <span className="muted">—</span>}</td>
                    <td>
                      {x.isPrimary && <span className="pill pill-blue">Primary</span>}{' '}
                      {x.isApprover && <span className="pill pill-green">Approves timesheets</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
      )}

      {adding && (
        <>
          {err.error && <Alert kind="error">{err.error}</Alert>}
          <div className="form-row">
            <Field label="First name" required error={form.errorFor('firstName')}>
              <input {...form.fieldProps('firstName')} />
            </Field>
            <Field label="Last name" required error={form.errorFor('lastName')}>
              <input {...form.fieldProps('lastName')} />
            </Field>
          </div>
          <Field label="Job title" error={form.errorFor('jobTitle')}>
            <input {...form.fieldProps('jobTitle')} />
          </Field>
          <div className="form-row">
            <Field label="Email" required error={form.errorFor('email')}>
              <input type="email" {...form.fieldProps('email')} />
            </Field>
            <Field label="Phone" error={form.errorFor('phone')}>
              <input {...form.fieldProps('phone')} />
            </Field>
          </div>
          <label className="small" style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
            <input type="checkbox" checked={approver}
              onChange={(e) => setApprover(e.target.checked)} />
            Approves this company's timesheets
          </label>
          <label className="small" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input type="checkbox" checked={primary}
              onChange={(e) => setPrimary(e.target.checked)} />
            Primary contact (replaces the current one)
          </label>
        </>
      )}
    </Modal>
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
