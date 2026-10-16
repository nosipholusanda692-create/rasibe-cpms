/**
 * Serving the built web and mobile clients from the API's origin.
 *
 * Needs no database: pages and scripts are answered before the session
 * middleware, which is itself one of the things checked. The built clients are
 * stood in for by small fixtures in a temporary directory, so the result does
 * not depend on whether anyone has run `npm run build`.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import { createApp } from '../index.js';
import { clientDirsFromEnv } from '../lib/clients.js';

const PORT = Number(process.env.TEST_PORT ?? 4104);
const ORIGIN = `http://127.0.0.1:${PORT}`;

let pass = 0;
let fail = 0;
const failures: string[] = [];

function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) { pass++; console.log(`  \u2713 ${name}`); }
  else {
    fail++; failures.push(name);
    console.log(`  \u2717 ${name}`);
    if (detail !== undefined) console.log(`      ${JSON.stringify(detail).slice(0, 300)}`);
  }
}
const section = (t: string) => console.log(`\n${t}`);

const WEB_PAGE = '<!doctype html><title>web client</title><div id="root"></div>';
const MOBILE_PAGE = '<!doctype html><title>mobile client</title><div id="root"></div>';
const SECRET = 'outside-the-build-directory';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rasibe-clients-'));
  const web = path.join(root, 'web');
  const mobile = path.join(root, 'mobile');
  for (const d of [web, path.join(web, 'assets'), mobile, path.join(mobile, 'assets')]) {
    fs.mkdirSync(d, { recursive: true });
  }
  fs.writeFileSync(path.join(web, 'index.html'), WEB_PAGE);
  fs.writeFileSync(path.join(web, 'assets', 'app.abc123.js'), 'console.log("web")');
  fs.writeFileSync(path.join(web, 'logo.png'), 'not really a png');
  fs.writeFileSync(path.join(mobile, 'index.html'), MOBILE_PAGE);
  fs.writeFileSync(path.join(mobile, 'sw.js'), 'self.addEventListener("fetch", () => {})');
  fs.writeFileSync(path.join(mobile, 'manifest.webmanifest'), '{}');
  fs.writeFileSync(path.join(mobile, 'assets', 'm.abc123.js'), 'console.log("mobile")');
  fs.writeFileSync(path.join(root, 'secret.txt'), SECRET);
  return { root, web, mobile };
}

const get = (p: string, headers: Record<string, string> = {}, method = 'GET') =>
  fetch(ORIGIN + p, { method, headers: { Accept: 'text/html', ...headers }, redirect: 'manual' });

async function main() {
  const dirs = fixture();
  const app = createApp({ clients: { web: dirs.web, mobile: dirs.mobile } });
  const server: Server = await new Promise((r) => { const s = app.listen(PORT, () => r(s)); });

  try {
    section('The web client is served at the root');
    {
      const r = await get('/');
      const body = await r.text();
      check('GET / returns the web page', r.status === 200 && body === WEB_PAGE, { status: r.status });
      check('it is HTML', (r.headers.get('content-type') ?? '').startsWith('text/html'));
      check('the page is revalidated every time', r.headers.get('cache-control') === 'no-cache', r.headers.get('cache-control'));
      check('a page costs no session: no cookie is set', r.headers.get('set-cookie') === null);

      const deep = await get('/consultants/1234/edit');
      check('a client-side route returns the page, so a reload works',
        deep.status === 200 && (await deep.text()) === WEB_PAGE, { status: deep.status });

      const head = await get('/', {}, 'HEAD');
      check('HEAD works', head.status === 200);
    }

    section('Bundles are cached hard, files that name them are not');
    {
      const r = await get('/assets/app.abc123.js', { Accept: '*/*' });
      check('a hashed bundle is served', r.status === 200 && (await r.text()).includes('web'));
      check('as JavaScript', (r.headers.get('content-type') ?? '').includes('javascript'), r.headers.get('content-type'));
      check('and cached for a year, immutable',
        /max-age=31536000/.test(r.headers.get('cache-control') ?? '') && /immutable/.test(r.headers.get('cache-control') ?? ''),
        r.headers.get('cache-control'));

      const png = await get('/logo.png', { Accept: 'image/png' });
      check('other files get a short cache', /max-age=3600/.test(png.headers.get('cache-control') ?? ''), png.headers.get('cache-control'));
    }

    section('A missing file is a 404, never the page');
    {
      const js = await get('/assets/missing.js', { Accept: '*/*' });
      const text = await js.text();
      check('a missing script is 404', js.status === 404, { status: js.status });
      check('and is not the HTML page', !text.includes('web client'));

      const png = await get('/nothing.png', { Accept: 'image/png' });
      check('a missing image is 404', png.status === 404, { status: png.status });

      const json = await get('/some/route', { Accept: 'application/json' });
      check('a request that does not want HTML is not given it', json.status === 404, { status: json.status });

      const post = await fetch(`${ORIGIN}/some/route`, { method: 'POST', headers: { Accept: 'text/html' } });
      check('a POST outside /api is not answered with the page', post.status !== 200, { status: post.status });
    }

    section('The API is untouched');
    {
      const r = await get('/api/no-such-endpoint');
      const body: any = await r.json().catch(() => null);
      check('an unknown API path is still the JSON 404', r.status === 404 && body?.error === 'not_found', { status: r.status, body });

      const bare = await get('/api');
      const bareBody: any = await bare.json().catch(() => null);
      check('so is /api itself, even when the client asks for HTML', bare.status === 404 && bareBody?.error === 'not_found', { status: bare.status });
    }

    section('The mobile app lives under /m/');
    {
      const r = await get('/m/');
      check('GET /m/ returns the mobile page', r.status === 200 && (await r.text()) === MOBILE_PAGE, { status: r.status });

      const deep = await get('/m/week');
      check('a mobile route returns the mobile page, not the web one',
        deep.status === 200 && (await deep.text()) === MOBILE_PAGE, { status: deep.status });

      const bare = await get('/m');
      check('/m redirects to /m/', bare.status === 308 && bare.headers.get('location') === '/m/', { status: bare.status, location: bare.headers.get('location') });

      const query = await get('/m?from=install');
      check('the query string survives the redirect', query.headers.get('location') === '/m/?from=install', query.headers.get('location'));

      const slash = await get('/m/');
      check('/m/ does not redirect again', slash.status === 200);

      const sw = await get('/m/sw.js', { Accept: '*/*' });
      check('the service worker is served', sw.status === 200 && (sw.headers.get('content-type') ?? '').includes('javascript'));
      check('and is never cached, or a release would not reach phones', sw.headers.get('cache-control') === 'no-cache', sw.headers.get('cache-control'));

      const manifest = await get('/m/manifest.webmanifest', { Accept: '*/*' });
      check('the manifest is served and revalidated', manifest.status === 200 && manifest.headers.get('cache-control') === 'no-cache');

      const asset = await get('/m/assets/m.abc123.js', { Accept: '*/*' });
      check('a mobile bundle is cached hard', asset.status === 200 && /immutable/.test(asset.headers.get('cache-control') ?? ''));

      const missing = await get('/m/assets/missing.js', { Accept: '*/*' });
      check('a missing mobile bundle is 404, not a page', missing.status === 404, { status: missing.status });

      const web = await get('/week');
      check('the same route outside /m/ is the web page', (await web.text()) === WEB_PAGE);
    }

    section('Only files inside the build are reachable');
    {
      const attempts = [
        '/%2e%2e/secret.txt',
        '/%2e%2e%2fsecret.txt',
        '/..%2fsecret.txt',
        '/assets/..%2f..%2fsecret.txt',
        '/m/%2e%2e%2f%2e%2e%2fsecret.txt',
        '/%2e%2e%5csecret.txt',
      ];
      for (const p of attempts) {
        const r = await get(p, { Accept: '*/*' });
        const text = await r.text();
        check(`${p} does not leak a file outside the build`, !text.includes(SECRET), { status: r.status });
      }

      fs.writeFileSync(path.join(dirs.web, '.env'), 'DOTFILE=1');
      const r = await get('/.env', { Accept: '*/*' });
      check('a dotfile in the build is not served', !(await r.text()).includes('DOTFILE'), { status: r.status });
    }

    section('Security headers on the page (NFR-SEC-001, NFR-SEC-006)');
    {
      const r = await get('/');
      const csp = r.headers.get('content-security-policy') ?? '';
      const directive = (name: string) => csp.split(';').map((d) => d.trim()).find((d) => d.startsWith(`${name} `)) ?? '';

      check('scripts only from this origin', directive('script-src') === "script-src 'self'", directive('script-src'));
      check('no inline script is allowed', !/unsafe-inline|unsafe-eval/.test(directive('script-src')));
      check('no plugins', directive('object-src') === "object-src 'none'", directive('object-src'));
      check('cannot be framed', directive('frame-ancestors') === "frame-ancestors 'none'", directive('frame-ancestors'));
      check('forms only post here', directive('form-action') === "form-action 'self'", directive('form-action'));
      check('the base URL cannot be changed', directive('base-uri') === "base-uri 'self'", directive('base-uri'));
      check('images may be data: URLs (the QR code is drawn as one)', /\bdata:/.test(directive('img-src')), directive('img-src'));
      check('calls go only to this origin', directive('connect-src') === '' && /default-src 'self'/.test(csp), csp);
      check('the browser is told not to sniff types', r.headers.get('x-content-type-options') === 'nosniff');
      check('the origin is isolated', r.headers.get('cross-origin-opener-policy') === 'same-origin');
      check('HSTS is sent', /max-age=31536000/.test(r.headers.get('strict-transport-security') ?? ''));
      check('the framework does not name itself', r.headers.get('x-powered-by') === null);

      const sw = await get('/m/sw.js', { Accept: '*/*' });
      check('the service worker carries the same policy', (sw.headers.get('content-security-policy') ?? '').includes("script-src 'self'"));
    }

    section('Nothing is served when nothing is built');
    {
      const bare = createApp({ clients: {} });
      const s: Server = await new Promise((r) => { const x = bare.listen(PORT + 1, () => r(x)); });
      try {
        const r = await fetch(`http://127.0.0.1:${PORT + 1}/`, { headers: { Accept: 'text/html' } });
        const body: any = await r.json().catch(() => null);
        check('the root is the JSON 404', r.status === 404 && body?.error === 'not_found', { status: r.status });
        const m = await fetch(`http://127.0.0.1:${PORT + 1}/m`, { headers: { Accept: 'text/html' }, redirect: 'manual' });
        check('and /m does not redirect', m.status === 404, { status: m.status });
      } finally {
        await new Promise<void>((r) => s.close(() => r()));
      }
    }

    section('Which builds are served is configuration');
    {
      const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'rasibe-empty-'));
      const found = clientDirsFromEnv({ WEB_DIST: dirs.web, MOBILE_DIST: dirs.mobile } as NodeJS.ProcessEnv);
      check('WEB_DIST and MOBILE_DIST locate the builds', found.web === dirs.web && found.mobile === dirs.mobile, found);

      const none = clientDirsFromEnv({ WEB_DIST: empty, MOBILE_DIST: empty } as NodeJS.ProcessEnv);
      check('a directory with no index.html is not served', none.web === undefined && none.mobile === undefined, none);

      const off = clientDirsFromEnv({ SERVE_CLIENTS: 'false', WEB_DIST: dirs.web, MOBILE_DIST: dirs.mobile } as NodeJS.ProcessEnv);
      check('SERVE_CLIENTS=false turns it off', off.web === undefined && off.mobile === undefined, off);
      fs.rmSync(empty, { recursive: true, force: true });
    }
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    fs.rmSync(dirs.root, { recursive: true, force: true });
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) {
    console.log(failures.map((f) => `  - ${f}`).join('\n'));
    process.exit(1);
  }
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
