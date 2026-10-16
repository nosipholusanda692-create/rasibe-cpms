/**
 * Behind a proxy that writes the caller's port into X-Forwarded-For.
 *
 * Azure App Service sends `203.0.113.5:51234`. Left alone, that becomes req.ip
 * and a fresh throttle key on every connection, so the per-address sign-in
 * limit counts nothing. Needs no database.
 */
import express from 'express';
import type { Server } from 'node:http';
import { createApp } from '../index.js';
import { normaliseForwardedFor, stripPort, stripForwardedPorts } from '../lib/forwarded.js';
import { throttleKey } from '../routes/auth.js';

const PORT = Number(process.env.TEST_PORT ?? 4105);

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

async function listen(app: express.Express, port: number): Promise<Server> {
  return new Promise((r) => { const s = app.listen(port, () => r(s)); });
}
const close = (s: Server) => new Promise<void>((r) => s.close(() => r()));

async function main() {
  section('Removing a port from one address');
  check('IPv4 with a port', stripPort('203.0.113.5:51234') === '203.0.113.5', stripPort('203.0.113.5:51234'));
  check('IPv4 without a port is untouched', stripPort('203.0.113.5') === '203.0.113.5');
  check('bracketed IPv6 with a port', stripPort('[2001:db8::1]:51234') === '2001:db8::1', stripPort('[2001:db8::1]:51234'));
  check('bare IPv6 is never cut at its last colon', stripPort('2001:db8::1') === '2001:db8::1', stripPort('2001:db8::1'));
  check('a full bare IPv6 address is untouched', stripPort('2001:db8:0:1:0:0:0:1') === '2001:db8:0:1:0:0:0:1');
  check('an IPv4-mapped address is untouched', stripPort('::ffff:203.0.113.5') === '::ffff:203.0.113.5');
  check('surrounding spaces go', stripPort('  203.0.113.5:80 ') === '203.0.113.5');
  check('something that is not an address is left alone', stripPort('unknown') === 'unknown');
  check('a port out of shape is left alone, not guessed at', stripPort('203.0.113.5:notaport') === '203.0.113.5:notaport');

  section('A whole header');
  check('every hop is cleaned',
    stripForwardedPorts('198.51.100.7:4000, 203.0.113.5:51234') === '198.51.100.7, 203.0.113.5',
    stripForwardedPorts('198.51.100.7:4000, 203.0.113.5:51234'));
  check('a mixed header keeps its order',
    stripForwardedPorts('2001:db8::9, [2001:db8::1]:80') === '2001:db8::9, 2001:db8::1');

  section('What the throttle sees');
  {
    const withPort = express();
    withPort.set('trust proxy', 1);
    withPort.get('/ip', (req, res) => res.json({ ip: req.ip, key: throttleKey(req.ip) }));

    const cleaned = express();
    cleaned.set('trust proxy', 1);
    cleaned.use(normaliseForwardedFor);
    cleaned.get('/ip', (req, res) => res.json({ ip: req.ip, key: throttleKey(req.ip) }));

    const a = await listen(withPort, PORT);
    const b = await listen(cleaned, PORT + 1);
    try {
      const ask = async (port: number, xff: string) =>
        (await fetch(`http://127.0.0.1:${port}/ip`, { headers: { 'X-Forwarded-For': xff } })).json() as Promise<{ ip: string; key: string }>;

      // The failure this exists to prevent: two connections from one person.
      const one = await ask(PORT, '203.0.113.5:51234');
      const two = await ask(PORT, '203.0.113.5:51999');
      check('without the fix, one caller gets a different key on each connection', one.key !== two.key, { one, two });

      const x = await ask(PORT + 1, '203.0.113.5:51234');
      const y = await ask(PORT + 1, '203.0.113.5:51999');
      check('with it, req.ip is the bare address', x.ip === '203.0.113.5', x);
      check('and the same caller has the same throttle key every time', x.key === y.key && x.key === '203.0.113.5', { x, y });

      const v6a = await ask(PORT + 1, '[2001:db8:0:1::5]:40000');
      const v6b = await ask(PORT + 1, '[2001:db8:0:1::9]:40001');
      check('IPv6 callers in one /64 still share a key', v6a.key === v6b.key && v6a.key.endsWith('::/64'), { v6a, v6b });

      const other = await ask(PORT + 1, '198.51.100.7:51234');
      check('different callers still have different keys', other.key !== x.key, { other, x });

      // The proxy appends the real client to whatever the caller already sent.
      // With one trusted hop only the last entry is believed, so a forged
      // leading entry must not become the address.
      const forged = await ask(PORT + 1, '10.0.0.1:1111, 203.0.113.5:51234');
      check('a forged leading entry is still ignored', forged.ip === '203.0.113.5', forged);
    } finally {
      await close(a);
      await close(b);
    }
  }

  section('Wired into the app only where a proxy is trusted');
  {
    const has = (app: express.Express) =>
      (app as any)._router.stack.some((l: any) => l.handle === normaliseForwardedFor);

    const saved = process.env.TRUST_PROXY;
    try {
      process.env.TRUST_PROXY = '1';
      check('with TRUST_PROXY set, the app strips ports', has(createApp({ clients: {} })));
      delete process.env.TRUST_PROXY;
      check('without it, the header is left alone', !has(createApp({ clients: {} })));
    } finally {
      if (saved === undefined) delete process.env.TRUST_PROXY; else process.env.TRUST_PROXY = saved;
    }
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) {
    console.log(failures.map((f) => `  - ${f}`).join('\n'));
    process.exit(1);
  }
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
