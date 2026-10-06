/**
 * Measures how long the sign-in endpoint takes to refuse, by reason.
 *
 * Scratch tool for RCP-09, kept out of the test suite because a number printed
 * on a developer laptop is not an assertion. Run the API, then run this.
 *
 * Two things have to be right or the numbers are meaningless, and both were
 * wrong on the first attempt:
 *  - sign in is a write, so it needs a CSRF token. Without one every request is
 *    refused by the middleware and all three profiles measure the same refusal.
 *  - the lockout counter has to be cleared between samples, or the sixth
 *    attempt onwards takes the locked branch instead of the one being measured.
 * The status code is printed for exactly that reason.
 */
import { anonQuery, closePool } from '../lib/db.js';

const BASE = process.env.MEASURE_BASE ?? 'http://127.0.0.1:4000/api';
const ROUNDS = Number(process.env.MEASURE_ROUNDS ?? 25);

let csrfToken = '';

async function primeToken() {
  const res = await fetch(`${BASE}/auth/me`);
  for (const line of res.headers.getSetCookie()) {
    const [name, value] = line.split(';')[0].split('=');
    if (name.trim() === 'rasibe_csrf') csrfToken = value;
  }
  if (!csrfToken) throw new Error('No CSRF token was issued; the API may not be running.');
}

async function unlock(email: string) {
  await anonQuery(
    `UPDATE app_user SET failed_logins = 0, locked_until = NULL WHERE lower(email) = lower($1)`,
    [email],
  );
}

async function timeOne(email: string, password: string): Promise<[number, number]> {
  const started = performance.now();
  const res = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-CSRF-Token': csrfToken,
      Cookie: `rasibe_csrf=${csrfToken}`,
    },
    body: JSON.stringify({ email, password }),
  });
  return [performance.now() - started, res.status];
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

async function profile(label: string, email: string, password: string) {
  await unlock(email);
  await timeOne(email, password); // discard a warm-up
  const samples: number[] = [];
  let status = 0;
  for (let i = 0; i < ROUNDS; i++) {
    await unlock(email);
    const [ms, code] = await timeOne(email, password);
    samples.push(ms);
    status = code;
  }
  await unlock(email);
  const s = [...samples].sort((a, b) => a - b);
  console.log(
    `${label.padEnd(34)} ${String(status).padStart(3)}   median ${median(samples).toFixed(1).padStart(7)} ms` +
      `   fastest ${s[0].toFixed(1).padStart(7)} ms   slowest ${s[s.length - 1].toFixed(1).padStart(7)} ms`,
  );
  return median(samples);
}

await primeToken();

const wrong = await profile('known email, wrong password', 'christinah@rasibe.co.za', 'WrongPassword!');
const unknown = await profile('unknown email', 'nobody.here@example.co.za', 'WrongPassword!');
const right = await profile('known email, correct password', 'christinah@rasibe.co.za', 'Password123!');

console.log(`\nunknown vs wrong password: ${Math.abs(wrong - unknown).toFixed(1)} ms apart`);
console.log(`success vs wrong password:  ${Math.abs(wrong - right).toFixed(1)} ms apart`);
console.log(
  Math.abs(wrong - unknown) > 20
    ? '\nAn unknown address is distinguishable from a wrong password.'
    : '\nThe two refusals are not meaningfully distinguishable.',
);

await closePool();
