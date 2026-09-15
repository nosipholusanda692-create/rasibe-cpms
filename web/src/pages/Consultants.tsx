import { useState } from 'react';
import { Link, useParams, useNavigate } from 'react-router-dom';
import {
  api, useAuth, useLoad, useFormError, Card, Status, Loading, Alert, Empty, Person,
  Field, Modal, money, date, titleCase,
} from '../lib';

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
    return (
      <Card title="Skills" subtitle="The taxonomy used for matching consultants to requests">
        {skills.loading ? <Loading /> : (
          <table>
            <thead><tr><th>Skill</th><th>Category</th><th className="num">Consultants</th></tr></thead>
            <tbody>
              {skills.data?.items.map((s: any) => (
                <tr key={s.skill_id}>
                  <td><strong>{s.name}</strong></td>
                  <td className="muted">{s.category ?? '—'}</td>
                  <td className="num">{s.consultant_count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    );
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
  const [form, setForm] = useState({
    fullName: '', email: '', mobile: '', location: '',
    seniority: 'INTERMEDIATE', headline: '', experienceYears: '',
    availability: 'AVAILABLE', availableFrom: '', minPayRate: '',
  });

  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }));

  async function save() {
    setBusy(true);
    err.clear();
    try {
      await api.post('/consultants', {
        fullName: form.fullName,
        email: form.email,
        mobile: form.mobile || undefined,
        location: form.location || undefined,
        seniority: form.seniority,
        headline: form.headline || undefined,
        experienceYears: form.experienceYears ? Number(form.experienceYears) : undefined,
        availability: form.availability,
        availableFrom: form.availableFrom || undefined,
        minPayRate: form.minPayRate ? Number(form.minPayRate) : undefined,
      });
      onSaved();
    } catch (e) {
      err.capture(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Add a consultant to the pool" onClose={onClose}
      footer={<>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" onClick={save} disabled={busy}>
          {busy ? 'Saving…' : 'Add consultant'}
        </button>
      </>}>
      {err.error && <Alert kind="error">{err.error}</Alert>}
      <div className="form-row">
        <Field label="Full name" required error={err.fieldError('fullName')}>
          <input value={form.fullName} onChange={(e) => set('fullName', e.target.value)} />
        </Field>
        <Field label="Email address" required error={err.fieldError('email')}>
          <input type="email" value={form.email} onChange={(e) => set('email', e.target.value)} />
        </Field>
      </div>
      <div className="form-row">
        <Field label="Mobile"><input value={form.mobile} onChange={(e) => set('mobile', e.target.value)} /></Field>
        <Field label="Location"><input value={form.location} onChange={(e) => set('location', e.target.value)} /></Field>
      </div>
      <Field label="Headline" hint="One line describing what they do">
        <input value={form.headline} onChange={(e) => set('headline', e.target.value)} />
      </Field>
      <div className="form-row">
        <Field label="Seniority">
          <select value={form.seniority} onChange={(e) => set('seniority', e.target.value)}>
            {['JUNIOR', 'INTERMEDIATE', 'SENIOR', 'LEAD', 'PRINCIPAL'].map((s) => (
              <option key={s} value={s}>{titleCase(s)}</option>
            ))}
          </select>
        </Field>
        <Field label="Years of experience">
          <input type="number" min={0} max={60} value={form.experienceYears}
            onChange={(e) => set('experienceYears', e.target.value)} />
        </Field>
      </div>
      <div className="form-row">
        <Field label="Availability">
          <select value={form.availability} onChange={(e) => set('availability', e.target.value)}>
            <option value="AVAILABLE">Available now</option>
            <option value="AVAILABLE_FROM">Available from</option>
            <option value="NOT_AVAILABLE">Not available</option>
          </select>
        </Field>
        {form.availability === 'AVAILABLE_FROM' ? (
          <Field label="Available from" required>
            <input type="date" value={form.availableFrom} onChange={(e) => set('availableFrom', e.target.value)} />
          </Field>
        ) : (
          <Field label="Minimum pay rate" hint="Per hour, never shown to a client">
            <input type="number" min={0} value={form.minPayRate}
              onChange={(e) => set('minPayRate', e.target.value)} />
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
    </>
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
