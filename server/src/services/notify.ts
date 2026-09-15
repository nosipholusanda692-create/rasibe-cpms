import type { PoolClient } from 'pg';

/**
 * Notification dispatch.
 *
 * Requirement FR-NOT-003 states that a failure to deliver must never roll back
 * a business transaction. Notifications are therefore written to the
 * notification table inside the caller's transaction and delivered afterwards
 * by a separate worker. With no SMTP host configured the row is the delivery,
 * which is the documented development behaviour.
 */
export type NotifyEvent =
  | 'TIMESHEET_DUE' | 'TIMESHEET_OVERDUE' | 'TIMESHEET_AWAITING_APPROVAL'
  | 'TIMESHEET_APPROVED' | 'TIMESHEET_REJECTED' | 'INVOICE_ISSUED'
  | 'REQUEST_RAISED' | 'SUBMISSION_OUTCOME' | 'PLACEMENT_ENDING'
  | 'DOCUMENT_EXPIRING' | 'ACCOUNT_CREATED' | 'PASSWORD_RESET';

interface QueueArgs {
  event: NotifyEvent;
  recipientUserId?: string | null;
  recipientEmail?: string | null;
  vars?: Record<string, string | number>;
  relatedTable?: string;
  relatedId?: string;
  leadDays?: number;
}

function fill(text: string, vars: Record<string, string | number> = {}): string {
  return text.replace(/\{\{(\w+)\}\}/g, (_m, k) => String(vars[k] ?? ''));
}

export async function queueNotification(client: PoolClient, args: QueueArgs): Promise<void> {
  const tpl = await client.query(
    `SELECT subject, body FROM notification_template
      WHERE event = $1 AND channel = 'EMAIL' AND lead_days = $2 AND is_active
      LIMIT 1`,
    [args.event, args.leadDays ?? 0],
  );

  const subject = tpl.rows[0] ? fill(tpl.rows[0].subject, args.vars) : args.event;
  const body = tpl.rows[0] ? fill(tpl.rows[0].body, args.vars) : JSON.stringify(args.vars ?? {});

  await client.query(
    `INSERT INTO notification (event, channel, recipient_user_id, recipient_email,
                               subject, body, related_table, related_id)
     VALUES ($1,'EMAIL',$2,$3,$4,$5,$6,$7)`,
    [args.event, args.recipientUserId ?? null, args.recipientEmail ?? null,
     subject, body, args.relatedTable ?? null, args.relatedId ?? null],
  );
}

/** Records an entry in the append-only audit log (BR-020). */
export async function audit(
  client: PoolClient,
  args: {
    actorUserId: string;
    action: string;
    entityTable: string;
    entityId?: string;
    previous?: unknown;
    next?: unknown;
    reason?: string;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO audit_entry (actor_user_id, action, entity_table, entity_id,
                              previous_value, new_value, reason)
     VALUES ($1,$2::audit_action_enum,$3,$4,$5,$6,$7)`,
    [args.actorUserId, args.action, args.entityTable, args.entityId ?? null,
     args.previous ? JSON.stringify(args.previous) : null,
     args.next ? JSON.stringify(args.next) : null,
     args.reason ?? null],
  );
}
