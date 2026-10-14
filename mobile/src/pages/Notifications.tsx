import { api, useLoad, Banner, Loading, Empty, titleCase } from '../lib';

export default function Notifications() {
  const list = useLoad<any>(() => api.get('/notifications'));

  async function markRead(id: string) {
    try { await api.post(`/notifications/${id}/read`); list.reload(); } catch { /* ignore */ }
  }

  return (
    <div className="screen has-tabs">
      <header className="appbar">
        <div className="brand-mark">R</div>
        <h1>Notifications</h1>
      </header>

      {list.loading ? <Loading />
        : list.error ? <Banner kind="error">{list.error}</Banner>
        : !list.data?.items?.length ? <Empty>Nothing yet.</Empty>
        : (
          <section className="card">
            {list.data.items.map((n: any) => (
              <div className="list-row" key={n.notification_id}
                onClick={() => !n.read_at && markRead(n.notification_id)}>
                <div className="stack" style={{ flex: 1 }}>
                  <span className="sheet-title">{n.subject}</span>
                  <span className="sheet-sub">{n.body}</span>
                  <span className="sheet-sub">
                    {titleCase(n.event)} · {new Date(n.scheduled_for).toLocaleString('en-ZA')}
                  </span>
                </div>
                {!n.read_at && <span className="pill pill-blue">New</span>}
              </div>
            ))}
          </section>
        )}
    </div>
  );
}
