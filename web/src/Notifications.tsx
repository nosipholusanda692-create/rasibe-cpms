import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from './lib';

/**
 * The notification bell (FR-NOT-005).
 *
 * Email reaches people who are not signed in, which is most of the time for a
 * consultant or a client manager. An administrator is usually in the
 * application, and a placement ending in fourteen days should not depend on
 * them noticing an email.
 *
 * The count is polled on its own because it is one cheap integer; the list is
 * fetched only when the panel is opened. Polling the whole list every minute
 * to show a number would be wasteful for something nobody is looking at.
 */

interface Notification {
  notification_id: string;
  event: string;
  subject: string;
  body: string;
  related_table: string | null;
  related_id: string | null;
  scheduled_for: string;
  read_at: string | null;
}

const POLL_SECONDS = 60;

/** Where a notification leads, when it concerns something with a screen. */
function destinationFor(n: Notification): string | null {
  switch (n.related_table) {
    case 'timesheet': return '/timesheets';
    case 'placement': return '/placements';
    case 'resource_request': return n.related_id ? `/requests/${n.related_id}` : '/requests';
    case 'invoice': return n.related_id ? `/invoices/${n.related_id}` : '/invoices';
    case 'submission': return '/requests';
    case 'certification':
    case 'consultant': return '/consultants';
    default: return null;
  }
}

function whenText(iso: string): string {
  const then = new Date(iso).getTime();
  const minutes = Math.floor((Date.now() - then) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} day${days === 1 ? '' : 's'} ago`;
  return new Date(iso).toLocaleDateString('en-ZA', { day: '2-digit', month: 'short' });
}

export default function NotificationBell() {
  const nav = useNavigate();
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Notification[]>([]);
  const [loading, setLoading] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  const refreshCount = useCallback(async () => {
    try {
      const r = await api.get<{ unread: number }>('/notifications/unread-count');
      setUnread(r.unread);
    } catch {
      // a failed poll is not worth reporting; the next one will succeed
    }
  }, []);

  useEffect(() => {
    void refreshCount();
    const t = setInterval(() => { void refreshCount(); }, POLL_SECONDS * 1000);
    return () => clearInterval(t);
  }, [refreshCount]);

  // the list is fetched when the panel opens, not before
  useEffect(() => {
    if (!open) return;
    setLoading(true);
    api.get<{ items: Notification[] }>('/notifications')
      .then((r) => setItems(r.items))
      .catch(() => setItems([]))
      .finally(() => setLoading(false));
  }, [open]);

  // closing on Escape as well as on a click away, because a panel that traps
  // the keyboard is worse than one that is slightly eager to close
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  async function openItem(n: Notification) {
    if (!n.read_at) {
      setItems((list) => list.map((x) =>
        x.notification_id === n.notification_id
          ? { ...x, read_at: new Date().toISOString() } : x));
      setUnread((u) => Math.max(0, u - 1));
      try { await api.post(`/notifications/${n.notification_id}/read`); } catch { /* ignore */ }
    }

    const to = destinationFor(n);
    if (to) { setOpen(false); nav(to); }
  }

  async function markAllRead() {
    setItems((list) => list.map((x) => ({ ...x, read_at: x.read_at ?? new Date().toISOString() })));
    setUnread(0);
    try { await api.post('/notifications/read-all'); } catch { void refreshCount(); }
  }

  return (
    <div style={{ position: 'relative' }} ref={panelRef}>
      <button
        className={`bell${unread > 0 ? ' has-unread' : ''}`}
        onClick={() => setOpen((v) => !v)}
        aria-label={unread > 0 ? `${unread} unread notifications` : 'Notifications'}
        title="Notifications"
      >
        ◉
        {unread > 0 && <span className="bell-count">{unread > 99 ? '99+' : unread}</span>}
      </button>

      {open && (
        <>
          <div className="bell-backdrop" onClick={() => setOpen(false)} />
          <div className="bell-panel">
            <div className="bell-head">
              <h3>Notifications</h3>
              <div className="spacer" />
              {unread > 0 && (
                <button className="btn btn-sm" onClick={markAllRead}>Mark all read</button>
              )}
            </div>

            <div className="bell-list">
              {loading ? (
                <div className="loading">Loading…</div>
              ) : !items.length ? (
                <div className="empty">Nothing yet.</div>
              ) : (
                items.slice(0, 30).map((n) => (
                  <button
                    key={n.notification_id}
                    className={`bell-item${n.read_at ? '' : ' unread'}`}
                    onClick={() => openItem(n)}
                  >
                    <div className="bell-subject">
                      {!n.read_at && <span className="bell-dot" />}
                      {n.subject}
                    </div>
                    <div className="bell-body">{n.body}</div>
                    <div className="bell-when">
                      {whenText(n.scheduled_for)}
                      {destinationFor(n) && ' · opens the record'}
                    </div>
                  </button>
                ))
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
