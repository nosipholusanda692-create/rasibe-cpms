/**
 * Documents (FR-DOC-001 to 004, 007, NFR-SEC-009).
 *
 * An upload is the one place where somebody else's bytes enter the system, so
 * most of what is asserted here is refusal: a file that lies about what it is,
 * a file too large, an archive renamed to .pdf, a recruiter reaching for a
 * vetting result, a download link used twice.
 */
import { createApp } from '../index.js';
import { closePool } from '../lib/db.js';
import type { Server } from 'node:http';

const PORT = Number(process.env.TEST_PORT ?? 4107);
const BASE = `http://127.0.0.1:${PORT}/api`;

let pass = 0;
let fail = 0;
const failures: string[] = [];

function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) { pass++; console.log(`  \u2713 ${name}`); }
  else {
    fail++; failures.push(name);
    console.log(`  \u2717 ${name}`);
    if (detail !== undefined) console.log(`      ${JSON.stringify(detail).slice(0, 220)}`);
  }
}
const section = (t: string) => console.log(`\n${t}`);

// ---------------------------------------------------------------------
// Files to upload, built rather than shipped
// ---------------------------------------------------------------------
const pdf = () => Buffer.concat([
  Buffer.from('%PDF-1.7\n'),
  Buffer.from('1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n'),
]);

const png = () => Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64, 7),
]);

const jpeg = () => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 3)]);

/** A plain ZIP: the shape of a docx, without being one. */
const zipNotDocx = () => Buffer.concat([
  Buffer.from([0x50, 0x4b, 0x03, 0x04]),
  Buffer.from('archive/of/something/else.txt'),
  Buffer.alloc(200, 0),
]);

const notAnything = () => Buffer.from('This is just some text pretending to be a CV.');

class Client {
  private cookies = new Map<string, string>();

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const h: Record<string, string> = { ...extra };
    if (this.cookies.size) h.Cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    const t = this.cookies.get('rasibe_csrf');
    if (t) h['X-CSRF-Token'] = t;
    return h;
  }

  private absorb(res: Response) {
    for (const line of (res.headers as any).getSetCookie?.() ?? []) {
      const [pair] = line.split(';');
      const i = pair.indexOf('=');
      if (i > 0) this.cookies.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
    }
  }

  async call(method: string, path: string, body?: unknown) {
    const res = await fetch(BASE + path, {
      method,
      headers: this.headers({ 'Content-Type': 'application/json' }),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    this.absorb(res);
    const text = await res.text();
    let json: any = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    return { status: res.status, body: json };
  }

  /** An upload, as a browser sends one. */
  async upload(path: string, file: Buffer, name: string, type: string, fields: Record<string, string>) {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(file)], { type }), name);
    for (const [k, v] of Object.entries(fields)) form.append(k, v);

    const res = await fetch(BASE + path, { method: 'POST', headers: this.headers(), body: form });
    this.absorb(res);
    const text = await res.text();
    let json: any = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    return { status: res.status, body: json };
  }

  /** A download, kept as bytes rather than parsed. */
  async download(path: string) {
    const res = await fetch(BASE + path, { headers: this.headers() });
    this.absorb(res);
    const buf = Buffer.from(await res.arrayBuffer());
    return {
      status: res.status,
      bytes: buf,
      type: res.headers.get('content-type'),
      disposition: res.headers.get('content-disposition'),
      cache: res.headers.get('cache-control'),
      nosniff: res.headers.get('x-content-type-options'),
    };
  }

  get = (p: string) => this.call('GET', p);
  post = (p: string, b?: unknown) => this.call('POST', p, b);

  async signIn(email: string, password = 'Password123!') {
    await this.get('/auth/me');
    const r = await this.post('/auth/login', { email, password });
    if (r.status !== 200) throw new Error(`sign in failed for ${email}: ${JSON.stringify(r.body)}`);
    return (await this.get('/auth/me')).body.user;
  }
}

async function main() {
  const app = createApp();
  const server: Server = await new Promise((r) => { const s = app.listen(PORT, () => r(s)); });

  try {
    const admin = new Client();
    const recruiter = new Client();
    const consultant = new Client();
    const clientMgr = new Client();

    await admin.signIn('christinah@rasibe.co.za');
    await recruiter.signIn('nosipho@rasibe.co.za');
    const me = await consultant.signIn('thabo.m@example.co.za');
    await clientMgr.signIn('s.naidoo@nedgroupit.co.za');

    // A consultant of this suite's own. The retention suite anonymises unplaced
    // candidates and the paging suite seeds sixty more, so picking whichever
    // happens to sort first makes the result depend on what ran before.
    const made = await recruiter.post('/consultants', {
      fullName: `Document Suite ${Date.now()}`,
      email: `documents.${Date.now()}@example.co.za`,
      seniority: 'SENIOR',
      availability: 'AVAILABLE',
    });
    if (made.status !== 201) throw new Error(`could not create a consultant: ${JSON.stringify(made.body)}`);
    const target = made.body.consultant_id;

    // ------------------------------------------------------------------
    section('Uploading');
    // ------------------------------------------------------------------
    const cv = await recruiter.upload('/documents', pdf(), 'Thabo CV.pdf', 'application/pdf',
      { consultantId: target, docType: 'CV' });
    check('a recruiter can upload a CV', cv.status === 201, cv.body);
    check('it is version 1', cv.body.version === 1, cv.body?.version);
    check('the size is recorded', Number(cv.body.size_bytes) > 0, cv.body?.size_bytes);
    check('the person\u2019s own file name is kept',
      cv.body.original_name === 'Thabo CV.pdf', cv.body?.original_name);

    const image = await recruiter.upload('/documents', png(), 'scan.png', 'image/png',
      { consultantId: target, docType: 'OTHER' });
    check('an image can be uploaded', image.status === 201, image.body);

    const photo = await recruiter.upload('/documents', jpeg(), 'photo.jpg', 'image/jpeg',
      { consultantId: target, docType: 'CERTIFICATION' });
    check('a JPEG can be uploaded', photo.status === 201, photo.body);

    // ------------------------------------------------------------------
    section('What is refused (NFR-SEC-009)');
    // ------------------------------------------------------------------
    const text = await recruiter.upload('/documents', notAnything(), 'cv.pdf', 'application/pdf',
      { consultantId: target, docType: 'CV' });
    check('a text file named .pdf is refused', text.status === 400, text.body?.message);

    const zip = await recruiter.upload('/documents', zipNotDocx(), 'cv.docx',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      { consultantId: target, docType: 'CV' });
    check('an archive named .docx is refused', zip.status === 400, zip.body?.message);

    const empty = await recruiter.upload('/documents', Buffer.alloc(0), 'nothing.pdf',
      'application/pdf', { consultantId: target, docType: 'CV' });
    check('an empty file is refused', empty.status === 400, empty.body?.message);

    const mislabelled = await recruiter.upload('/documents', png(), 'actually.pdf',
      'application/pdf', { consultantId: target, docType: 'CV' });
    check('a PNG claiming to be a PDF is refused', mislabelled.status === 400,
      mislabelled.body?.message);
    check('and the refusal says what it actually is',
      String(mislabelled.body?.message ?? '').includes('PNG'), mislabelled.body?.message);

    const huge = Buffer.concat([pdf(), Buffer.alloc(11 * 1024 * 1024, 1)]);
    const tooBig = await recruiter.upload('/documents', huge, 'big.pdf', 'application/pdf',
      { consultantId: target, docType: 'CV' });
    check('a file over 10 MB is refused', tooBig.status === 400, tooBig.body?.message);

    const noOwner = await recruiter.upload('/documents', pdf(), 'orphan.pdf', 'application/pdf',
      { docType: 'CV' });
    check('a document with no owner is refused', noOwner.status === 400, noOwner.body?.message);

    const noFile = await recruiter.post('/documents', { consultantId: target, docType: 'CV' });
    check('a request with no file is refused', noFile.status === 400, noFile.body?.message);

    // ------------------------------------------------------------------
    section('Versions (FR-DOC-004)');
    // ------------------------------------------------------------------
    const cv2 = await recruiter.upload('/documents', pdf(), 'Thabo CV v2.pdf', 'application/pdf',
      { consultantId: target, docType: 'CV' });
    check('a replacement CV is accepted', cv2.status === 201, cv2.body);
    check('it is version 2', cv2.body.version === 2, cv2.body?.version);

    const current = await recruiter.get(`/documents?consultantId=${target}`);
    const cvs = current.body.items.filter((d: any) => d.doc_type === 'CV');
    check('only the current version is listed', cvs.length === 1, cvs.map((d: any) => d.version));
    check('and it is the new one', cvs[0]?.version === 2, cvs[0]?.version);

    const withHistory = await recruiter.get(
      `/documents?consultantId=${target}&includeSuperseded=true`);
    const allCvs = withHistory.body.items.filter((d: any) => d.doc_type === 'CV');
    check('the previous version is kept, not overwritten',
      allCvs.length === 2, allCvs.map((d: any) => d.version));
    check('and it points at what replaced it',
      allCvs.some((d: any) => d.superseded_by === cv2.body.document_id));

    // ------------------------------------------------------------------
    section('Restricted documents (BR-015)');
    // ------------------------------------------------------------------
    const recruiterVetting = await recruiter.upload('/documents', pdf(), 'clearance.pdf',
      'application/pdf', { consultantId: target, docType: 'VETTING' });
    check('a recruiter cannot upload a vetting result',
      recruiterVetting.status === 403, recruiterVetting.status);

    const vetting = await admin.upload('/documents', pdf(), 'Police clearance.pdf',
      'application/pdf', { consultantId: target, docType: 'VETTING' });
    check('an administrator can', vetting.status === 201, vetting.body);
    check('and it is restricted by its type, not by a tick box',
      vetting.body.is_restricted === true, vetting.body?.is_restricted);

    const identity = await admin.upload('/documents', pdf(), 'id.pdf', 'application/pdf',
      { consultantId: target, docType: 'ID_DOCUMENT' });
    check('an identity document is restricted too',
      identity.body?.is_restricted === true, identity.body?.is_restricted);

    const recruiterSees = await recruiter.get(`/documents?consultantId=${target}`);
    check('a recruiter does not see restricted documents at all',
      !recruiterSees.body.items.some((d: any) => d.is_restricted),
      recruiterSees.body.items.filter((d: any) => d.is_restricted).length);

    const adminSees = await admin.get(`/documents?consultantId=${target}`);
    check('an administrator does', adminSees.body.items.some((d: any) => d.is_restricted));

    const recruiterLink = await recruiter.post(`/documents/${vetting.body.document_id}/download-link`);
    check('a recruiter cannot get a link to one',
      recruiterLink.status === 403 || recruiterLink.status === 404, recruiterLink.status);

    const clientLink = await clientMgr.post(`/documents/${cv2.body.document_id}/download-link`);
    check('a client manager cannot download a consultant document',
      clientLink.status === 403 || clientLink.status === 404, clientLink.status);

    // ------------------------------------------------------------------
    section('Downloading (NFR-SEC-009)');
    // ------------------------------------------------------------------
    const link = await recruiter.post(`/documents/${cv2.body.document_id}/download-link`);
    check('a link can be issued', link.status === 200 && !!link.body.url, link.body);
    check('it expires in minutes, not hours',
      link.body.expiresInSeconds <= 600, link.body?.expiresInSeconds);
    check('the url is not the document identifier',
      !String(link.body.url).includes(cv2.body.document_id), link.body?.url);

    const path = String(link.body.url).replace('/api', '');
    const file = await recruiter.download(path);
    check('the file comes back', file.status === 200, file.status);
    check('with the right bytes', file.bytes.subarray(0, 4).toString() === '%PDF',
      file.bytes.subarray(0, 8).toString());
    check('as an attachment', String(file.disposition).startsWith('attachment'), file.disposition);
    check('with the right content type', file.type === 'application/pdf', file.type);
    check('never cached', String(file.cache).includes('no-store'), file.cache);
    check('and not sniffed by the browser', file.nosniff === 'nosniff', file.nosniff);

    const reuse = await recruiter.download(path);
    check('the same link cannot be used twice', reuse.status === 410, reuse.status);

    const someoneElse = await admin.post(`/documents/${cv2.body.document_id}/download-link`);
    const stolen = await recruiter.download(String(someoneElse.body.url).replace('/api', ''));
    check('a link issued to one person is useless to another',
      stolen.status === 410, stolen.status);

    const madeUp = await recruiter.download('/documents/download/not-a-real-token-at-all-here');
    check('an invented token is refused', madeUp.status === 410 || madeUp.status === 400,
      madeUp.status);

    // ------------------------------------------------------------------
    section('A consultant and their own documents');
    // ------------------------------------------------------------------
    const mine = await consultant.get(`/documents?consultantId=${me.consultantId}`);
    check('a consultant can list their own documents', mine.status === 200, mine.status);
    check('and sees no restricted ones',
      !mine.body.items.some((d: any) => d.is_restricted));

    const somebodyElses = await consultant.get(`/documents?consultantId=${target}`);
    const leaked = target === me.consultantId ? [] : somebodyElses.body.items;
    check('a consultant sees nothing of another consultant\u2019s',
      leaked.length === 0, leaked.length);

    const consultantUpload = await consultant.upload('/documents', pdf(), 'mine.pdf',
      'application/pdf', { consultantId: me.consultantId, docType: 'CV' });
    check('a consultant cannot upload to their own record',
      consultantUpload.status === 403, consultantUpload.status);

    // ------------------------------------------------------------------
    section('Removal and the audit trail');
    // ------------------------------------------------------------------
    const byRecruiter = await recruiter.post(`/documents/${image.body.document_id}/remove`,
      { reason: 'A recruiter attempting a removal' });
    check('a recruiter cannot remove a document', byRecruiter.status === 403, byRecruiter.status);

    const noReason = await admin.post(`/documents/${image.body.document_id}/remove`, { reason: '' });
    check('removal without a reason is refused', noReason.status === 400, noReason.status);

    const removed = await admin.post(`/documents/${image.body.document_id}/remove`,
      { reason: 'Uploaded against the wrong consultant' });
    check('an administrator can remove one', removed.status === 200, removed.body);

    const gone = await admin.post(`/documents/${image.body.document_id}/download-link`);
    check('and it is then gone', gone.status === 404, gone.status);

    const log = await admin.get('/reports/audit?pageSize=60');
    const actions = log.body.items.map((a: any) => a.action);
    check('an upload is recorded', actions.includes('DOCUMENT_UPLOADED'), actions.slice(0, 8));
    check('a removal is recorded', actions.includes('DOCUMENT_REMOVED'));
    check('opening a restricted document is recorded',
      actions.includes('DOCUMENT_DOWNLOADED')
      || await (async () => {
        const l = await admin.post(`/documents/${vetting.body.document_id}/download-link`);
        await admin.download(String(l.body.url).replace('/api', ''));
        const after = await admin.get('/reports/audit?pageSize=20');
        return after.body.items.some((a: any) => a.action === 'DOCUMENT_DOWNLOADED');
      })());
  } finally {
    server.close();
    await closePool();
  }

  console.log(`\n${'='.repeat(56)}`);
  console.log(`  ${pass} passed, ${fail} failed`);
  if (fail) { console.log('\n  Failures:'); failures.forEach((f) => console.log(`   - ${f}`)); }
  console.log('='.repeat(56));
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('Test run could not complete:', e); process.exit(1); });
