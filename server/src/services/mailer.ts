import nodemailer, { type Transporter } from 'nodemailer';

/**
 * Email delivery.
 *
 * Until now notifications were written to the notification table and left
 * there, which meant an approver was never actually told a timesheet was
 * waiting and a reset link never reached anybody. This sends them.
 *
 * With no SMTP_HOST configured the transport logs instead of sending, so a
 * developer machine needs no mail server and nothing silently fails.
 */

export type DeliveryOutcome = 'sent' | 'logged' | 'failed';

export interface Message {
  to: string;
  subject: string;
  body: string;
}

let transport: Transporter | null = null;
let configured: boolean | null = null;

export function mailConfigured(): boolean {
  if (configured === null) {
    configured = Boolean(process.env.SMTP_HOST && process.env.SMTP_HOST.trim());
  }
  return configured;
}

function getTransport(): Transporter | null {
  if (!mailConfigured()) return null;
  if (transport) return transport;

  const port = Number(process.env.SMTP_PORT ?? 587);

  transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    // 465 is implicit TLS; 587 upgrades with STARTTLS, which is the usual choice
    secure: port === 465,
    auth: process.env.SMTP_USER
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD }
      : undefined,
    // a stuck connection must not hold up the rest of the queue
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });

  return transport;
}

/** Confirms the server is reachable and the credentials are accepted. */
export async function verifyMail(): Promise<{ ok: boolean; detail: string }> {
  const t = getTransport();
  if (!t) return { ok: false, detail: 'No SMTP_HOST configured; notifications are logged only.' };
  try {
    await t.verify();
    return { ok: true, detail: `Connected to ${process.env.SMTP_HOST} as ${process.env.SMTP_USER ?? 'anonymous'}.` };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : 'Could not reach the mail server' };
  }
}

/**
 * Sends one message.
 *
 * Never throws. A delivery failure is reported, recorded against the
 * notification and retried later; it must never interfere with the business
 * transaction that raised it (FR-NOT-003).
 */
export async function sendMail(m: Message): Promise<{ outcome: DeliveryOutcome; detail: string }> {
  const from = process.env.MAIL_FROM ?? 'no-reply@rasibe.co.za';
  const t = getTransport();

  if (!t) {
    console.log(`[mail:logged] to=${m.to} subject=${m.subject}`);
    return { outcome: 'logged', detail: 'No SMTP host configured' };
  }

  try {
    const info = await t.sendMail({
      from,
      to: m.to,
      subject: m.subject,
      text: m.body,
      html: asHtml(m),
    });
    return { outcome: 'sent', detail: info.messageId ?? 'sent' };
  } catch (e) {
    const detail = e instanceof Error ? e.message : 'Unknown delivery failure';
    console.warn(`[mail:failed] to=${m.to} subject=${m.subject} — ${detail}`);
    return { outcome: 'failed', detail };
  }
}

/**
 * A plain, readable message rather than a designed one.
 *
 * Several of these carry a link that sets a password, so anything that looks
 * like marketing is the wrong note, and heavy HTML is what spam filters dislike
 * most. Links are left as visible text so the recipient can see where they lead.
 */
function asHtml(m: Message): string {
  const escape = (v: string) =>
    v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const body = escape(m.body)
    .replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>')
    .replace(/\n/g, '<br />');

  return `<!doctype html>
<html><body style="margin:0;background:#f5f7f9;padding:24px;
  font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#1f2933">
  <div style="max-width:560px;margin:0 auto;background:#fff;border:1px solid #e2e8ed;border-radius:8px">
    <div style="padding:16px 20px;border-bottom:1px solid #eef2f6">
      <strong style="color:#1f4e5f">Rasibe Global Solutions</strong>
      <div style="font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#8a959e">
        Consultant placement management
      </div>
    </div>
    <div style="padding:20px;font-size:14px;line-height:1.55">${body}</div>
    <div style="padding:14px 20px;border-top:1px solid #eef2f6;font-size:12px;color:#8a959e">
      This message was sent by the Rasibe placement system. If you were not expecting it,
      you can ignore it — no action is taken unless you follow a link in it.
    </div>
  </div>
</body></html>`;
}
