import { Link } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { useAuth, useLoad, api, readQueue, fmtDate, titleCase, Banner, Empty } from '../lib';

/** Account, placements and anything still held on the device. */
export default function Profile() {
  const { user, twoFactor, signOut } = useAuth();
  const placements = useLoad<any>(() => api.get('/placements'));
  const queued = readQueue();
  const [editingAvailability, setEditingAvailability] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);

  return (
    <div className="screen has-tabs">
      <header className="appbar">
        <div className="brand-mark">R</div>
        <h1>Account</h1>
      </header>

      <section className="card">
        <div className="card-body">
          <div className="sheet-title">{user?.fullName}</div>
          <div className="sheet-sub">{user?.email}</div>
          <div className="sheet-sub">{titleCase(user?.role)}</div>
        </div>
      </section>

      <section className="card">
        <Link to="/account/security" className="list-row link-row">
          <div className="stack" style={{ flex: 1 }}>
            <span className="sheet-title">Sign-in security</span>
            <span className="sheet-sub">
              {twoFactor.enabled
                ? 'Two-factor authentication is on'
                : 'Add a code from an app to protect your account'}
            </span>
          </div>
          <span className={`pill pill-${twoFactor.enabled ? 'green' : 'grey'}`}>
            {twoFactor.enabled ? 'On' : 'Off'}
          </span>
        </Link>
      </section>

      {queued.length > 0 && (
        <section className="card">
          <div className="card-head"><h2>Waiting to send</h2></div>
          {queued.map((q) => (
            <div className="list-row" key={q.clientUuid}>
              <div className="stack" style={{ flex: 1 }}>
                <span className="sheet-title">{q.label}</span>
                <span className="sheet-sub">
                  {q.lines.length} day{q.lines.length === 1 ? '' : 's'} · saved {fmtDate(q.queuedAt)}
                </span>
              </div>
              <span className="pill pill-amber">Pending</span>
            </div>
          ))}
          <div className="card-body small muted">
            These are held on this phone and sent automatically when you are online.
          </div>
        </section>
      )}

      {flash && <Banner kind="ok">{flash}</Banner>}

      {/* FR-MOB-002 — a consultant keeps their own availability current.
          It is the one thing a recruiter cannot know without asking. */}
      {user?.role === 'CONSULTANT' && user.consultantId && (
        <Availability
          consultantId={user.consultantId}
          open={editingAvailability}
          onOpen={() => setEditingAvailability(true)}
          onClose={() => setEditingAvailability(false)}
          onSaved={(text) => { setEditingAvailability(false); setFlash(text); }} />
      )}

      {user?.role === 'CONSULTANT' && (
        <section className="card">
          <div className="card-head"><h2>My placements</h2></div>
          {placements.loading ? <div className="loading">Loading…</div>
            : !placements.data?.items?.length ? <Empty>No placements.</Empty>
            : placements.data.items.map((p: any) => (
              <div className="list-row" key={p.placement_id}>
                <div className="stack" style={{ flex: 1 }}>
                  <span className="sheet-title">{p.client_name}</span>
                  <span className="sheet-sub">{p.job_title}</span>
                  <span className="sheet-sub">
                    {fmtDate(p.start_date)} – {fmtDate(p.end_date)}
                  </span>
                </div>
                <span className={`pill pill-${p.status === 'ACTIVE' ? 'green' : 'amber'}`}>
                  {titleCase(p.status)}
                </span>
              </div>
            ))}
          <div className="card-body">
            <Banner kind="pending">
              Your placement shows the rate you are paid. The rate charged to the client is held
              on the agency side and is not part of your record.
            </Banner>
          </div>
        </section>
      )}

      <section className="card">
        <div className="card-body">
          <button className="btn btn-block" onClick={signOut}>Sign out</button>
        </div>
      </section>
    </div>
  );
}

/**
 * The consultant's own availability.
 *
 * While they are on a placement the system derives this from the placement
 * records, so it cannot drift. What a consultant can usefully say is when they
 * become free, which nobody else knows.
 */
function Availability({
  consultantId, open, onOpen, onClose, onSaved,
}: {
  consultantId: string;
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  onSaved: (text: string) => void;
}) {
  const me = useLoad<any>(() => api.get(`/consultants/${consultantId}`), [consultantId]);
  const [availability, setAvailability] = useState('AVAILABLE');
  const [availableFrom, setAvailableFrom] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!me.data) return;
    setAvailability(me.data.availability ?? 'AVAILABLE');
    setAvailableFrom(me.data.available_from?.slice(0, 10) ?? '');
  }, [me.data]);

  const needsDate = availability === 'AVAILABLE_FROM';
  const canSave = !needsDate || availableFrom !== '';

  async function save() {
    if (!canSave) { setError('Give the date you become available'); return; }
    setBusy(true); setError(null);
    try {
      await api.patch(`/consultants/${consultantId}`, {
        availability,
        availableFrom: needsDate ? availableFrom : null,
      });
      me.reload();
      onSaved('Availability updated. Your recruiter sees this straight away.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not update your availability');
    } finally { setBusy(false); }
  }

  if (me.loading) return null;

  const current = me.data?.availability;
  const onPlacement = current === 'ON_PLACEMENT';

  return (
    <section className="card">
      <div className="card-head">
        <div style={{ flex: 1 }}>
          <h2>My availability</h2>
          <div className="sub">What your recruiter sees when matching</div>
        </div>
        {!open && !onPlacement && (
          <button className="btn btn-ghost" onClick={onOpen}>Change</button>
        )}
      </div>

      {!open ? (
        <div className="list-row">
          <div className="stack" style={{ flex: 1 }}>
            <span className="sheet-title">{titleCase(current)}</span>
            {me.data?.available_from && (
              <span className="sheet-sub">From {fmtDate(me.data.available_from)}</span>
            )}
            {onPlacement && (
              <span className="sheet-sub">
                Set from your placement records. It changes on its own when the placement ends.
              </span>
            )}
          </div>
          <span className={`pill pill-${current === 'AVAILABLE' ? 'green'
            : current === 'ON_PLACEMENT' ? 'blue'
            : current === 'AVAILABLE_FROM' ? 'amber' : 'grey'}`}>
            {titleCase(current)}
          </span>
        </div>
      ) : (
        <>
          {error && <div style={{ padding: '0 14px' }}><Banner kind="error">{error}</Banner></div>}
          <div className="card-body">
            <div className="field">
              <label>I am</label>
              <select value={availability} onChange={(e) => setAvailability(e.target.value)}>
                <option value="AVAILABLE">Available now</option>
                <option value="AVAILABLE_FROM">Available from a date</option>
                <option value="NOT_AVAILABLE">Not available</option>
              </select>
            </div>

            {needsDate && (
              <div className="field">
                <label>Available from</label>
                <input type="date" value={availableFrom}
                  aria-invalid={error && !availableFrom ? true : undefined}
                  onChange={(e) => setAvailableFrom(e.target.value)} />
                <div className="field-hint">
                  The first day you could start somewhere new.
                </div>
              </div>
            )}
          </div>
          <div className="card-body" style={{ paddingTop: 0, display: 'flex', gap: 10 }}>
            <button className="btn btn-grow" onClick={onClose} disabled={busy}>Cancel</button>
            <button className="btn btn-primary btn-grow" onClick={save} disabled={busy}>
              {busy ? 'Saving…' : 'Save'}
            </button>
          </div>
        </>
      )}
    </section>
  );
}
