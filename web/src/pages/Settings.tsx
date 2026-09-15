import { useState } from 'react';
import { api, useLoad, Card, Loading, Alert, Field } from '../lib';

/** Configuration is data, so it changes without a deployment (NFR-MNT-001). */
export default function Settings() {
  const s = useLoad<any>(() => api.get('/settings'));
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function saveOne(key: string) {
    setBusy(true);
    try {
      await api.put(`/settings/${key}`, { value: edits[key] });
      setMsg(`Updated ${key.replace(/_/g, ' ')}.`);
      setEdits((e) => { const n = { ...e }; delete n[key]; return n; });
      s.reload();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Could not save');
    } finally { setBusy(false); }
  }

  if (s.loading) return <Loading />;
  if (s.error) return <Alert kind="error">{s.error}</Alert>;

  return (
    <>
      {msg && <Alert kind="success">{msg}</Alert>}
      <Card title="System settings"
        subtitle="Timesheet cycle, reminders, alert thresholds and company details">
        <table>
          <thead><tr><th>Setting</th><th>Value</th><th>Description</th><th></th></tr></thead>
          <tbody>
            {s.data.items.map((row: any) => {
              const dirty = edits[row.setting_key] !== undefined;
              return (
                <tr key={row.setting_key}>
                  <td><strong>{row.setting_key.replace(/_/g, ' ')}</strong></td>
                  <td style={{ maxWidth: 220 }}>
                    <input value={dirty ? edits[row.setting_key] : row.setting_value}
                      onChange={(e) => setEdits((p) => ({ ...p, [row.setting_key]: e.target.value }))} />
                  </td>
                  <td className="muted small">{row.description}</td>
                  <td className="right">
                    {dirty && (
                      <button className="btn btn-primary btn-sm" disabled={busy}
                        onClick={() => saveOne(row.setting_key)}>Save</button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Card>
    </>
  );
}
