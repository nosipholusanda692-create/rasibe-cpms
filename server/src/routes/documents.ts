import { Router } from 'express';
import multer from 'multer';
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { query, withActor } from '../lib/db.js';
import { badRequest, notFound, forbidden, AppError } from '../lib/errors.js';
import { requireAuth, requireInternal, requireAdmin } from '../middleware/auth.js';
import { audit } from '../services/notify.js';
import {
  check, store, retrieve, safeName, restrictedByType, MAX_BYTES, ACCEPTED,
} from '../lib/documents.js';

export const documentsRouter = Router();

/**
 * Documents (FR-DOC-001 to 004, 007, NFR-SEC-009).
 *
 * A consultant record is of no use to a recruiter without the CV, and a
 * placement is not evidence without the signed contract. Until now the system
 * recorded that a document existed and could not hold it.
 */

// Held in memory rather than written to a temporary file: the limit is 10 MB,
// and a file that fails its checks should never reach a disk at all.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES, files: 1 },
});

const DOC_TYPES = ['CV', 'CONTRACT', 'CERTIFICATION', 'VETTING', 'ID_DOCUMENT', 'OTHER'] as const;
const TOKEN_MINUTES = 5;

const digest = (v: string) => createHash('sha256').update(v).digest();

/** What a role may see, expressed once. */
function mayRead(role: string, doc: { is_restricted: boolean; consultant_id: string | null },
  ownConsultantId: string | null): boolean {
  if (role === 'ADMINISTRATOR') return true;
  if (doc.is_restricted) return false;                       // BR-015
  if (role === 'RECRUITER') return true;
  if (role === 'CONSULTANT') return doc.consultant_id === ownConsultantId;
  return false;                                              // a client manager sees none
}

// ---------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------
documentsRouter.get('/', requireAuth, async (req, res, next) => {
  try {
    const q = z.object({
      consultantId: z.string().uuid().optional(),
      placementId: z.string().uuid().optional(),
      includeSuperseded: z.coerce.boolean().default(false),
    }).parse(req.query);

    const params: unknown[] = [];
    const where: string[] = ['1=1'];
    if (q.consultantId) { params.push(q.consultantId); where.push(`d.consultant_id = $${params.length}`); }
    if (q.placementId) { params.push(q.placementId); where.push(`d.placement_id = $${params.length}`); }
    if (!q.includeSuperseded) where.push('d.is_current');

    // Row-level security already limits which documents are visible; the
    // restricted ones simply do not come back for anybody but an administrator.
    const rows = await query<any>(
      req.actor!,
      `SELECT d.document_id, d.doc_type, d.file_name, d.original_name, d.mime_type,
              d.size_bytes, d.version, d.is_restricted, d.is_current, d.expires_on,
              d.uploaded_at, d.superseded_by,
              u.full_name AS uploaded_by_name,
              (d.sha256 IS NOT NULL) AS has_content
         FROM document d
         LEFT JOIN app_user u ON u.user_id = d.uploaded_by
        WHERE ${where.join(' AND ')}
        ORDER BY d.doc_type, d.version DESC, d.uploaded_at DESC`,
      params,
    );
    res.json({ items: rows, accepted: Object.values(ACCEPTED).map((a) => a.label), maxBytes: MAX_BYTES });
  } catch (e) { next(e); }
});

// ---------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------
documentsRouter.post('/', requireInternal, upload.single('file'), async (req, res, next) => {
  try {
    const b = z.object({
      consultantId: z.string().uuid().optional(),
      placementId: z.string().uuid().optional(),
      docType: z.enum(DOC_TYPES),
      expiresOn: z.string().optional(),
    }).parse(req.body);

    if (!req.file) throw badRequest('Choose a file to upload.');
    if (!b.consultantId && !b.placementId) {
      throw badRequest('A document must belong to a consultant or a placement.');
    }
    if (b.consultantId && b.placementId) {
      throw badRequest('A document belongs to one owner, not two.');
    }

    // Everything about the file is checked before anything is written.
    const verdict = check(req.file.buffer, req.file.originalname, req.file.mimetype);
    if (!verdict.ok) throw badRequest(verdict.message!);

    // Vetting results and identity documents are restricted by what they are,
    // not by whoever uploads remembering to say so (BR-015).
    const restricted = restrictedByType(b.docType);
    if (restricted && req.actor!.role !== 'ADMINISTRATOR') {
      throw forbidden('Only an administrator may upload a vetting result or an identity document.');
    }

    const out = await withActor(req.actor!, async (c) => {
      // the version this replaces, if any
      const previous = await c.query(
        `SELECT document_id, version FROM document
          WHERE doc_type = $1::document_type_enum
            AND is_current
            AND ($2::uuid IS NULL OR consultant_id = $2)
            AND ($3::uuid IS NULL OR placement_id = $3)
          ORDER BY version DESC LIMIT 1`,
        [b.docType, b.consultantId ?? null, b.placementId ?? null],
      );
      const version = previous.rows.length ? Number(previous.rows[0].version) + 1 : 1;

      const stored = safeName(req.file!.originalname, verdict.extension!);

      const d = await c.query(
        `INSERT INTO document (consultant_id, placement_id, doc_type, file_name, original_name,
                               storage_key, mime_type, size_bytes, version, is_restricted,
                               expires_on, uploaded_by, is_current)
         VALUES ($1,$2,$3::document_type_enum,$4,$5,'pending',$6,$7,$8,$9,$10,$11,true)
         RETURNING *`,
        [b.consultantId ?? null, b.placementId ?? null, b.docType, stored,
         req.file!.originalname.slice(0, 255), verdict.mimeType, req.file!.buffer.length,
         version, restricted, b.expiresOn ?? null, req.actor!.userId],
      );
      const documentId = d.rows[0].document_id;

      const { storageKey, digest: sha } = await store(c, documentId, req.file!.buffer);
      await c.query('UPDATE document SET storage_key = $2, sha256 = $3 WHERE document_id = $1',
        [documentId, storageKey, sha]);

      // FR-DOC-004: the previous version is kept, not overwritten
      if (previous.rows.length) {
        await c.query(
          `UPDATE document SET is_current = false, superseded_by = $2 WHERE document_id = $1`,
          [previous.rows[0].document_id, documentId],
        );
      }

      await audit(c, {
        actorUserId: req.actor!.userId,
        action: 'DOCUMENT_UPLOADED',
        entityTable: 'document',
        entityId: documentId,
        next: { type: b.docType, version, bytes: req.file!.buffer.length, restricted },
        reason: `Uploaded ${stored}`,
      });

      return { ...d.rows[0], storage_key: storageKey, version };
    });

    res.status(201).json(out);
  } catch (e) { next(e); }
});

// ---------------------------------------------------------------------
// Download, in two steps
// ---------------------------------------------------------------------

/**
 * Asks for permission to download, and gets a token good for five minutes.
 *
 * Two steps rather than one because the second is a plain GET that a browser
 * can follow. A GET that serves a restricted document from a predictable
 * address is a document waiting to be found; a GET that needs a token issued
 * moments earlier to the person asking is not.
 */
documentsRouter.post('/:id/download-link', requireAuth, async (req, res, next) => {
  try {
    const id = z.string().uuid().parse(req.params.id);

    const out = await withActor(req.actor!, async (c) => {
      const d = await c.query(
        `SELECT d.document_id, d.file_name, d.is_restricted, d.consultant_id, d.sha256
           FROM document d WHERE d.document_id = $1`,
        [id],
      );
      if (!d.rows.length) throw notFound('Document not found');
      if (!d.rows[0].sha256) throw notFound('That document has no file attached.');

      const own = await c.query('SELECT consultant_id FROM consultant WHERE user_id = $1',
        [req.actor!.userId]);

      if (!mayRead(req.actor!.role, d.rows[0], own.rows[0]?.consultant_id ?? null)) {
        throw forbidden('You do not have permission to open that document.');
      }

      const token = randomBytes(32).toString('base64url');
      await c.query(
        `INSERT INTO document_token (token_hash, document_id, issued_to, expires_at)
         VALUES ($1,$2,$3, now() + ($4 || ' minutes')::interval)`,
        [digest(token), id, req.actor!.userId, String(TOKEN_MINUTES)],
      );

      return { token, fileName: d.rows[0].file_name };
    });

    res.json({
      url: `/api/documents/download/${out.token}`,
      fileName: out.fileName,
      expiresInSeconds: TOKEN_MINUTES * 60,
    });
  } catch (e) { next(e); }
});

/** Spends the token and serves the file. */
documentsRouter.get('/download/:token', requireAuth, async (req, res, next) => {
  try {
    const token = z.string().min(20).parse(req.params.token);

    const out = await withActor(req.actor!, async (c) => {
      const r = await c.query('SELECT * FROM redeem_document_token($1,$2)',
        [digest(token), req.actor!.userId]);

      if (!r.rows.length) {
        throw new AppError(410, 'That download link has expired or has already been used.',
          'link_expired');
      }

      const doc = r.rows[0];
      const content = await retrieve(c, doc.document_id);
      if (!content) throw notFound('The file is missing from storage.');

      if (!content.intact) {
        // Served bytes that do not match what was stored would be worse than
        // none: a CV goes to clients and a contract is evidence.
        throw new AppError(500,
          'That file does not match what was stored and has not been served. Report this.',
          'integrity_failed');
      }

      // Reading a restricted document is an event in its own right (BR-015).
      if (doc.is_restricted) {
        await audit(c, {
          actorUserId: req.actor!.userId,
          action: 'DOCUMENT_DOWNLOADED',
          entityTable: 'document',
          entityId: doc.document_id,
          reason: `Restricted document opened: ${doc.file_name}`,
        });
      }

      return { ...doc, bytes: content.bytes };
    });

    res.setHeader('Content-Type', out.mime_type ?? 'application/octet-stream');
    res.setHeader('Content-Disposition',
      `attachment; filename="${out.file_name.replace(/"/g, '')}"`);
    res.setHeader('Content-Length', String(out.bytes.length));
    // Never cached by an intermediary: some of these are vetting results.
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(out.bytes);
  } catch (e) { next(e); }
});

// ---------------------------------------------------------------------
// Removal
// ---------------------------------------------------------------------

/**
 * Removes a document.
 *
 * Administrator only, with a reason, because a contract or a vetting result is
 * a record rather than a file. The row goes; the audit entry saying it was
 * removed and by whom stays.
 */
documentsRouter.post('/:id/remove', requireAdmin, async (req, res, next) => {
  try {
    const id = z.string().uuid().parse(req.params.id);
    const b = z.object({
      reason: z.string().min(5, 'Give a reason of at least five characters'),
    }).parse(req.body);

    const out = await withActor(req.actor!, async (c) => {
      const d = await c.query(
        'SELECT document_id, file_name, doc_type, version FROM document WHERE document_id = $1',
        [id]);
      if (!d.rows.length) throw notFound('Document not found');

      await audit(c, {
        actorUserId: req.actor!.userId,
        action: 'DOCUMENT_REMOVED',
        entityTable: 'document',
        entityId: id,
        previous: d.rows[0],
        reason: b.reason,
      });

      // the content goes with it, by cascade
      await c.query('DELETE FROM document WHERE document_id = $1', [id]);
      return d.rows[0];
    });

    res.json({ removed: out.file_name });
  } catch (e) { next(e); }
});

// ---------------------------------------------------------------------
// Multer's own refusals need translating into the same shape as everything else
// ---------------------------------------------------------------------
documentsRouter.use((err: any, _req: any, res: any, next: any) => {
  if (err?.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({
      error: 'bad_request',
      message: 'That file is larger than the 10 MB limit.',
    });
  }
  if (err?.code === 'LIMIT_FILE_COUNT' || err?.code === 'LIMIT_UNEXPECTED_FILE') {
    return res.status(400).json({
      error: 'bad_request',
      message: 'Upload one file at a time.',
    });
  }
  return next(err);
});
