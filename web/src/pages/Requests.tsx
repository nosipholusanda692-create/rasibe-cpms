import { useState } from 'react';
import { Link, useParams, useNavigate } from 'react-router-dom';
import {
  api, useAuth, useLoad, useFormError, Card, Status, Loading, Alert, Empty, Person,
  Field, Modal, money, date, titleCase,
} from '../lib';

// =====================================================================
// Role request list (UC-07, UC-08)
// =====================================================================
export default function Requests() {
  const { user } = useAuth();
  const [status, setStatus] = useState('OPEN,SHORTLISTING,INTERVIEWING');
  const [raising, setRaising] = useState(false);
  const list = useLoad<any>(
    () => api.get(`/requests${status ? `?status=${status}` : ''}`), [status]);
  const canRaise = ['ADMINISTRATOR', 'RECRUITER', 'CLIENT_MANAGER'].includes(user?.role ?? '');

  return (
    <>
      <Card title="Role requests"
        subtitle={list.data ? `${list.data.items.length} requests` : undefined}
        action={canRaise && (
          <button className="btn btn-primary btn-sm" onClick={() => setRaising(true)}>
            New role request
          </button>
        )}>
        <div className="filters">
          <Field label="Status">
            <select value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="OPEN,SHORTLISTING,INTERVIEWING">Open</option>
              <option value="FILLED">Filled</option>
              <option value="CANCELLED">Cancelled</option>
              <option value="">All</option>
            </select>
          </Field>
        </div>

        {list.loading ? <Loading />
          : list.error ? <Alert kind="error">{list.error}</Alert>
          : !list.data?.items.length ? <Empty message="No role requests match that filter." />
          : (
            <table>
              <thead>
                <tr>
                  <th>Role</th><th>Client</th><th>Start</th>
                  <th className="num">Shortlisted</th><th>Status</th><th className="num">Age</th>
                </tr>
              </thead>
              <tbody>
                {list.data.items.map((r: any) => (
                  <tr key={r.request_id} className="clickable">
                    <td>
                      <Link to={`/requests/${r.request_id}`}><strong>{r.title}</strong></Link>
                      <div className="person-role">
                        {r.reference} · {titleCase(r.seniority)}
                        {r.duration_months ? ` · ${r.duration_months} months` : ''}
                        {` · ${titleCase(r.work_mode)}`}
                      </div>
                    </td>
                    <td>{r.client_name}</td>
                    <td className="mono">{date(r.start_date)}</td>
                    <td className="num">{r.shortlisted_count} of {r.submitted_count}</td>
                    <td><Status value={r.status} /></td>
                    <td className="num">
                      <span className={`pill pill-${r.age_days > 5 ? 'red' : r.age_days > 2 ? 'amber' : 'grey'}`}>
                        {r.age_days} d
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
      </Card>

      {raising && <RaiseRequest onClose={() => setRaising(false)}
        onSaved={() => { setRaising(false); list.reload(); }} />}
    </>
  );
}

function RaiseRequest({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const { user } = useAuth();
  const err = useFormError();
  const [busy, setBusy] = useState(false);
  const clients = useLoad<any>(() => api.get('/clients'));
  const skills = useLoad<any>(() => api.get('/skills'));
  const [chosenSkills, setChosenSkills] = useState<string[]>([]);
  const [f, setF] = useState({
    clientId: '', title: '', description: '', seniority: 'SENIOR',
    engagementType: 'FULL_TIME', workMode: 'ON_SITE', location: '',
    quantity: '1', startDate: '', durationMonths: '', budgetRate: '',
  });
  const set = (k: string, v: string) => setF((p) => ({ ...p, [k]: v }));

  // a client manager raises against their own company only
  const clientOptions = clients.data?.items ?? [];
  const effectiveClientId = user?.role === 'CLIENT_MANAGER'
    ? (user.clients[0]?.clientId ?? '') : f.clientId;

  async function save() {
    setBusy(true); err.clear();
    try {
      await api.post('/requests', {
        clientId: effectiveClientId,
        title: f.title,
        description: f.description || undefined,
        seniority: f.seniority,
        engagementType: f.engagementType,
        workMode: f.workMode,
        location: f.location || undefined,
        quantity: Number(f.quantity),
        startDate: f.startDate || undefined,
        durationMonths: f.durationMonths ? Number(f.durationMonths) : undefined,
        budgetRate: f.budgetRate ? Number(f.budgetRate) : undefined,
        skills: chosenSkills.map((id) => ({ skillId: id, mandatory: true })),
      });
      onSaved();
    } catch (e) { err.capture(e); } finally { setBusy(false); }
  }

  return (
    <Modal title="Raise a role request" onClose={onClose}
      footer={<>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" onClick={save} disabled={busy}>
          {busy ? 'Raising…' : 'Raise request'}
        </button>
      </>}>
      {err.error && <Alert kind="error">{err.error}</Alert>}

      {user?.role !== 'CLIENT_MANAGER' && (
        <Field label="Client company" required error={err.fieldError('clientId')}>
          <select value={f.clientId} onChange={(e) => set('clientId', e.target.value)}>
            <option value="">Choose a client</option>
            {clientOptions.map((c: any) => (
              <option key={c.client_id} value={c.client_id}>{c.legal_name}</option>
            ))}
          </select>
        </Field>
      )}

      <Field label="Role title" required error={err.fieldError('title')}>
        <input value={f.title} onChange={(e) => set('title', e.target.value)}
          placeholder="Senior Java developer" />
      </Field>
      <Field label="Description">
        <textarea value={f.description} onChange={(e) => set('description', e.target.value)}
          placeholder="What the consultant will be working on" />
      </Field>

      <div className="form-row">
        <Field label="Seniority">
          <select value={f.seniority} onChange={(e) => set('seniority', e.target.value)}>
            {['JUNIOR', 'INTERMEDIATE', 'SENIOR', 'LEAD', 'PRINCIPAL'].map((s) => (
              <option key={s} value={s}>{titleCase(s)}</option>
            ))}
          </select>
        </Field>
        <Field label="How many" required>
          <input type="number" min={1} value={f.quantity} onChange={(e) => set('quantity', e.target.value)} />
        </Field>
      </div>

      <div className="form-row">
        <Field label="Engagement">
          <select value={f.engagementType} onChange={(e) => set('engagementType', e.target.value)}>
            {['FULL_TIME', 'PART_TIME', 'CONTRACT', 'FIXED_TERM'].map((s) => (
              <option key={s} value={s}>{titleCase(s)}</option>
            ))}
          </select>
        </Field>
        <Field label="Work mode">
          <select value={f.workMode} onChange={(e) => set('workMode', e.target.value)}>
            {['ON_SITE', 'HYBRID', 'REMOTE'].map((s) => (
              <option key={s} value={s}>{titleCase(s)}</option>
            ))}
          </select>
        </Field>
      </div>

      <div className="form-row">
        <Field label="Start date"><input type="date" value={f.startDate}
          onChange={(e) => set('startDate', e.target.value)} /></Field>
        <Field label="Duration (months)"><input type="number" min={1} value={f.durationMonths}
          onChange={(e) => set('durationMonths', e.target.value)} /></Field>
      </div>

      <Field label="Budget rate" hint="Per hour. The rate you expect to be billed.">
        <input type="number" min={0} value={f.budgetRate}
          onChange={(e) => set('budgetRate', e.target.value)} />
      </Field>

      <Field label="Required skills">
        <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
          {(skills.data?.items ?? []).map((s: any) => {
            const on = chosenSkills.includes(s.skill_id);
            return (
              <button type="button" key={s.skill_id}
                className={`pill pill-${on ? 'blue' : 'grey'}`}
                style={{ border: 0, cursor: 'pointer', fontFamily: 'inherit' }}
                onClick={() => setChosenSkills((c) =>
                  on ? c.filter((x) => x !== s.skill_id) : [...c, s.skill_id])}>
                {s.name}
              </button>
            );
          })}
        </div>
      </Field>
    </Modal>
  );
}

// =====================================================================
// Request detail: matching, submissions, placement (UC-05, 09, 10, 11, 12)
// =====================================================================
export function RequestDetailPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const { user, can } = useAuth();
  const [tab, setTab] = useState<'submissions' | 'matches'>('submissions');
  const [msg, setMsg] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  const [placing, setPlacing] = useState<any | null>(null);

  const r = useLoad<any>(() => api.get(`/requests/${id}`), [id]);
  const subs = useLoad<any>(() => api.get(`/requests/${id}/submissions`), [id]);
  const matches = useLoad<any>(
    () => can('submit_candidate') ? api.get(`/requests/${id}/matches`) : Promise.resolve({ items: [] }),
    [id]);

  if (r.loading) return <Loading />;
  if (r.error) return <Alert kind="error">{r.error}</Alert>;
  const d = r.data;

  async function submitCandidate(consultantId: string) {
    setMsg(null);
    try {
      await api.post(`/requests/${id}/submissions`, { consultantId });
      setMsg({ kind: 'success', text: 'Consultant submitted. The client manager has been notified.' });
      subs.reload(); matches.reload();
    } catch (e) {
      setMsg({ kind: 'error', text: e instanceof Error ? e.message : 'Could not submit' });
    }
  }

  async function setOutcome(submissionId: string, outcome: string) {
    const needsReason = ['DECLINED_BY_CLIENT', 'WITHDRAWN'].includes(outcome);
    let reason: string | undefined;
    if (needsReason) {
      reason = window.prompt('Give a reason so the consultant can be told why:') ?? undefined;
      if (!reason) return;
    }
    try {
      await api.patch(`/requests/submissions/${submissionId}`, { outcome, reason });
      setMsg({ kind: 'success', text: 'Outcome recorded.' });
      subs.reload(); r.reload();
    } catch (e) {
      setMsg({ kind: 'error', text: e instanceof Error ? e.message : 'Could not record outcome' });
    }
  }

  return (
    <>
      <button className="btn btn-sm" style={{ marginBottom: 12 }} onClick={() => nav('/requests')}>
        Back to requests
      </button>

      {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}

      <Card title={d.title} subtitle={`${d.reference} · ${d.client_name}`}
        action={<Status value={d.status} />}>
        <div className="card-body">
          <dl className="def-list">
            <div><dt>Seniority</dt><dd>{titleCase(d.seniority)}</dd></div>
            <div><dt>Engagement</dt><dd>{titleCase(d.engagement_type)}</dd></div>
            <div><dt>Work mode</dt><dd>{titleCase(d.work_mode)}</dd></div>
            <div><dt>Location</dt><dd>{d.location ?? '—'}</dd></div>
            <div><dt>Start date</dt><dd>{date(d.start_date)}</dd></div>
            <div><dt>Duration</dt><dd>{d.duration_months ? `${d.duration_months} months` : '—'}</dd></div>
            <div><dt>Budget rate</dt><dd>{money(d.budget_rate)} / hr</dd></div>
            <div><dt>How many</dt><dd>{d.quantity}</dd></div>
            <div><dt>Raised</dt><dd>{date(d.created_at)}</dd></div>
          </dl>
          {d.description && <p className="small" style={{ marginTop: 14 }}>{d.description}</p>}
          {(d.skills ?? []).length > 0 && (
            <div className="row" style={{ flexWrap: 'wrap', gap: 6, marginTop: 12 }}>
              {d.skills.map((s: any) => (
                <span key={s.skillId} className={`pill pill-${s.mandatory ? 'blue' : 'grey'}`}>
                  {s.name}{s.minProficiency ? ` · ${titleCase(s.minProficiency)}` : ''}
                </span>
              ))}
            </div>
          )}
        </div>
      </Card>

      <Card>
        <div className="tabs">
          <button className={`tab${tab === 'submissions' ? ' active' : ''}`}
            onClick={() => setTab('submissions')}>
            Submitted candidates ({subs.data?.items.length ?? 0})
          </button>
          {can('submit_candidate') && (
            <button className={`tab${tab === 'matches' ? ' active' : ''}`}
              onClick={() => setTab('matches')}>
              Matching pool ({matches.data?.items.length ?? 0})
            </button>
          )}
        </div>

        {tab === 'submissions' && (
          subs.loading ? <Loading />
            : !subs.data?.items.length ? <Empty message="No candidates submitted yet." />
            : (
              <table>
                <thead>
                  <tr><th>Candidate</th><th>Seniority</th><th>Experience</th>
                    <th>Outcome</th><th className="right">Action</th></tr>
                </thead>
                <tbody>
                  {subs.data.items.map((s: any) => (
                    <tr key={s.submission_id}>
                      <td>
                        {s.full_name
                          ? <Person name={s.full_name} sub={s.headline} />
                          : <>
                              <div className="person-name">{s.preferred_name ?? 'Candidate'}</div>
                              <div className="person-role">{s.headline}</div>
                            </>}
                      </td>
                      <td>{titleCase(s.seniority)}</td>
                      <td>{s.experience_years ? `${s.experience_years} years` : '—'}</td>
                      <td><Status value={s.outcome} /></td>
                      <td className="right">
                        <div className="btn-row" style={{ justifyContent: 'flex-end' }}>
                          {user?.role === 'CLIENT_MANAGER' && s.outcome === 'SUBMITTED' && (
                            <>
                              <button className="btn btn-sm btn-success"
                                onClick={() => setOutcome(s.submission_id, 'SHORTLISTED')}>Shortlist</button>
                              <button className="btn btn-sm btn-danger"
                                onClick={() => setOutcome(s.submission_id, 'DECLINED_BY_CLIENT')}>Decline</button>
                            </>
                          )}
                          {can('create_placement') && ['SHORTLISTED', 'INTERVIEWING', 'OFFERED'].includes(s.outcome) && (
                            <button className="btn btn-sm btn-primary" onClick={() => setPlacing(s)}>
                              Create placement
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )
        )}

        {tab === 'matches' && (
          matches.loading ? <Loading />
            : !matches.data?.items.length ? <Empty message="No available consultant matches this request." />
            : (
              <table>
                <thead>
                  <tr><th>Consultant</th><th className="num">Skill match</th><th>Availability</th>
                    <th className="num">Min rate</th><th className="right">Action</th></tr>
                </thead>
                <tbody>
                  {matches.data.items.map((m: any) => (
                    <tr key={m.consultant_id}>
                      <td><Person name={m.full_name} sub={m.headline} /></td>
                      <td className="num">
                        <span className={`pill pill-${m.matched_mandatory >= m.required_mandatory ? 'green' : 'amber'}`}>
                          {m.matched_skills} of {m.required_skills}
                        </span>
                      </td>
                      <td>
                        <Status value={m.availability} />
                        {m.available_from && <div className="person-role">from {date(m.available_from)}</div>}
                      </td>
                      <td className="num">{money(m.min_pay_rate)}</td>
                      <td className="right">
                        {m.already_submitted ? <span className="muted small">Already submitted</span>
                          : !m.has_consent ? (
                            <span className="pill pill-red" title="Consent must be recorded first (BR-012)">
                              Consent needed
                            </span>
                          ) : (
                            <button className="btn btn-sm btn-primary"
                              onClick={() => submitCandidate(m.consultant_id)}>Submit</button>
                          )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )
        )}
      </Card>

      {placing && (
        <CreatePlacement submission={placing} request={d}
          onClose={() => setPlacing(null)}
          onSaved={() => {
            setPlacing(null); subs.reload(); r.reload();
            setMsg({ kind: 'success', text: 'Placement created, awaiting rate approval.' });
          }} />
      )}
    </>
  );
}

function CreatePlacement({
  submission, request, onClose, onSaved,
}: { submission: any; request: any; onClose: () => void; onSaved: () => void }) {
  const err = useFormError();
  const [busy, setBusy] = useState(false);
  const [f, setF] = useState({
    jobTitle: request.title,
    startDate: request.start_date?.slice(0, 10) ?? '',
    endDate: '',
    billRate: String(request.budget_rate ?? ''),
    payRate: '',
    engagementType: request.engagement_type ?? 'FULL_TIME',
    workMode: request.work_mode ?? 'ON_SITE',
  });
  const set = (k: string, v: string) => setF((p) => ({ ...p, [k]: v }));

  const margin = Number(f.billRate || 0) - Number(f.payRate || 0);

  async function save() {
    setBusy(true); err.clear();
    try {
      await api.post('/placements', {
        submissionId: submission.submission_id,
        consultantId: submission.consultant_id,
        clientId: request.client_id,
        requestId: request.request_id,
        jobTitle: f.jobTitle,
        engagementType: f.engagementType,
        workMode: f.workMode,
        startDate: f.startDate,
        endDate: f.endDate,
        billRate: Number(f.billRate),
        payRate: Number(f.payRate),
      });
      onSaved();
    } catch (e) { err.capture(e); } finally { setBusy(false); }
  }

  return (
    <Modal title="Create placement" onClose={onClose}
      footer={<>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" onClick={save} disabled={busy}>
          {busy ? 'Creating…' : 'Create placement'}
        </button>
      </>}>
      {err.error && <Alert kind="error">{err.error}</Alert>}

      <Field label="Job title" required><input value={f.jobTitle}
        onChange={(e) => set('jobTitle', e.target.value)} /></Field>

      <div className="form-row">
        <Field label="Start date" required error={err.fieldError('startDate')}>
          <input type="date" value={f.startDate} onChange={(e) => set('startDate', e.target.value)} />
        </Field>
        <Field label="End date" required error={err.fieldError('endDate')}>
          <input type="date" value={f.endDate} onChange={(e) => set('endDate', e.target.value)} />
        </Field>
      </div>

      <div className="form-row">
        <Field label="Bill rate" required hint="Charged to the client">
          <input type="number" min={0} value={f.billRate} onChange={(e) => set('billRate', e.target.value)} />
        </Field>
        <Field label="Pay rate" required hint="Paid to the consultant">
          <input type="number" min={0} value={f.payRate} onChange={(e) => set('payRate', e.target.value)} />
        </Field>
      </div>

      {f.billRate && f.payRate && (
        <Alert kind={margin < 0 ? 'error' : 'info'}>
          Margin {money(margin)} per hour.
          {margin < 0 && ' The pay rate may not exceed the bill rate.'}
        </Alert>
      )}

      <Alert kind="warn">
        The placement is created awaiting rate approval. An administrator must approve
        the rates before it becomes active and timesheets can be raised against it.
      </Alert>
    </Modal>
  );
}
