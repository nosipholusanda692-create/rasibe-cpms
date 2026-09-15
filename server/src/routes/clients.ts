import { Router } from 'express';
import { z } from 'zod';
import { query, withActor } from '../lib/db.js';
import { badRequest, notFound, project, assertCapability } from '../lib/errors.js';
import { requireAuth, requireInternal } from '../middleware/auth.js';

export const clientsRouter = Router();

/** Row-level security limits a client manager to their own company (BR-013). */
clientsRouter.get('/', requireAuth, async (req, res, next) => {
  try {
    const q = z.object({ search: z.string().optional() }).parse(req.query);
    const rows = await query<any>(
      req.actor!,
      `SELECT c.client_id, c.legal_name, c.trading_name, c.registration_number, c.vat_number,
              c.industry, c.billing_address, c.payment_terms_days, c.is_active,
              (SELECT count(*)::int FROM placement p
                WHERE p.client_id = c.client_id AND p.status IN ('ACTIVE','ENDING_SOON')) AS active_placements,
              (SELECT count(*)::int FROM resource_request r
                WHERE r.client_id = c.client_id AND r.status IN ('OPEN','SHORTLISTING','INTERVIEWING')) AS open_requests,
              coalesce((SELECT json_agg(json_build_object(
                  'contactId', cc.contact_id, 'firstName', cc.first_name, 'lastName', cc.last_name,
                  'jobTitle', cc.job_title, 'email', cc.email, 'phone', cc.phone,
                  'isApprover', cc.is_timesheet_approver, 'isPrimary', cc.is_primary))
                FROM client_contact cc WHERE cc.client_id = c.client_id AND cc.is_active), '[]') AS contacts
         FROM client_company c
        WHERE ($1::text IS NULL OR c.legal_name ILIKE '%'||$1||'%')
        ORDER BY c.legal_name`,
      [q.search ?? null],
    );
    res.json({ items: project(req.actor!.role, rows) });
  } catch (e) { next(e); }
});

clientsRouter.get('/:id', requireAuth, async (req, res, next) => {
  try {
    const id = z.string().uuid().parse(req.params.id);
    const rows = await query<any>(
      req.actor!,
      `SELECT c.*,
              coalesce((SELECT json_agg(json_build_object(
                  'contactId', cc.contact_id, 'firstName', cc.first_name, 'lastName', cc.last_name,
                  'jobTitle', cc.job_title, 'email', cc.email, 'phone', cc.phone,
                  'isApprover', cc.is_timesheet_approver, 'isPrimary', cc.is_primary))
                FROM client_contact cc WHERE cc.client_id = c.client_id AND cc.is_active), '[]') AS contacts,
              coalesce((SELECT json_agg(json_build_object(
                  'rateCardId', rc.rate_card_id, 'name', rc.name,
                  'effectiveFrom', rc.effective_from, 'isActive', rc.is_active))
                FROM rate_card rc WHERE rc.client_id = c.client_id), '[]') AS rate_cards
         FROM client_company c WHERE c.client_id = $1`,
      [id],
    );
    if (!rows.length) throw notFound('Client not found');
    res.json(project(req.actor!.role, rows[0]));
  } catch (e) { next(e); }
});

const clientBody = z.object({
  legalName: z.string().min(2, 'Enter the registered name'),
  tradingName: z.string().optional(),
  registrationNumber: z.string().optional(),
  vatNumber: z.string().optional(),
  industry: z.string().optional(),
  physicalAddress: z.string().optional(),
  billingAddress: z.string().optional(),
  paymentTermsDays: z.number().min(0).max(180).default(30),
});

clientsRouter.post('/', requireInternal, async (req, res, next) => {
  try {
    assertCapability(req.actor!.role, 'manage_clients');
    const parsed = clientBody.safeParse(req.body);
    if (!parsed.success) throw badRequest('Check the details you entered', parsed.error.flatten().fieldErrors);
    const b = parsed.data;
    const rows = await query<any>(
      req.actor!,
      `INSERT INTO client_company (legal_name, trading_name, registration_number, vat_number,
                                   industry, physical_address, billing_address, payment_terms_days)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [b.legalName, b.tradingName ?? null, b.registrationNumber ?? null, b.vatNumber ?? null,
       b.industry ?? null, b.physicalAddress ?? null, b.billingAddress ?? null, b.paymentTermsDays],
    );
    res.status(201).json(rows[0]);
  } catch (e) { next(e); }
});

clientsRouter.post('/:id/contacts', requireInternal, async (req, res, next) => {
  try {
    const id = z.string().uuid().parse(req.params.id);
    const b = z.object({
      firstName: z.string().min(1), lastName: z.string().min(1),
      jobTitle: z.string().optional(), email: z.string().email(),
      phone: z.string().optional(),
      isTimesheetApprover: z.boolean().default(false),
      isPrimary: z.boolean().default(false),
    }).parse(req.body);
    const rows = await query<any>(
      req.actor!,
      `INSERT INTO client_contact (client_id, first_name, last_name, job_title, email, phone,
                                   is_timesheet_approver, is_primary)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [id, b.firstName, b.lastName, b.jobTitle ?? null, b.email, b.phone ?? null,
       b.isTimesheetApprover, b.isPrimary],
    );
    res.status(201).json(rows[0]);
  } catch (e) { next(e); }
});
