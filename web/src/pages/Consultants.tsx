import { useState } from 'react';
import { Link, useParams, useNavigate } from 'react-router-dom';
import {
  api, useAuth, useLoad, useFormError, Card, Status, Loading, Alert, Empty, Person,
  Field, Modal, ReasonModal, money, date, titleCase,
} from '../lib';
import {
  useForm, required, minLength, maxLength, email as emailRule, phone,
  number, min, max, integer,
} from '../validation';

// =====================================================================
// Consultant search (UC-05) — also serves the skills view
// =====================================================================
export default function Consultants({ skillsView }: { skillsView?: boolean }) {
  const { user, can } = useAuth();
  const [search, setSearch] = useState('');
  const [skill, setSkill] = useState('');
  const [seniority, setSeniority] = useState('');
  const [availability, setAvailability] = useState('');
  const [availableFrom, setAvailableFrom] = useState('');
  const [adding, setAdding] = useState(false);

  const skills = useLoad<any>(() => api.get('/skills'));

  const qs = new URLSearchParams();
  if (search) qs.set('search', search);
  if (skill) qs.set('skill', skill);
  if (seniority) qs.set('seniority', seniority);
  if (availability) qs.set('availability', availability);
  if (availableFrom) qs.set('availableFrom', availableFrom);

  const list = useLoad<any>(
    () => api.get(`/consultants?${qs.toString()}`),
    [search, skill, seniority, availability, availableFrom],
  );

  if (skillsView) {
    return <SkillsTaxonomy />;
  }

  const isClientManager = user?.role === 'CLIENT_MANAGER';

  return (
    <>
      {isClientManager && (
        <Alert kind="info">
          You see the professional profile of consultants working with your company.
          Identity numbers, rates and personal contact details are not shown.
        </Alert>
      )}

      <Card
        title="Consultant pool"
        subtitle={list.data ? `${list.data.total ?? list.data.items.length} consultants` : undefined}
        action={can('manage_consultants') && (
          <button className="btn btn-primary btn-sm" onClick={() => setAdding(true)}>
            Add consultant
          </button>
        )}
      >
        {!isClientManager && (
          <div className="filters">
            <Field label="Search">
              <input type="text" placeholder="Name, headline or email"
                value={search} onChange={(e) => setSearch(e.target.value)} />
            </Field>
            <Field label="Skill">
              <select value={skill} onChange={(e) => setSkill(e.target.value)}>
                <option value="">Any skill</option>
                {skills.data?.items.map((s: any) => (
                  <option key={s.skill_id} value={s.skill_id}>{s.name}</option>
                ))}
              </select>
            </Field>
            <Field label="Seniority">
              <select value={seniority} onChange={(e) => setSeniority(e.target.value)}>
                <option value="">Any</option>
                {['JUNIOR', 'INTERMEDIATE', 'SENIOR', 'LEAD', 'PRINCIPAL'].map((s) => (
                  <option key={s} value={s}>{titleCase(s)}</option>
                ))}
              </select>
            </Field>
            <Field label="Availability">
              <select value={availability} onChange={(e) => setAvailability(e.target.value)}>
                <option value="">Any</option>
                <option value="AVAILABLE">Available now</option>
                <option value="AVAILABLE_FROM">Available from a date</option>
                <option value="ON_PLACEMENT">On placement</option>
              </select>
            </Field>
            {/* added at the client's request during the mock-up review (FB-04) */}
            <Field label="Available by">
              <input type="date" value={availableFrom} onChange={(e) => setAvailableFrom(e.target.value)} />
            </Field>
            <button className="btn btn-sm" onClick={() => {
              setSearch(''); setSkill(''); setSeniority(''); setAvailability(''); setAvailableFrom('');
            }}>Clear</button>
          </div>
        )}

        {list.loading ? <Loading />
          : list.error ? <Alert kind="error">{list.error}</Alert>
          : !list.data?.items.length ? (
            <Empty message="No consultant matches those criteria. Try relaxing the most restrictive one." />
          ) : isClientManager ? (
            <table>
              <thead><tr><th>Profile</th><th>Seniority</th><th>Experience</th><th>Availability</th></tr></thead>
              <tbody>
                {list.data.items.map((c: any) => (
                  <tr key={c.consultant_id}>
                    <td>
                      <div className="person-name">{c.preferred_name ?? 'Consultant'}</div>
                      <div className="person-role">{c.headline}</div>
                    </td>
                    <td>{titleCase(c.seniority)}</td>
                    <td>{c.experience_years ? `${c.experience_years} years` : '—'}</td>
                    <td><Status value={c.availability} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Consultant</th><th>Top skills</th><th>Seniority</th>
                  <th>Availability</th><th className="num">Pay rate</th>
                </tr>
              </thead>
              <tbody>
                {list.data.items.map((c: any) => (
                  <tr key={c.consultant_id} className="clickable">
                    <td>
                      <Link to={`/consultants/${c.consultant_id}`} style={{ color: 'inherit' }}>
                        <Person name={c.full_name} sub={c.location ?? c.headline} />
                      </Link>
                    </td>
                    <td>
                      <div className="row" style={{ flexWrap: 'wrap', gap: 5 }}>
                        {(c.skills ?? []).slice(0, 3).map((s: any) => (
                          <span key={s.skillId} className="pill pill-grey">{s.name}</span>
                        ))}
                      </div>
                    </td>
                    <td>{titleCase(c.seniority)}</td>
                    <td>
                      <Status value={c.availability} />
                      {c.available_from && (
                        <div className="person-role">from {date(c.available_from)}</div>
                      )}
                    </td>
                    <td className="num">{money(c.min_pay_rate)}<span className="muted small"> /hr</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
      </Card>

      {adding && <AddConsultant onClose={() => setAdding(false)} onSaved={() => { setAdding(false); list.reload(); }} />}
    </>
  );
}

function AddConsultant({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const err = useFormError();
  const [busy, setBusy] = useState(false);

  const form = useForm(
    {
      fullName: '', email: '', mobile: '', location: '',
      seniority: 'INTERMEDIATE', headline: '', experienceYears: '',
      availability: 'AVAILABLE', availableFrom: '', minPayRate: '',
    },
    {
      fullName: [required('A full name'), minLength(2, 'The name'), maxLength(200, 'The name')],
      email: [required('An email address'), emailRule],
      mobile: [phone],
      headline: [maxLength(300, 'The headline')],
      experienceYears: [integer('Experience'), min(0, 'Experience'), max(60, 'Experience')],
      // the date is only required when the availability says there will be one
      availableFrom: [(v, f) => (f.availability === 'AVAILABLE_FROM' && !v
        ? 'Give the date the consultant becomes available' : undefined)],
      minPayRate: [number('The minimum rate'), min(0, 'The minimum rate')],
    },
  );

  const f = form.values;

  async function save() {
    if (!form.attemptSubmit()) return;
    setBusy(true); err.clear();
    try {
      await api.post('/consultants', {
        fullName: f.fullName,
        email: f.email,
        mobile: f.mobile || undefined,
        location: f.location || undefined,
        seniority: f.seniority,
        headline: f.headline || undefined,
        experienceYears: f.experienceYears ? Number(f.experienceYears) : undefined,
        availability: f.availability,
        availableFrom: f.availableFrom || undefined,
        minPayRate: f.minPayRate ? Number(f.minPayRate) : undefined,
      });
      onSaved();
    } catch (e) {
      err.capture(e);
      form.applyServerErrors((e as any)?.detail);
    } finally { setBusy(false); }
  }

  return (
    <Modal title="Add a consultant to the pool" onClose={onClose}
      footer={<>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" onClick={save}
          disabled={busy || (form.submitted && !form.isValid)}>
          {busy ? 'Saving…' : 'Add consultant'}
        </button>
      </>}>
      {err.error && <Alert kind="error">{err.error}</Alert>}

      <div className="form-row">
        <Field label="Full name" required error={form.errorFor('fullName')}>
          <input {...form.fieldProps('fullName')} />
        </Field>
        <Field label="Email address" required error={form.errorFor('email')}>
          <input type="email" {...form.fieldProps('email')} />
        </Field>
      </div>

      <div className="form-row">
        <Field label="Mobile" error={form.errorFor('mobile')}>
          <input {...form.fieldProps('mobile')} placeholder="+27 82 000 0000" />
        </Field>
        <Field label="Location">
          <input {...form.fieldProps('location')} />
        </Field>
      </div>

      <Field label="Headline" error={form.errorFor('headline')}
        hint="One line describing what they do">
        <input {...form.fieldProps('headline')} />
      </Field>

      <div className="form-row">
        <Field label="Seniority">
          <select {...form.fieldProps('seniority')}>
            {['JUNIOR', 'INTERMEDIATE', 'SENIOR', 'LEAD', 'PRINCIPAL'].map((s) => (
              <option key={s} value={s}>{titleCase(s)}</option>
            ))}
          </select>
        </Field>
        <Field label="Years of experience" error={form.errorFor('experienceYears')}>
          <input type="number" min={0} max={60} {...form.fieldProps('experienceYears')} />
        </Field>
      </div>

      <div className="form-row">
        <Field label="Availability">
          <select {...form.fieldProps('availability')}>
            <option value="AVAILABLE">Available now</option>
            <option value="AVAILABLE_FROM">Available from</option>
            <option value="NOT_AVAILABLE">Not available</option>
          </select>
        </Field>
        {f.availability === 'AVAILABLE_FROM' ? (
          <Field label="Available from" required error={form.errorFor('availableFrom')}>
            <input type="date" {...form.fieldProps('availableFrom')} />
          </Field>
        ) : (
          <Field label="Minimum pay rate" error={form.errorFor('minPayRate')}
            hint="Per hour, never shown to a client">
            <input type="number" min={0} step="0.01" {...form.fieldProps('minPayRate')} />
          </Field>
        )}
      </div>

      <Alert kind="info">
        Consent to disclose this consultant to a client is recorded separately,
        and is required before they can be submitted (BR-012).
      </Alert>
    </Modal>
  );
}

// =====================================================================
// Consultant profile (prototype screen H7)
// =====================================================================
export function ConsultantProfileInner({ id }: { id: string }) {
  const { user, can } = useAuth();
  const [tab, setTab] = useState('professional');
  const c = useLoad<any>(() => api.get(`/consultants/${id}`), [id]);
  const [msg, setMsg] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [deactivating, setDeactivating] = useState(false);

  if (c.loading) return <Loading />;
  if (c.error) return <Alert kind="error">{c.error}</Alert>;
  const d = c.data;
  const isAdmin = user?.role === 'ADMINISTRATOR';

  async function recordConsent() {
    try {
      await api.post(`/consultants/${id}/consent`, { reason: 'Consent recorded in the system' });
      setMsg('Consent recorded. This consultant may now be submitted to clients.');
      c.reload();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Could not record consent');
    }
  }

  // FR-CON-013. A consultant is deactivated, never deleted: the placements,
  // timesheets and invoices behind them are financial records.
  async function deactivate(reason: string) {
    await api.post(`/consultants/${id}/deactivate`, { reason });
    setDeactivating(false);
    setMsg('Consultant deactivated. They can no longer be submitted to a client.');
    c.reload();
  }

  const tabs = [
    { key: 'professional', label: 'Professional' },
    { key: 'skills', label: 'Skills & certifications' },
    ...(isAdmin ? [{ key: 'rates', label: 'Rates', restricted: true }] : []),
    { key: 'documents', label: 'Documents' },
    ...(isAdmin ? [{ key: 'vetting', label: 'Vetting', restricted: true }] : []),
    { key: 'placements', label: 'Placements' },
  ];

  return (
    <>
      {msg && <Alert kind="success">{msg}</Alert>}

      <Card>
        <div className="card-body">
          <div className="row">
            <Person name={d.full_name ?? d.preferred_name ?? 'Consultant'}
              sub={`${d.headline ?? ''}`} />
            <div className="spacer" />
            <div className="row">
              <div className="stack">
                <span className="tile-label">Availability</span>
                <span><Status value={d.availability} />
                  {d.available_from && <span className="muted small"> from {date(d.available_from)}</span>}
                </span>
              </div>
              {!d.consent_recorded_at && can('manage_consultants') && (
                <button className="btn btn-primary btn-sm" onClick={recordConsent}>
                  Record consent
                </button>
              )}
              {can('manage_consultants') && (
                <button className="btn btn-sm" onClick={() => setEditing(true)}>Edit</button>
              )}
              {can('manage_consultants') && d.is_active !== false && (
                <button className="btn btn-sm btn-danger" onClick={() => setDeactivating(true)}>
                  Deactivate
                </button>
              )}
              {d.is_active === false && <span className="pill pill-red">Deactivated</span>}
            </div>
          </div>
        </div>

        <div className="tabs">
          {tabs.map((t) => (
            <button key={t.key} className={`tab${tab === t.key ? ' active' : ''}`}
              onClick={() => setTab(t.key)}>
              {t.label}{(t as any).restricted && <span className="restricted">ADMIN</span>}
            </button>
          ))}
        </div>

        <div className="card-body">
          {tab === 'professional' && (
            <dl className="def-list">
              <div><dt>Full name</dt><dd>{d.full_name ?? '—'}</dd></div>
              <div><dt>Preferred name</dt><dd>{d.preferred_name ?? '—'}</dd></div>
              <div><dt>Seniority</dt><dd>{titleCase(d.seniority)}</dd></div>
              <div><dt>Experience</dt><dd>{d.experience_years ? `${d.experience_years} years` : '—'}</dd></div>
              <div><dt>Location</dt><dd>{d.location ?? '—'}</dd></div>
              <div><dt>Nationality</dt><dd>{d.nationality ?? '—'}</dd></div>
              <div><dt>Right to work</dt><dd>{d.right_to_work ?? '—'}</dd></div>
              <div><dt>Email</dt><dd>{d.email ?? '—'}</dd></div>
              <div><dt>Mobile</dt><dd>{d.mobile ?? '—'}</dd></div>
              {isAdmin && (
                <div>
                  <dt>Identity number</dt>
                  <dd>
                    {d.id_number ?? '—'}
                    <div className="restricted-note">Administrator only · access logged</div>
                  </dd>
                </div>
              )}
              <div>
                <dt>Consent to disclosure</dt>
                <dd>{d.consent_recorded_at ? date(d.consent_recorded_at)
                  : <span className="pill pill-red">Not recorded</span>}</dd>
              </div>
              <div><dt>Retention expires</dt><dd>{date(d.retention_expires_on)}</dd></div>
            </dl>
          )}

          {tab === 'skills' && (
            <>
              <table>
                <thead><tr><th>Skill</th><th>Proficiency</th>
                  <th className="num">Years</th><th className="num">Last used</th></tr></thead>
                <tbody>
                  {(d.skills ?? []).map((s: any) => (
                    <tr key={s.skillId}>
                      <td><strong>{s.name}</strong>{s.isPrimary && <span className="pill pill-blue" style={{ marginLeft: 8 }}>Primary</span>}</td>
                      <td>{titleCase(s.proficiency)}</td>
                      <td className="num">{s.years ?? '—'}</td>
                      <td className="num">{s.lastUsedYear ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {(d.certifications ?? []).length > 0 && (
                <>
                  <h3 style={{ fontSize: 13, marginTop: 22 }}>Certifications</h3>
                  <table>
                    <thead><tr><th>Certification</th><th>Issued by</th><th>Expires</th><th>Status</th></tr></thead>
                    <tbody>
                      {d.certifications.map((ce: any) => {
                        const expired = ce.expiresOn && new Date(ce.expiresOn) < new Date();
                        return (
                          <tr key={ce.certificationId}>
                            <td>{ce.name}</td>
                            <td className="muted">{ce.issuingBody ?? '—'}</td>
                            <td className="mono">{date(ce.expiresOn)}</td>
                            <td><span className={`pill pill-${expired ? 'red' : 'green'}`}>
                              {expired ? 'Expired' : 'Valid'}</span></td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </>
              )}
            </>
          )}

          {tab === 'rates' && isAdmin && (
            <>
              <dl className="def-list">
                <div><dt>Minimum pay rate</dt><dd>{money(d.min_pay_rate)} / hr</dd></div>
                <div><dt>Preferred pay rate</dt><dd>{money(d.preferred_pay_rate)} / hr</dd></div>
                <div><dt>Rate unit</dt><dd>{titleCase(d.rate_unit)}</dd></div>
              </dl>
              <Alert kind="info">
                The bill rate and the margin are held on the placement, never on the consultant.
                They are not shown here and are never sent to a consultant's device.
              </Alert>
            </>
          )}

          {tab === 'documents' && (
            !(d.documents ?? []).length ? <Empty message="No documents on file." /> : (
              <table>
                <thead><tr><th>Document</th><th>Type</th><th>Version</th><th>Expires</th><th>Access</th></tr></thead>
                <tbody>
                  {d.documents.map((doc: any) => (
                    <tr key={doc.documentId}>
                      <td>{doc.fileName}</td>
                      <td>{titleCase(doc.type)}</td>
                      <td className="num">v{doc.version}</td>
                      <td className="mono">{date(doc.expiresOn)}</td>
                      <td>{doc.isRestricted
                        ? <span className="pill pill-amber">Restricted</span>
                        : <span className="muted small">Standard</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )
          )}

          {tab === 'vetting' && isAdmin && (
            <dl className="def-list">
              <div><dt>Vetting status</dt><dd>{d.vetting_status ?? '—'}</dd></div>
              <div><dt>Cleared on</dt><dd>{date(d.vetting_cleared_on)}</dd></div>
              <div>
                <dt>Banking</dt>
                <dd>{d.bank_name ? `${d.bank_name} · ${d.bank_account_ref}` : '—'}
                  <div className="restricted-note">Administrator only · access logged</div></dd>
              </div>
            </dl>
          )}

          {tab === 'placements' && (
            !(d.placements ?? []).length ? <Empty message="No placement history." /> : (
              <table>
                <thead><tr><th>Reference</th><th>Client</th><th>Role</th><th>Period</th><th>Status</th></tr></thead>
                <tbody>
                  {d.placements.map((p: any) => (
                    <tr key={p.placementId}>
                      <td className="mono">{p.reference}</td>
                      <td>{p.clientName}</td>
                      <td>{p.jobTitle}</td>
                      <td className="mono small">{date(p.startDate)} – {date(p.endDate)}</td>
                      <td><Status value={p.status} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )
          )}
        </div>
      </Card>

      {editing && (
        <EditConsultant
          consultant={d}
          onClose={() => setEditing(false)}
          onSaved={() => { setEditing(false); setMsg('Consultant updated.'); c.reload(); }} />
      )}

      {deactivating && (
        <ReasonModal
          title={`Deactivate ${d.full_name ?? 'this consultant'}`}
          intent="They will no longer appear in search results and cannot be submitted to a client. Existing placements, timesheets and invoices are unaffected, because those are financial records."
          confirmLabel="Deactivate"
          danger
          onClose={() => setDeactivating(false)}
          onConfirm={deactivate} />
      )}
    </>
  );
}

/**
 * FR-CFG-005 — the skills taxonomy.
 *
 * This is the vocabulary everything else matches on, so it is maintained
 * deliberately rather than growing by free text on each consultant record.
 */
function SkillsTaxonomy() {
  const { can } = useAuth();
  const [search, setSearch] = useState('');
  const [showRetired, setShowRetired] = useState(false);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<any | null>(null);
  const [retiring, setRetiring] = useState<any | null>(null);
  const [msg, setMsg] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);

  // The server hides retired skills unless asked, so a retired one can be
  // listed here and restored.
  const list = useLoad<any>(
    () => {
      const qs = new URLSearchParams();
      if (search) qs.set('search', search);
      if (showRetired) qs.set('includeRetired', 'true');
      const text = qs.toString();
      return api.get(`/skills${text ? `?${text}` : ''}`);
    },
    [search, showRetired],
  );

  const items = (list.data?.items ?? []).filter(
    (s: any) => showRetired || s.is_active !== false,
  );
  const categories = [...new Set(items.map((s: any) => s.category ?? 'Uncategorised'))].sort();

  async function retire(skill: any) {
    try {
      const r = await api.post<any>(`/skills/${skill.skill_id}/retire`, {});
      setRetiring(null);
      setMsg({
        kind: 'success',
        text: r.consultant_count > 0
          ? `${r.name} retired. It stays on the ${r.consultant_count} consultant record(s) that already carry it.`
          : `${r.name} retired.`,
      });
      list.reload();
    } catch (e) {
      setMsg({ kind: 'error', text: e instanceof Error ? e.message : 'Could not retire that skill' });
    }
  }

  async function restore(skill: any) {
    try {
      await api.patch(`/skills/${skill.skill_id}`, { isActive: true });
      setMsg({ kind: 'success', text: `${skill.name} is available for matching again.` });
      list.reload();
    } catch (e) {
      setMsg({ kind: 'error', text: e instanceof Error ? e.message : 'Could not restore that skill' });
    }
  }

  return (
    <>
      {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}

      <Card title="Skills"
        subtitle={list.data ? `${items.length} skills across ${categories.length} categories` : undefined}
        action={can('manage_catalogue') && (
          <button className="btn btn-primary btn-sm" onClick={() => setAdding(true)}>Add skill</button>
        )}>
        <div className="filters">
          <Field label="Search">
            <input placeholder="Skill name" value={search}
              onChange={(e) => setSearch(e.target.value)} />
          </Field>
          <Field label="Retired skills">
            <select value={showRetired ? 'yes' : 'no'}
              onChange={(e) => setShowRetired(e.target.value === 'yes')}>
              <option value="no">Hide retired</option>
              <option value="yes">Show retired</option>
            </select>
          </Field>
        </div>

        {list.loading ? <Loading />
          : list.error ? <Alert kind="error">{list.error}</Alert>
          : !items.length ? <Empty message="No skills match." />
          : (
            <table>
              <thead>
                <tr>
                  <th>Skill</th><th>Category</th>
                  <th className="num">Consultants</th><th>Status</th>
                  {can('manage_catalogue') && <th className="right">Actions</th>}
                </tr>
              </thead>
              <tbody>
                {items.map((sk: any) => (
                  <tr key={sk.skill_id}>
                    <td><strong>{sk.name}</strong></td>
                    <td className="muted">{sk.category ?? '—'}</td>
                    <td className="num">{sk.consultant_count}</td>
                    <td>
                      {sk.is_active === false
                        ? <span className="pill pill-grey">Retired</span>
                        : <span className="pill pill-green">In use</span>}
                    </td>
                    {can('manage_catalogue') && (
                      <td className="right">
                        <div className="btn-row" style={{ justifyContent: 'flex-end' }}>
                          <button className="btn btn-sm" onClick={() => setEditing(sk)}>Edit</button>
                          {sk.is_active === false
                            ? <button className="btn btn-sm" onClick={() => restore(sk)}>Restore</button>
                            : <button className="btn btn-sm btn-danger"
                                onClick={() => setRetiring(sk)}>Retire</button>}
                        </div>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
      </Card>

      {(adding || editing) && (
        <SkillForm
          skill={editing}
          onClose={() => { setAdding(false); setEditing(null); }}
          onSaved={(name) => {
            setAdding(false); setEditing(null);
            setMsg({ kind: 'success', text: `${name} saved.` });
            list.reload();
          }} />
      )}

      {retiring && (
        <Modal title={`Retire ${retiring.name}`} onClose={() => setRetiring(null)}
          footer={<>
            <button className="btn" onClick={() => setRetiring(null)}>Cancel</button>
            <button className="btn btn-danger" onClick={() => retire(retiring)}>Retire skill</button>
          </>}>
          <p className="small">
            {retiring.name} will stop appearing when a consultant or a role request is
            matched on skills.
          </p>
          {retiring.consultant_count > 0 && (
            <Alert kind="info">
              It stays on the {retiring.consultant_count} consultant record(s) that already
              carry it. The proficiency and years recorded against each were entered by
              hand, so retiring is preferred to deleting.
            </Alert>
          )}
        </Modal>
      )}
    </>
  );
}

function SkillForm({
  skill, onClose, onSaved,
}: { skill: any | null; onClose: () => void; onSaved: (name: string) => void }) {
  const err = useFormError();
  const [busy, setBusy] = useState(false);

  const form = useForm(
    { name: skill?.name ?? '', category: skill?.category ?? '' },
    {
      name: [required('A skill name'), minLength(2, 'The name'), maxLength(120, 'The name')],
      category: [maxLength(80, 'The category')],
    },
  );

  async function save() {
    if (!form.attemptSubmit()) return;
    setBusy(true); err.clear();
    try {
      if (skill) {
        await api.patch(`/skills/${skill.skill_id}`, {
          name: form.values.name,
          category: form.values.category || null,
        });
      } else {
        await api.post('/skills', {
          name: form.values.name,
          category: form.values.category || undefined,
        });
      }
      onSaved(form.values.name);
    } catch (e) {
      err.capture(e);
      form.applyServerErrors((e as any)?.detail);
    } finally { setBusy(false); }
  }

  return (
    <Modal title={skill ? `Edit ${skill.name}` : 'Add a skill'} onClose={onClose}
      footer={<>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" onClick={save}
          disabled={busy || (form.submitted && !form.isValid)}>
          {busy ? 'Saving…' : skill ? 'Save changes' : 'Add skill'}
        </button>
      </>}>
      {err.error && <Alert kind="error">{err.error}</Alert>}

      <Field label="Skill name" required error={form.errorFor('name')}
        hint="As a recruiter would search for it">
        <input {...form.fieldProps('name')} placeholder="Spring Boot" />
      </Field>

      <Field label="Category" error={form.errorFor('category')}
        hint="Groups the skill in the list. Development, Quality, Data, Infrastructure.">
        <input {...form.fieldProps('category')} />
      </Field>

      {skill && skill.consultant_count > 0 && (
        <Alert kind="info">
          {skill.consultant_count} consultant record(s) carry this skill. Renaming it
          changes it everywhere, which is the point: the taxonomy is one vocabulary.
        </Alert>
      )}
    </Modal>
  );
}

/** FR-CON-001 — amend a consultant record already in the pool. */
function EditConsultant({
  consultant, onClose, onSaved,
}: { consultant: any; onClose: () => void; onSaved: () => void }) {
  const { user } = useAuth();
  const err = useFormError();
  const [busy, setBusy] = useState(false);
  const isAdmin = user?.role === 'ADMINISTRATOR';

  const form = useForm(
    {
      fullName: consultant.full_name ?? '',
      preferredName: consultant.preferred_name ?? '',
      email: consultant.email ?? '',
      mobile: consultant.mobile ?? '',
      location: consultant.location ?? '',
      seniority: consultant.seniority ?? 'INTERMEDIATE',
      headline: consultant.headline ?? '',
      experienceYears: consultant.experience_years ?? '',
      availability: consultant.availability ?? 'AVAILABLE',
      availableFrom: consultant.available_from?.slice(0, 10) ?? '',
      minPayRate: consultant.min_pay_rate ?? '',
      preferredPayRate: consultant.preferred_pay_rate ?? '',
    },
    {
      fullName: [required('A full name'), minLength(2, 'The name'), maxLength(200, 'The name')],
      email: [required('An email address'), emailRule],
      mobile: [phone],
      headline: [maxLength(300, 'The headline')],
      experienceYears: [integer('Experience'), min(0, 'Experience'), max(60, 'Experience')],
      availableFrom: [(v, f) => (f.availability === 'AVAILABLE_FROM' && !v
        ? 'Give the date the consultant becomes available' : undefined)],
      minPayRate: [number('The minimum rate'), min(0, 'The minimum rate')],
      preferredPayRate: [number('The preferred rate'), min(0, 'The preferred rate')],
    },
  );

  const f = form.values;

  async function save() {
    if (!form.attemptSubmit()) return;
    setBusy(true); err.clear();
    try {
      await api.patch(`/consultants/${consultant.consultant_id}`, {
        fullName: f.fullName,
        preferredName: f.preferredName || undefined,
        email: f.email,
        mobile: f.mobile || undefined,
        location: f.location || undefined,
        seniority: f.seniority,
        headline: f.headline || undefined,
        experienceYears: f.experienceYears === '' ? undefined : Number(f.experienceYears),
        availability: f.availability,
        availableFrom: f.availability === 'AVAILABLE_FROM' ? f.availableFrom : null,
        // rates are the administrator's to set; a recruiter may not reprice
        ...(isAdmin ? {
          minPayRate: f.minPayRate === '' ? undefined : Number(f.minPayRate),
          preferredPayRate: f.preferredPayRate === '' ? undefined : Number(f.preferredPayRate),
        } : {}),
      });
      onSaved();
    } catch (e) {
      err.capture(e);
      form.applyServerErrors((e as any)?.detail);
    } finally { setBusy(false); }
  }

  return (
    <Modal title="Edit consultant" onClose={onClose}
      footer={<>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" onClick={save}
          disabled={busy || (form.submitted && !form.isValid)}>
          {busy ? 'Saving…' : 'Save changes'}
        </button>
      </>}>
      {err.error && <Alert kind="error">{err.error}</Alert>}

      <div className="form-row">
        <Field label="Full name" required error={form.errorFor('fullName')}>
          <input {...form.fieldProps('fullName')} />
        </Field>
        <Field label="Preferred name" hint="Shown to client companies instead of the full name">
          <input {...form.fieldProps('preferredName')} />
        </Field>
      </div>

      <div className="form-row">
        <Field label="Email address" required error={form.errorFor('email')}>
          <input type="email" {...form.fieldProps('email')} />
        </Field>
        <Field label="Mobile" error={form.errorFor('mobile')}>
          <input {...form.fieldProps('mobile')} />
        </Field>
      </div>

      <Field label="Headline" error={form.errorFor('headline')}>
        <input {...form.fieldProps('headline')} />
      </Field>

      <div className="form-row">
        <Field label="Location"><input {...form.fieldProps('location')} /></Field>
        <Field label="Seniority">
          <select {...form.fieldProps('seniority')}>
            {['JUNIOR', 'INTERMEDIATE', 'SENIOR', 'LEAD', 'PRINCIPAL'].map((x) => (
              <option key={x} value={x}>{titleCase(x)}</option>
            ))}
          </select>
        </Field>
      </div>

      <div className="form-row">
        <Field label="Years of experience" error={form.errorFor('experienceYears')}>
          <input type="number" min={0} max={60} {...form.fieldProps('experienceYears')} />
        </Field>
        <Field label="Availability">
          <select {...form.fieldProps('availability')}>
            <option value="AVAILABLE">Available now</option>
            <option value="AVAILABLE_FROM">Available from</option>
            <option value="ON_PLACEMENT">On placement</option>
            <option value="NOT_AVAILABLE">Not available</option>
          </select>
        </Field>
      </div>

      {f.availability === 'AVAILABLE_FROM' && (
        <Field label="Available from" required error={form.errorFor('availableFrom')}>
          <input type="date" {...form.fieldProps('availableFrom')} />
        </Field>
      )}

      {isAdmin && (
        <div className="form-row">
          <Field label="Minimum pay rate" error={form.errorFor('minPayRate')}
            hint="Never shown to a client">
            <input type="number" min={0} step="0.01" {...form.fieldProps('minPayRate')} />
          </Field>
          <Field label="Preferred pay rate" error={form.errorFor('preferredPayRate')}>
            <input type="number" min={0} step="0.01" {...form.fieldProps('preferredPayRate')} />
          </Field>
        </div>
      )}

      {f.availability === 'ON_PLACEMENT' && (
        <Alert kind="info">
          Availability normally follows from the placement records rather than being
          set by hand. Setting it here will be overwritten when a placement starts or ends.
        </Alert>
      )}
    </Modal>
  );
}

export function ConsultantProfilePage({ self }: { self?: boolean }) {
  const { user } = useAuth();
  const params = useParams();
  const nav = useNavigate();
  const id = self ? user?.consultantId : params.id;

  if (!id) {
    return <Alert kind="info">No consultant record is linked to this account.</Alert>;
  }
  return (
    <>
      {!self && (
        <button className="btn btn-sm" style={{ marginBottom: 12 }} onClick={() => nav(-1)}>
          Back
        </button>
      )}
      <ConsultantProfileInner id={id} />
    </>
  );
}
