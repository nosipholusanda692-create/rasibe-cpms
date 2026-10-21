import { useState } from 'react';
import {
  api, useLoad, useFormError, Card, Loading, Alert, Empty, Person,
  Field, Modal, ReasonModal, date, titleCase,
} from '../lib';

/**
 * Retention and anonymisation (NFR-PRI-004, NFR-PRI-005, BR-021).
 *
 * A candidate who was never placed has given the agency their name, contact
 * details and employment history on the understanding that it would be used to
 * find them work. Once the retention period has passed without a placement,
 * keeping it is no longer justified.
 *
 * Deliberately a screen rather than a nightly job. Anonymisation cannot be
 * undone, and the decision to remove somebody's personal data should be taken
 * by a person who has looked at the list, not by a timer at three in the
 * morning. The preview is therefore the default, and running it is a separate
 * act.
 */
export default function Retention() {
  const [msg, setMsg] = useState<{ kind: 'success' | 'error' | 'warn'; text: string } | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [anonymising, setAnonymising] = useState<any | null>(null);
  const [consenting, setConsenting] = useState<any | null>(null);

  const due = useLoad<any>(() => api.get('/retention'));

  async function run() {
    setBusy(true);
    setConfirming(false);
    try {
      const r = await api.post<any>('/retention/run', {});
      setMsg({
        kind: r.failed > 0 ? 'warn' : 'success',
        text: r.failed > 0
          ? `${r.anonymised} anonymised. ${r.failed} could not be and have been left as they were — each is run on its own, so the rest were unaffected.`
          : `${r.anonymised} candidate${r.anonymised === 1 ? '' : 's'} anonymised.`,
      });
      due.reload();
    } catch (e) {
      setMsg({ kind: 'error', text: e instanceof Error ? e.message : 'Could not run retention' });
    } finally { setBusy(false); }
  }

  const items = due.data?.items ?? [];
  const months = due.data?.months;
  const total = due.data?.due ?? 0;

  return (
    <>
      {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}

      <Card
        title="Retention"
        subtitle={months ? `Candidates never placed are anonymised after ${months} months` : undefined}
        action={total > 0 && (
          <button className="btn btn-danger btn-sm" disabled={busy}
            onClick={() => setConfirming(true)}>
            {busy ? 'Running…' : `Anonymise ${total}`}
          </button>
        )}
        footer={
          <span className="small muted">
            The period is a system setting, read each time this runs, so changing it applies to
            people already in the pool.
          </span>
        }>

        {due.loading ? <Loading />
          : due.error ? <Alert kind="error">{due.error}</Alert>
          : !items.length ? (
            <Empty message="Nobody is due. Every candidate in the pool has either been placed, has an open submission, has consented to be kept, or is still within the retention period." />
          ) : (
            <>
              <div style={{ padding: '14px 16px 0' }}>
                <Alert kind="warn">
                  Anonymising cannot be undone. The name, contact details, identity number,
                  banking and vetting records are cleared; the placements, timesheets and
                  invoices stay, because those are financial records.
                </Alert>
              </div>

              <table>
                <thead>
                  <tr>
                    <th>Candidate</th><th>In the pool since</th><th>Due since</th>
                    <th className="right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((c: any) => (
                    <tr key={c.consultant_id}>
                      <td><Person name={c.full_name} /></td>
                      <td className="mono small">{date(c.created_at)}</td>
                      <td className="mono small">
                        {date(c.due_on)}
                        {c.days_overdue > 0 && (
                          <div>
                            <span className={`pill pill-${c.days_overdue > 90 ? 'red' : 'amber'}`}>
                              {c.days_overdue} days past
                            </span>
                          </div>
                        )}
                      </td>
                      <td className="right">
                        <div className="btn-row" style={{ justifyContent: 'flex-end' }}>
                          <button className="btn btn-sm" onClick={() => setConsenting(c)}>
                            Keep longer
                          </button>
                          <button className="btn btn-sm btn-danger"
                            onClick={() => setAnonymising(c)}>
                            Anonymise
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {total > items.length && (
                <div className="card-body small muted">
                  Showing {items.length} of {total}. Running the job covers all of them.
                </div>
              )}
            </>
          )}
      </Card>

      <Card title="Anonymising on request" subtitle="NFR-PRI-005">
        <div className="card-body">
          <p className="small">
            Anyone may ask for their personal data to be removed, whether or not their
            retention period has passed. Open their profile and use Anonymise there, or use
            the control on a row above if they appear in this list.
          </p>
          <p className="small muted">
            Refused for anyone on a live placement: the engagement has to end first, because
            the timesheets and the invoice behind it are still in progress.
          </p>
        </div>
      </Card>

      {confirming && (
        <Modal title={`Anonymise ${total} candidate${total === 1 ? '' : 's'}`}
          onClose={() => setConfirming(false)}
          footer={<>
            <button className="btn" onClick={() => setConfirming(false)}>Cancel</button>
            <button className="btn btn-danger" onClick={run}>
              Anonymise {total}
            </button>
          </>}>
          <p className="small">
            Every candidate listed has been in the pool longer than {months} months without a
            placement, has no open submission, and has not consented to be kept.
          </p>
          <Alert kind="warn">
            This cannot be undone. Each person is anonymised in their own transaction, so one
            that fails does not undo the others.
          </Alert>
          <p className="small muted">
            What is cleared: name, contact details, identity number, date of birth, banking,
            vetting, rates and notes. Certifications, documents and queued emails are removed,
            and the account is closed. Invoice amounts do not move; where a name was copied
            onto an invoice line it becomes “Anonymised consultant”.
          </p>
        </Modal>
      )}

      {anonymising && (
        <ReasonModal
          title={`Anonymise ${anonymising.full_name}`}
          intent="This cannot be undone. Their personal data is cleared and the account closed. Placements, timesheets and invoices remain, because those are financial records."
          confirmLabel="Anonymise"
          danger
          onClose={() => setAnonymising(null)}
          onConfirm={async (reason) => {
            const r = await api.post<any>(
              `/retention/consultants/${anonymising.consultant_id}/anonymise`, { reason });
            setAnonymising(null);
            setMsg({
              kind: 'success',
              text: `${anonymising.full_name} anonymised.`
                + (r.invoice_lines_rewritten ? ` ${r.invoice_lines_rewritten} invoice line(s) rewritten.` : '')
                + (r.documents_removed ? ` ${r.documents_removed} document(s) removed.` : ''),
            });
            due.reload();
          }} />
      )}

      {consenting && (
        <KeepLonger
          consultant={consenting}
          onClose={() => setConsenting(null)}
          onSaved={(text) => { setConsenting(null); setMsg({ kind: 'success', text }); due.reload(); }} />
      )}
    </>
  );
}

/**
 * Recording consent to be kept longer (BR-021).
 *
 * A candidate may want to stay in the pool. What is recorded is the date they
 * agreed to and how they said so, because consent that cannot be evidenced is
 * not consent.
 */
function KeepLonger({
  consultant, onClose, onSaved,
}: { consultant: any; onClose: () => void; onSaved: (text: string) => void }) {
  const err = useFormError();
  const [busy, setBusy] = useState(false);
  const [retainUntil, setRetainUntil] = useState('');
  const [how, setHow] = useState('');
  const [touched, setTouched] = useState(false);

  const today = new Date().toISOString().slice(0, 10);
  const dateError = touched && !retainUntil ? 'Give the date they agreed to'
    : touched && retainUntil <= today ? 'That date has already passed'
    : undefined;
  const howError = touched && how.trim().length < 5
    ? 'Record how they gave their consent' : undefined;

  async function save() {
    setTouched(true);
    if (!retainUntil || retainUntil <= today || how.trim().length < 5) return;
    setBusy(true); err.clear();
    try {
      await api.post(`/retention/consultants/${consultant.consultant_id}/consent`, {
        retainUntil,
        reason: how.trim(),
      });
      onSaved(`${consultant.full_name} will be kept until ${date(retainUntil)}.`);
    } catch (e) { err.capture(e); } finally { setBusy(false); }
  }

  return (
    <Modal title={`Keep ${consultant.full_name} longer`} onClose={onClose}
      footer={<>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" onClick={save} disabled={busy}>
          {busy ? 'Saving…' : 'Record consent'}
        </button>
      </>}>
      {err.error && <Alert kind="error">{err.error}</Alert>}

      <p className="small">
        A candidate may consent to staying in the pool beyond the retention period. They
        will not appear in this list again until the date below.
      </p>

      <Field label="Keep until" required error={dateError}>
        <input type="date" min={today} value={retainUntil}
          aria-invalid={dateError ? true : undefined}
          onChange={(e) => setRetainUntil(e.target.value)}
          onBlur={() => setTouched(true)} />
      </Field>

      <Field label="How they gave their consent" required error={howError}
        hint="Recorded in the audit log. Consent that cannot be evidenced is not consent.">
        <textarea value={how}
          aria-invalid={howError ? true : undefined}
          onChange={(e) => setHow(e.target.value)}
          onBlur={() => setTouched(true)}
          placeholder="Confirmed by email on 14 October, asked to be kept on file for senior Java roles." />
      </Field>
    </Modal>
  );
}
