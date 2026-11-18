import { Router } from 'express';
import { z } from 'zod';
import { query, withActor } from '../lib/db.js';
import { badRequest, notFound, conflict, project, assertCapability } from '../lib/errors.js';
import { requireAuth, requireInternal } from '../middleware/auth.js';
import { searchText, fieldErrors } from '../lib/validation.js';

export const clientsRouter = Router();

/** Row-level security limits a client manager to their own company (BR-013). */
clientsRouter.get('/', requireAuth, async (req, res, next) => {
  try {
    const q = z.object({ search: searchText.optional() }).parse(req.query);
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
    const id = z.guid().parse(req.params.id);
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
}).strict();

clientsRouter.post('/', requireInternal, async (req, res, next) => {
  try {
    assertCapability(req.actor!.role, 'manage_clients');
    const parsed = clientBody.safeParse(req.body);
    if (!parsed.success) throw badRequest('Check the details you entered', fieldErrors(parsed.error));
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

/**
 * A contact at a client company. This is who a client-manager account is
 * linked to (the user form offers contacts that have no account yet), so a
 * client added without one can never be given a login.
 *
 * Lengths match the columns. A company has one primary contact: naming a new
 * one moves the flag, and the first contact a company gets is the primary
 * whether or not it was asked for.
 */
const contactBody = z.object({
  firstName: z.string().trim().min(1, 'Enter a first name').max(100, 'Keep the first name under 100 characters'),
  lastName: z.string().trim().min(1, 'Enter a last name').max(100, 'Keep the last name under 100 characters'),
  jobTitle: z.string().trim().max(120, 'Keep the job title under 120 characters').optional(),
  email: z.string().trim().toLowerCase().max(255, 'That email address is too long')
    .email('Enter a valid email address'),
  phone: z.string().trim().regex(/^[0-9+\s()-]{6,20}$/, 'Enter a valid phone number').optional(),
  isTimesheetApprover: z.boolean().default(false),
  isPrimary: z.boolean().default(false),
}).strict();

clientsRouter.post('/:id/contacts', requireInternal, async (req, res, next) => {
  try {
    assertCapability(req.actor!.role, 'manage_clients');
    const id = z.guid().parse(req.params.id);
    const parsed = contactBody.safeParse(req.body);
    if (!parsed.success) throw badRequest('Check the details you entered', fieldErrors(parsed.error));
    const b = parsed.data;

    const created = await withActor(req.actor!, async (c) => {
      const company = await c.query(`SELECT client_id FROM client_company WHERE client_id = $1 FOR UPDATE`, [id]);
      if (!company.rows.length) throw notFound('Client not found');

      // The table is unique on company and address, retired contacts included,
      // so say so rather than let a constraint name reach the screen.
      const same = await c.query(
        `SELECT is_active FROM client_contact WHERE client_id = $1 AND email = $2`, [id, b.email]);
      if (same.rows.length) {
        throw conflict('Check the details you entered', {
          email: [same.rows[0].is_active
            ? 'This company already has a contact with that email address'
            : 'A former contact at this company used that email address'],
        });
      }

      const live = await c.query(
        `SELECT count(*)::int AS n FROM client_contact WHERE client_id = $1 AND is_active`, [id]);
      const primary = b.isPrimary || live.rows[0].n === 0;
      if (primary) {
        await c.query(`UPDATE client_contact SET is_primary = false WHERE client_id = $1 AND is_primary`, [id]);
      }
      const r = await c.query(
        `INSERT INTO client_contact (client_id, first_name, last_name, job_title, email, phone,
                                     is_timesheet_approver, is_primary)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [id, b.firstName, b.lastName, b.jobTitle || null, b.email, b.phone || null,
         b.isTimesheetApprover, primary]);
      return r.rows[0];
    });
    res.status(201).json(created);
  } catch (e) { next(e); }
});
