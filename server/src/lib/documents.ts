import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';

/**
 * Accepting, checking and storing uploaded documents.
 *
 * NFR-SEC-009 and FR-DOC-002. An upload is the one place where a stranger's
 * bytes enter the system, so the checks here are deliberately unforgiving:
 * every file is matched against an allowlist, by what it actually contains
 * rather than by what it claims to be.
 */

export const MAX_BYTES = 10 * 1024 * 1024;

/**
 * The formats a recruitment agency actually receives.
 *
 * An allowlist, not a blocklist. A blocklist is a list of the attacks somebody
 * has already thought of; everything absent from it is permitted, which is the
 * wrong way round.
 */
export const ACCEPTED = {
  'application/pdf': { ext: 'pdf', label: 'PDF' },
  'application/msword': { ext: 'doc', label: 'Word document' },
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': {
    ext: 'docx', label: 'Word document',
  },
  'image/jpeg': { ext: 'jpg', label: 'JPEG image' },
  'image/png': { ext: 'png', label: 'PNG image' },
} as const;

export type AcceptedType = keyof typeof ACCEPTED;

/**
 * Identifies a file by its leading bytes.
 *
 * The browser's stated content type and the file extension are both supplied
 * by the caller and can both say anything. The first few bytes are what the
 * file actually is, so that is what decides.
 */
export function sniff(buf: Buffer): AcceptedType | null {
  if (buf.length < 8) return null;

  // %PDF
  if (buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46) {
    return 'application/pdf';
  }
  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47
      && buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a) {
    return 'image/png';
  }
  // Legacy Word: the OLE compound file header
  if (buf[0] === 0xd0 && buf[1] === 0xcf && buf[2] === 0x11 && buf[3] === 0xe0) {
    return 'application/msword';
  }
  // docx is a ZIP. So are a great many other things, including archives that
  // should not be accepted, so the central directory is searched for the
  // marker Word puts in every document.
  if (buf[0] === 0x50 && buf[1] === 0x4b && (buf[2] === 0x03 || buf[2] === 0x05)) {
    const head = buf.subarray(0, Math.min(buf.length, 4096)).toString('latin1');
    const tail = buf.subarray(Math.max(0, buf.length - 4096)).toString('latin1');
    if (head.includes('word/') || tail.includes('word/document.xml')) {
      return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    }
    return null;
  }
  return null;
}

export interface CheckResult {
  ok: boolean;
  message?: string;
  mimeType?: AcceptedType;
  extension?: string;
}

/** Everything an upload must satisfy before a byte is written. */
export function check(buf: Buffer, claimedName: string, claimedType?: string): CheckResult {
  if (!buf.length) {
    return { ok: false, message: 'That file is empty.' };
  }
  if (buf.length > MAX_BYTES) {
    return {
      ok: false,
      message: `That file is ${(buf.length / 1024 / 1024).toFixed(1)} MB. The limit is 10 MB.`,
    };
  }

  const actual = sniff(buf);
  if (!actual) {
    return {
      ok: false,
      message: 'That file type is not accepted. Upload a PDF, a Word document, or a JPEG or PNG image.',
    };
  }

  // A mismatch is reported rather than quietly corrected. A file named .pdf
  // that is really something else is worth the person knowing about.
  if (claimedType && claimedType !== actual && ACCEPTED[claimedType as AcceptedType]) {
    return {
      ok: false,
      message: `That file is named as ${ACCEPTED[claimedType as AcceptedType].label} `
        + `but its contents are ${ACCEPTED[actual].label}. Check you selected the right file.`,
    };
  }

  return { ok: true, mimeType: actual, extension: ACCEPTED[actual].ext };
}

/**
 * A safe stored name.
 *
 * The person's own file name is kept for display, but never used to address
 * anything: it can contain path separators, control characters or a name the
 * filesystem treats specially.
 */
export function safeName(original: string, extension: string): string {
  const base = original
    .replace(/\.[^.]*$/, '')
    .replace(/[^\w\s.-]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80) || 'document';
  return `${base}.${extension}`;
}

export const sha256 = (buf: Buffer): Buffer => createHash('sha256').update(buf).digest();

/**
 * Writes the bytes and returns the key that addresses them.
 *
 * One function so the backend can change without the routes knowing. The
 * database is the default because the deployed instance runs on a platform
 * whose filesystem is replaced on restart; an object-storage backend slots in
 * here when a connection string is configured.
 */
export async function store(
  c: PoolClient,
  documentId: string,
  buf: Buffer,
): Promise<{ storageKey: string; digest: Buffer }> {
  const digest = sha256(buf);

  await c.query(
    `INSERT INTO document_content (document_id, bytes, sha256)
     VALUES ($1,$2,$3)
     ON CONFLICT (document_id) DO UPDATE SET bytes = $2, sha256 = $3, stored_at = now()`,
    [documentId, buf, digest],
  );

  return { storageKey: `db:${documentId}`, digest };
}

/**
 * Reads the bytes back, and checks they are the ones that were written.
 *
 * A mismatch means the stored file has been altered since upload. Refusing to
 * serve it is the only safe answer: a CV is sent to clients, and a contract is
 * evidence.
 */
export async function retrieve(
  c: PoolClient,
  documentId: string,
): Promise<{ bytes: Buffer; intact: boolean } | null> {
  const r = await c.query('SELECT * FROM document_bytes($1)', [documentId]);
  if (!r.rows.length) return null;

  const bytes: Buffer = r.rows[0].bytes;
  const stored: Buffer = r.rows[0].sha256;
  return { bytes, intact: sha256(bytes).equals(stored) };
}

/**
 * Which document types carry restricted content.
 *
 * Vetting results and identity documents are administrator-only (BR-015), and
 * the flag is set from the type rather than left to whoever uploads. Relying
 * on a person to tick a box correctly every time is how a vetting report ends
 * up readable by a recruiter.
 */
export function restrictedByType(docType: string): boolean {
  return docType === 'VETTING' || docType === 'ID_DOCUMENT';
}
