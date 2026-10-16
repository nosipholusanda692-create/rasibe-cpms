import { useState } from 'react';
import { Link, useParams, useNavigate } from 'react-router-dom';
import {
  api, useAuth, useLoad, useFormError, Card, Status, Loading, Alert, Empty, Person,
  Field, Modal, ReasonModal, Pager, usePaging, money, date, titleCase,
} from '../lib';
import {
  useForm, required, minLength, maxLength, number, min, max, afterField, notAbove, integer,
} from '../validation';

// =====================================================================
// Role request list (UC-07, UC-08)
// =====================================================================
export default function Requests() {
  const { user } = useAuth();
  const [status, setStatus] = useState('OPEN,SHORTLISTING,INTERVIEWING');
  const [raising, setRaising] = useState(false);
  const { page, setPage } = usePaging(status);

  const list = useLoad<any>(
    () => api.get(`/requests?page=${page}${status ? `&status=${status}` : ''}`),
    [status, page]);
  const canRaise = ['ADMINISTRATOR', 'RECRUITER', 'CLIENT_MANAGER'].includes(user?.role ?? '');

  return (
    <>
      <Card title="Role requests"
        subtitle={list.data ? `${list.data.total ?? list.data.items.length} requests` : undefined}
        footer={list.data && (
          <Pager page={list.data.page} pageSize={list.data.pageSize} total={list.data.total}
            pageCount={list.data.pageCount} onPage={setPage} noun="requests" />
        )}
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

  const isClientManager = user?.role === 'CLIENT_MANAGER';

  const form = useForm(
    {
      clientId: '', title: '', description: '', seniority: 'SENIOR',
      engagementType: 'FULL_TIME', workMode: 'ON_SITE', location: '',
      quantity: '1', startDate: '', durationMonths: '', budgetRate: '',
    },
    {
      // a client manager raises against their own company, so there is nothing to pick
      clientId: isClientManager ? [] : [required('A client company')],
      title: [required('A role title'), minLength(3, 'The role title'), maxLength(200, 'The role title')],
      description: [maxLength(2000, 'The description')],
      quantity: [required('A number'), integer('The number of people'), min(1, 'The number of people'), max(50, 'The number of people')],
      startDate: [],
      durationMonths: [integer('The duration'), min(1, 'The duration'), max(60, 'The duration')],
      budgetRate: [number('The budget rate'), min(0, 'The budget rate')],
    },
  );

  const f = form.values;
  const effectiveClientId = isClientManager ? (user?.clients[0]?.clientId ?? '') : f.clientId;

  async function save() {
    if (!form.attemptSubmit()) return;
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
    } catch (e) {
      err.capture(e);
      form.applyServerErrors((e as any)?.detail);
    } finally { setBusy(false); }
  }

  return (
    <Modal title="Raise a role request" onClose={onClose}
      footer={<>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" onClick={save}
          disabled={busy || (form.submitted && !form.isValid)}>
          {busy ? 'Raising…' : 'Raise request'}
        </button>
      </>}>
      {err.error && <Alert kind="error">{err.error}</Alert>}

      {!isClientManager && (
        <Field label="Client company" required error={form.errorFor('clientId')}>
          <select {...form.fieldProps('clientId')}>
            <option value="">Choose a client</option>
            {(clients.data?.items ?? []).map((c: any) => (
              <option key={c.client_id} value={c.client_id}>{c.legal_name}</option>
            ))}
          </select>
        </Field>
      )}

      <Field label="Role title" required error={form.errorFor('title')}>
        <input {...form.fieldProps('title')} placeholder="Senior Java developer" />
      </Field>

      <Field label="Description" error={form.errorFor('description')}
        hint={`${String(f.description).length} of 2000 characters`}>
        <textarea {...form.fieldProps('description')}
          placeholder="What the consultant will be working on" />
      </Field>

      <div className="form-row">
        <Field label="Seniority">
          <select {...form.fieldProps('seniority')}>
            {['JUNIOR', 'INTERMEDIATE', 'SENIOR', 'LEAD', 'PRINCIPAL'].map((s) => (
              <option key={s} value={s}>{titleCase(s)}</option>
            ))}
          </select>
        </Field>
        <Field label="How many" required error={form.errorFor('quantity')}>
          <input type="number" min={1} {...form.fieldProps('quantity')} />
        </Field>
      </div>

      <div className="form-row">
        <Field label="Engagement">
          <select {...form.fieldProps('engagementType')}>
            {['FULL_TIME', 'PART_TIME', 'CONTRACT', 'FIXED_TERM'].map((s) => (
              <option key={s} value={s}>{titleCase(s)}</option>
            ))}
          </select>
        </Field>
        <Field label="Work mode">
          <select {...form.fieldProps('workMode')}>
            {['ON_SITE', 'HYBRID', 'REMOTE'].map((s) => (
              <option key={s} value={s}>{titleCase(s)}</option>
            ))}
          </select>
        </Field>
      </div>

      <div className="form-row">
        <Field label="Start date" error={form.errorFor('startDate')}>
          <input type="date" {...form.fieldProps('startDate')} />
        </Field>
        <Field label="Duration (months)" error={form.errorFor('durationMonths')}>
          <input type="number" min={1} {...form.fieldProps('durationMonths')} />
        </Field>
      </div>

      <Field label="Budget rate" error={form.errorFor('budgetRate')}
        hint="Per hour. The rate you expect to be billed.">
        <input type="number" min={0} step="0.01" {...form.fieldProps('budgetRate')} />
      </Field>

      <Field label="Required skills"
        hint={chosenSkills.length ? `${chosenSkills.length} selected` : 'Optional, but a request with skills matches far better'}>
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
  const [declining, setDeclining] = useState<{ submissionId: string; outcome: string } | null>(null);

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
    // declining or withdrawing needs an explanation the consultant can act on
    if (['DECLINED_BY_CLIENT', 'WITHDRAWN'].includes(outcome)) {
      setDeclining({ submissionId, outcome });
      return;
    }
    try {
      await api.patch(`/requests/submissions/${submissionId}`, { outcome });
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

      {declining && (
        <ReasonModal
          title={declining.outcome === 'WITHDRAWN' ? 'Withdraw this candidate' : 'Decline this candidate'}
          intent="The consultant is told the outcome and the reason, so make it something they can act on."
          label="Reason"
          confirmLabel={declining.outcome === 'WITHDRAWN' ? 'Withdraw' : 'Decline'}
          danger
          onClose={() => setDeclining(null)}
          onConfirm={async (reason) => {
            await api.patch(`/requests/submissions/${declining.submissionId}`, {
              outcome: declining.outcome, reason,
            });
            setDeclining(null);
            setMsg({ kind: 'success', text: 'Outcome recorded and the consultant notified.' });
            subs.reload(); r.reload();
          }} />
      )}

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

  const form = useForm(
    {
      jobTitle: request.title ?? '',
      startDate: request.start_date?.slice(0, 10) ?? '',
      endDate: '',
      billRate: String(request.budget_rate ?? ''),
      payRate: '',
      engagementType: request.engagement_type ?? 'FULL_TIME',
      workMode: request.work_mode ?? 'ON_SITE',
    },
    {
      jobTitle: [required('A job title'), minLength(2, 'The job title'), maxLength(200, 'The job title')],
      startDate: [required('A start date')],
      // BR-014, enforced here, on the server and as a check constraint
      endDate: [required('An end date'), afterField('startDate', 'The end date', 'the start date')],
      billRate: [required('A bill rate'), number('The bill rate'), min(0, 'The bill rate')],
      payRate: [
        required('A pay rate'), number('The pay rate'), min(0, 'The pay rate'),
        notAbove('billRate', 'The pay rate', 'the bill rate'),
      ],
    },
  );

  const f = form.values;
  const margin = Number(f.billRate || 0) - Number(f.payRate || 0);
  const marginShown = f.billRate !== '' && f.payRate !== '' && !form.errorFor('payRate');

  async function save() {
    if (!form.attemptSubmit()) return;
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
    } catch (e) {
      err.capture(e);
      // the server may object to something the form could not know, such as an
      // overlapping placement (BR-001); show it against the field it concerns
      form.applyServerErrors((e as any)?.detail);
    } finally { setBusy(false); }
  }

  return (
    <Modal title="Create placement" onClose={onClose}
      footer={<>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" onClick={save}
          disabled={busy || (form.submitted && !form.isValid)}>
          {busy ? 'Creating…' : 'Create placement'}
        </button>
      </>}>
      {err.error && <Alert kind="error">{err.error}</Alert>}

      <Field label="Job title" required error={form.errorFor('jobTitle')}>
        <input {...form.fieldProps('jobTitle')} />
      </Field>

      <div className="form-row">
        <Field label="Start date" required error={form.errorFor('startDate')}>
          <input type="date" {...form.fieldProps('startDate')} />
        </Field>
        <Field label="End date" required error={form.errorFor('endDate')}>
          <input type="date" {...form.fieldProps('endDate')} />
        </Field>
      </div>

      <div className="form-row">
        <Field label="Bill rate" required error={form.errorFor('billRate')}
          hint="Charged to the client, per hour">
          <input type="number" min={0} step="0.01" {...form.fieldProps('billRate')} />
        </Field>
        <Field label="Pay rate" required error={form.errorFor('payRate')}
          hint="Paid to the consultant, per hour">
          <input type="number" min={0} step="0.01" {...form.fieldProps('payRate')} />
        </Field>
      </div>

      {marginShown && (
        <Alert kind="info">
          Margin {money(margin)} per hour.
          {margin === 0 && ' This placement earns nothing.'}
        </Alert>
      )}

      <Alert kind="warn">
        The placement is created awaiting rate approval. An administrator must approve
        the rates before it becomes active and timesheets can be raised against it.
      </Alert>
    </Modal>
  );
}
