import type { Request, Response, NextFunction } from 'express';

/**
 * Some proxies write the caller's port into X-Forwarded-For. Azure App Service
 * does: `203.0.113.5:51234`, and `[2001:db8::1]:51234` for IPv6.
 *
 * Express hands that string back as req.ip unchanged, and the sign-in throttle
 * (throttleKey in routes/auth.ts) cannot read it. A colon makes it look like
 * IPv6, so `203.0.113.5:51234` becomes a key made of two odd "groups", and the
 * port is different on every connection. Every attempt would then count
 * against a fresh key and the per-address throttle (FR-AUT-009, RCP-10) would
 * stop limiting anything, without any error to say so.
 *
 * This removes the port and nothing else, so what reaches req.ip is a bare
 * address as it is behind any other proxy. It only reads and rewrites the
 * header; whether the header is believed at all stays the job of TRUST_PROXY.
 */
export function stripPort(entry: string): string {
  const e = entry.trim();

  // 203.0.113.5:51234
  const v4 = /^(\d{1,3}(?:\.\d{1,3}){3}):\d{1,5}$/.exec(e);
  if (v4) return v4[1];

  // [2001:db8::1]:51234 — the brackets are what mark the port as a port. A bare
  // IPv6 address has colons of its own and must never be cut at the last one.
  const v6 = /^\[([0-9a-fA-F:.]+)\]:\d{1,5}$/.exec(e);
  if (v6) return v6[1];

  return e;
}

export function stripForwardedPorts(value: string): string {
  return value.split(',').map(stripPort).join(', ');
}

/** Install only where a proxy is in front: see TRUST_PROXY in index.ts. */
export function normaliseForwardedFor(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers['x-forwarded-for'];
  if (typeof header === 'string' && header.includes(':')) {
    req.headers['x-forwarded-for'] = stripForwardedPorts(header);
  }
  next();
}
