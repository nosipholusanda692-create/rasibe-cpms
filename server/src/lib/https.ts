import { readFileSync } from 'node:fs';
import https from 'node:https';
import type { RequestListener } from 'node:http';

/**
 * Builds an HTTPS server when a certificate is configured (NFR-SEC-001).
 *
 * Returns null when either variable is absent. That is the shape used in
 * development and in CI, and also the shape used on a platform that terminates
 * TLS at its edge: there the connection reaching this process is already plain
 * HTTP and the protocol is carried by the proxy headers instead.
 */
/**
 * The TLS 1.2 cipher suites this server will negotiate.
 *
 * Every one begins with ECDHE, which is the part that matters: the key for a
 * session is derived from values thrown away afterwards, so recording traffic
 * today and stealing the private key later does not decrypt it. A suite
 * without it — plain RSA key exchange — hands over every past session with
 * that one key. All six are also AEAD, so the cipher authenticates as well as
 * encrypts.
 *
 * TLS 1.3 negotiates its suites separately and all of them are already forward
 * secret, so this list does not constrain it.
 */
export const TLS_CIPHERS = [
  'ECDHE-ECDSA-AES128-GCM-SHA256',
  'ECDHE-RSA-AES128-GCM-SHA256',
  'ECDHE-ECDSA-AES256-GCM-SHA384',
  'ECDHE-RSA-AES256-GCM-SHA384',
  'ECDHE-ECDSA-CHACHA20-POLY1305',
  'ECDHE-RSA-CHACHA20-POLY1305',
];

export function createHttpsServer(app: RequestListener): https.Server | null {
  const certFile = process.env.TLS_CERT_FILE;
  const keyFile = process.env.TLS_KEY_FILE;
  if (!certFile || !keyFile) return null;

  return https.createServer(
    {
      cert: readFileSync(certFile),
      key: readFileSync(keyFile),
      // TLS 1.0 and 1.1 are withdrawn. Node 22 already floors at 1.2, so this
      // states the requirement rather than changing today's behaviour: a later
      // runtime cannot lower it without this line being removed first.
      minVersion: 'TLSv1.2',
      ciphers: TLS_CIPHERS.join(':'),
      // Without this the client's preference order wins, and a client is free
      // to prefer the weakest suite both ends will accept.
      honorCipherOrder: true,
    },
    app,
  );
}
