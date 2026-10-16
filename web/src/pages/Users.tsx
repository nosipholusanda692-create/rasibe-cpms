import { useState } from 'react';
import {
  api, useAuth, useLoad, useFormError, Card, Status, Loading, Alert, Empty, Person,
  Field, Modal, ReasonModal, date, titleCase,
} from '../lib';

/**
 * Account administration (FR-AUT-001, 008, 010, 013).
 *
 * No password is ever set here. Creating an account issues an invitation and
 * the person chooses their own, so nobody else ever knows it.
 */
export default function Users() {
  const { user } = useAuth();
  const [search, setSearch] = useState('');
  const [adding, setAdding] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [statusTarget, setStatusTarget] = useState<{ user: any; isActive: boolean } | null>(null);
  const [roleTarget, setRoleTarget] = useState<any | null>(null);
  const [newRole, setNewRole] = useState('RECRUITER');
  const [twoFactorTarget, setTwoFactorTarget] = useState<any | null>(null);

  const list = useLoad<any>(
    () => api.get(`/users${search ? `?search=${encodeURIComponent(search)}` : ''}`), [search]);

  async function applyStatus(reason: string) {
    const t = statusTarget!;
    await api.post(`/users/${t.user.user_id}/status`, { isActive: t.isActive, reason });
    setStatusTarget(null);
    setMsg({
      kind: 'success',
      text: `${t.user.full_name} ${t.isActive ? 'reinstated' : 'suspended'}.`,
    });
    list.reload();
  }

  async function reinvite(u: any) {
    try {
      const r = await api.post<any>(`/users/${u.user_id}/invite`, {});
      setMsg({ kind: 'success', text: `A new invitation was sent to ${r.email}.` });
      if (r.inviteLink) setLink(r.inviteLink);
      list.reload();
    } catch (e) {
      setMsg({ kind: 'error', text: e instanceof Error ? e.message : 'Could not send the invitation' });
    }
  }

  async function applyRole(reason: string) {
    const u = roleTarget!;
    await api.post(`/users/${u.user_id}/role`, { role: newRole, reason });
    setRoleTarget(null);
    setMsg({ kind: 'success', text: `${u.full_name} is now ${titleCase(newRole)}.` });
    list.reload();
  }

  async function applyTwoFactorReset(reason: string) {
    const u = twoFactorTarget!;
    await api.post(`/auth/2fa/reset/${u.user_id}`, { reason });
    setTwoFactorTarget(null);
    setMsg({ kind: 'success', text: `Two-factor was reset for ${u.full_name}.` });
    list.reload();
  }

  return (
    <>
      {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}
      {link && (
        <Alert kind="info">
          No mail server is configured, so the invitation was not delivered. Pass this
          link to the person directly — it is valid for 72 hours and can be used once.
          <div style={{ marginTop: 8, wordBreak: 'break-all', fontSize: 12 }}>
            <code>{link}</code>
          </div>
          <button className="btn btn-sm" style={{ marginTop: 8 }} onClick={() => setLink(null)}>
            Dismiss
          </button>
        </Alert>
      )}

      <Card title="User accounts"
        subtitle={list.data ? `${list.data.items.length} accounts` : undefined}
        action={<button className="btn btn-primary btn-sm" onClick={() => setAdding(true)}>
          Create account
        </button>}>
        <div className="filters">
          <Field label="Search">
            <input placeholder="Name or email" value={search}
              onChange={(e) => setSearch(e.target.value)} />
          </Field>
        </div>

        {list.loading ? <Loading />
          : list.error ? <Alert kind="error">{list.error}</Alert>
          : !list.data?.items.length ? <Empty message="No accounts match." />
          : (
            <table>
              <thead>
                <tr><th>Person</th><th>Role</th><th>Linked to</th>
                  <th>Last signed in</th><th>Status</th><th className="right">Actions</th></tr>
              </thead>
              <tbody>
                {list.data.items.map((u: any) => (
                  <tr key={u.user_id}>
                    <td>
                      <Person name={u.full_name} sub={u.email} />
                    </td>
                    <td>{titleCase(u.role)}</td>
                    <td className="small muted">
                      {u.consultant_id ? 'Consultant record'
                        : u.client_name ? u.client_name
                        : '—'}
                    </td>
                    <td className="mono small">{u.last_login_at ? date(u.last_login_at) : 'Never'}</td>
                    <td>
                      {!u.is_active ? <span className="pill pill-red">Suspended</span>
                        : u.awaiting_first_sign_in ? (
                          <span className="pill pill-amber">
                            {u.invite_expires_at ? 'Invited' : 'No invitation'}
                          </span>
                        ) : <span className="pill pill-green">Active</span>}
                      {u.two_factor_enabled && <div className="person-role">Two-factor on</div>}
                    </td>
                    <td className="right">
                      <div className="btn-row" style={{ justifyContent: 'flex-end' }}>
                        {u.awaiting_first_sign_in && (
                          <button className="btn btn-sm" onClick={() => reinvite(u)}>
                            {u.invite_expires_at ? 'Resend' : 'Invite'}
                          </button>
                        )}
                        {u.user_id !== user?.userId && (
                          <>
                            <button className="btn btn-sm"
                              onClick={() => { setRoleTarget(u); setNewRole(u.role); }}>Role</button>
                            {u.two_factor_enabled && (
                              <button className="btn btn-sm"
                                onClick={() => setTwoFactorTarget(u)}>Reset 2FA</button>
                            )}
                            <button className={`btn btn-sm${u.is_active ? ' btn-danger' : ''}`}
                              onClick={() => setStatusTarget({ user: u, isActive: !u.is_active })}>
                              {u.is_active ? 'Suspend' : 'Reinstate'}
                            </button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
      </Card>

      {statusTarget && (
        <ReasonModal
          title={statusTarget.isActive ? 'Reinstate this account' : 'Suspend this account'}
          intent={statusTarget.isActive
            ? `${statusTarget.user.full_name} will be able to sign in again.`
            : `${statusTarget.user.full_name} will be signed out immediately and will not be able to sign in.`}
          confirmLabel={statusTarget.isActive ? 'Reinstate' : 'Suspend'}
          danger={!statusTarget.isActive}
          onClose={() => setStatusTarget(null)}
          onConfirm={applyStatus} />
      )}

      {roleTarget && (
        <ReasonModal
          title={`Change role — ${roleTarget.full_name}`}
          intent="Changing a role signs the person out, so their navigation matches their new access when they return."
          confirmLabel="Change role"
          extra={
            <Field label="New role" required>
              <select value={newRole} onChange={(e) => setNewRole(e.target.value)}>
                <option value="ADMINISTRATOR">Administrator</option>
                <option value="RECRUITER">Recruiter</option>
                <option value="CONSULTANT">Consultant</option>
                <option value="CLIENT_MANAGER">Client manager</option>
              </select>
            </Field>
          }
          onClose={() => setRoleTarget(null)}
          onConfirm={applyRole} />
      )}

      {twoFactorTarget && (
        <ReasonModal
          title={`Reset two-factor — ${twoFactorTarget.full_name}`}
          intent="They will be signed out everywhere and must set two-factor up again from scratch."
          confirmLabel="Reset two-factor"
          danger
          minChars={10}
          hint="At least 10 characters. Recorded in the audit log against your name."
          onClose={() => setTwoFactorTarget(null)}
          onConfirm={applyTwoFactorReset} />
      )}

      {adding && (
        <CreateUser
          onClose={() => setAdding(false)}
          onCreated={(name, inviteLink) => {
            setAdding(false);
            list.reload();
            setMsg({ kind: 'success', text: `${name} was created and invited.` });
            if (inviteLink) setLink(inviteLink);
          }} />
      )}
    </>
  );
}

function CreateUser({
  onClose, onCreated,
}: { onClose: () => void; onCreated: (name: string, link?: string) => void }) {
  const err = useFormError();
  const [busy, setBusy] = useState(false);
  const linkable = useLoad<any>(() => api.get('/users/linkable'));
  const [f, setF] = useState({
    fullName: '', email: '', phone: '', role: 'RECRUITER',
    consultantId: '', contactId: '',
  });
  const set = (k: string, v: string) => setF((p) => ({ ...p, [k]: v }));

  async function save() {
    setBusy(true); err.clear();
    try {
      const r = await api.post<any>('/users', {
        fullName: f.fullName,
        email: f.email,
        phone: f.phone || undefined,
        role: f.role,
        consultantId: f.role === 'CONSULTANT' ? f.consultantId || undefined : undefined,
        contactId: f.role === 'CLIENT_MANAGER' ? f.contactId || undefined : undefined,
      });
      onCreated(f.fullName, r.inviteLink);
    } catch (e) { err.capture(e); } finally { setBusy(false); }
  }

  return (
    <Modal title="Create an account" onClose={onClose}
      footer={<>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" onClick={save} disabled={busy}>
          {busy ? 'Creating…' : 'Create and invite'}
        </button>
      </>}>
      {err.error && <Alert kind="error">{err.error}</Alert>}

      <div className="form-row">
        <Field label="Full name" required error={err.fieldError('fullName')}>
          <input value={f.fullName} onChange={(e) => set('fullName', e.target.value)} />
        </Field>
        <Field label="Email address" required error={err.fieldError('email')}
          hint="The invitation is sent here">
          <input type="email" value={f.email} onChange={(e) => set('email', e.target.value)} />
        </Field>
      </div>

      <div className="form-row">
        <Field label="Phone">
          <input value={f.phone} onChange={(e) => set('phone', e.target.value)} />
        </Field>
        <Field label="Role" required>
          <select value={f.role} onChange={(e) => set('role', e.target.value)}>
            <option value="ADMINISTRATOR">Administrator</option>
            <option value="RECRUITER">Recruiter</option>
            <option value="CONSULTANT">Consultant</option>
            <option value="CLIENT_MANAGER">Client manager</option>
          </select>
        </Field>
      </div>

      {f.role === 'CONSULTANT' && (
        <Field label="Consultant record" required error={err.fieldError('consultantId')}
          hint="A consultant must already be in the pool before they are given access.">
          <select value={f.consultantId} onChange={(e) => set('consultantId', e.target.value)}>
            <option value="">Choose a consultant</option>
            {(linkable.data?.consultants ?? []).map((c: any) => (
              <option key={c.consultant_id} value={c.consultant_id}>
                {c.full_name} — {c.email}
              </option>
            ))}
          </select>
        </Field>
      )}

      {f.role === 'CLIENT_MANAGER' && (
        <Field label="Client contact" required error={err.fieldError('contactId')}
          hint="Ties the account to one client company, so they see only its data.">
          <select value={f.contactId} onChange={(e) => set('contactId', e.target.value)}>
            <option value="">Choose a contact</option>
            {(linkable.data?.contacts ?? []).map((c: any) => (
              <option key={c.contact_id} value={c.contact_id}>
                {c.client_name} — {c.first_name} {c.last_name}
              </option>
            ))}
          </select>
        </Field>
      )}

      <Alert kind="info">
        No password is set here. The person receives an invitation valid for 72 hours
        and chooses their own, so nobody else ever knows it.
      </Alert>
    </Modal>
  );
}
