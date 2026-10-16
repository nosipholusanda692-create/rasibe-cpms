import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import rateLimit from 'express-rate-limit';
import express, { type Request, type Response, type NextFunction, type Router } from 'express';

/**
 * Serving the two built clients from the API's own origin.
 *
 * One origin is what the security design already assumes: the session cookie
 * is same-site, the CSRF token is echoed from a cookie this origin set, and the
 * Origin check treats the API's own address as friendly. Serving the clients
 * from somewhere else would mean widening CORS and the cookies, so they come
 * from here instead.
 *
 *   /      the staff web client (web/dist)
 *   /m/    the consultant and approver app (mobile/dist, built with base /m/)
 *   /api   the API, untouched
 *
 * A client is only served when its build exists, so a checkout that has not run
 * `npm run build` behaves exactly as before.
 */

export interface ClientDirs {
  /** Absolute path of a built web client, or undefined to skip it. */
  web?: string;
  /** Absolute path of a built mobile client, or undefined to skip it. */
  mobile?: string;
}

/** Where the mobile client is mounted. Its Vite `base` must match. */
export const MOBILE_MOUNT = '/m';

const here = path.dirname(fileURLToPath(import.meta.url));
// server/src/lib and server/dist/lib are the same depth below the repository.
const repoRoot = path.resolve(here, '../../..');

function builtDir(configured: string | undefined, fallback: string): string | undefined {
  const dir = path.resolve(configured || fallback);
  return fs.existsSync(path.join(dir, 'index.html')) ? dir : undefined;
}

/**
 * WEB_DIST and MOBILE_DIST override the locations, for a host that ships the
 * builds somewhere other than next to the server. SERVE_CLIENTS=false turns
 * this off altogether, for a deployment where the API stands alone.
 */
export function clientDirsFromEnv(env: NodeJS.ProcessEnv = process.env): ClientDirs {
  if (env.SERVE_CLIENTS === 'false') return {};
  return {
    web: builtDir(env.WEB_DIST, path.join(repoRoot, 'web', 'dist')),
    mobile: builtDir(env.MOBILE_DIST, path.join(repoRoot, 'mobile', 'dist')),
  };
}

const ONE_YEAR = 60 * 60 * 24 * 365;

/**
 * Hashed bundles never change under the same name, so they cache for a year.
 * Anything that names them must be revalidated every time, or a release would
 * not reach people until a cache expired: the page, the manifest, and above all
 * the service worker, which a browser will not update from a stale copy.
 */
function cacheControl(res: Response, filePath: string): void {
  const name = path.basename(filePath);
  if (name === 'index.html' || name === 'sw.js' || name === 'manifest.webmanifest') {
    res.setHeader('Cache-Control', 'no-cache');
  } else if (filePath.split(path.sep).includes('assets')) {
    res.setHeader('Cache-Control', `public, max-age=${ONE_YEAR}, immutable`);
  } else {
    res.setHeader('Cache-Control', 'public, max-age=3600');
  }
}

/**
 * A client-side route, as opposed to a file or an API call.
 *
 * Only a navigation gets the page back. A missing script or image has to be a
 * real 404: answering it with HTML turns a broken deployment into a confusing
 * syntax error in the browser, and hides it from monitoring.
 */
function isPageRequest(req: Request): boolean {
  return (
    path.extname(req.path) === '' &&
    !req.path.startsWith('/api') &&
    req.accepts('html') === 'html'
  );
}

/**
 * Page loads per address per minute.
 *
 * Every navigation to the app reads index.html from disk, and an unlimited
 * route that touches the file system is an easy way to keep a small host busy
 * (CWE-770). A person loads the page a handful of times a minute at most, since
 * the client then navigates without asking for it again, so this is far above
 * real use and shared addresses such as a campus network have room. Bundles do
 * not count against it: they are served by the static middleware and are cheap.
 * Like the sign-in limiter it keys on req.ip, so behind a proxy it needs
 * TRUST_PROXY to be right.
 */
export const PAGE_LOADS_PER_MINUTE = 300;

function clientRouter(dir: string, pageLoadsPerMinute: number): Router {
  const router = express.Router();
  const indexFile = path.join(dir, 'index.html');
  const pageLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: pageLoadsPerMinute,
    standardHeaders: true,
    legacyHeaders: false,
    message: 'Too many requests. Wait a moment and try again.',
  });

  router.use(
    express.static(dir, {
      // The page is sent by the fallback below, with its own headers.
      index: false,
      // A request for a directory goes to the fallback, not a redirect.
      redirect: false,
      setHeaders: cacheControl,
    }),
  );

  // Not a page: pass on without being counted. The limiter sits on the page
  // path only, so a missing script or an API typo does not use up the allowance.
  const onlyPages = (req: Request, _res: Response, next: NextFunction) =>
    next(isPageRequest(req) ? undefined : 'router');

  router.get('*', onlyPages, pageLimiter, (_req: Request, res: Response, next: NextFunction) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(indexFile, (err) => err && next(err));
  });

  return router;
}

/**
 * Mount the clients on an app. Call before the session middleware: a page or a
 * script is not personal, and serving it should not cost a session lookup.
 */
export function mountClients(
  app: express.Express,
  dirs: ClientDirs,
  pageLoadsPerMinute = PAGE_LOADS_PER_MINUTE,
): void {
  if (dirs.mobile) {
    // Express matches /m and /m/ alike, so the exact path is checked here or
    // the redirect would answer its own destination. The target is built from
    // the path alone and cannot name another host.
    app.get(MOBILE_MOUNT, (req, res, next) => {
      if (req.path !== MOBILE_MOUNT) return next();
      res.redirect(308, `${MOBILE_MOUNT}/${req.url.slice(MOBILE_MOUNT.length)}`);
    });
    // The mobile app first: it owns everything under /m/, and the web client's
    // catch-all would otherwise answer for it.
    app.use(MOBILE_MOUNT, clientRouter(dirs.mobile, pageLoadsPerMinute));
  }
  if (dirs.web) app.use('/', clientRouter(dirs.web, pageLoadsPerMinute));
}
