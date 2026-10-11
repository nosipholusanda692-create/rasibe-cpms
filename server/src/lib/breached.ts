import { createHash } from 'node:crypto';

/**
 * Asks Have I Been Pwned whether a password has already been published in a
 * breach, without sending the password.
 *
 * The range API takes the first five hexadecimal characters of the SHA-1 and
 * returns every suffix it holds for that prefix, so the service never learns
 * which of several hundred candidates was being checked. `Add-Padding` asks
 * it to pad the answer with zero-count entries, so the response size does not
 * give the prefix away to anyone watching either.
 *
 * SHA-1 is what the corpus is indexed by. It is used here to look a value up,
 * not to store one; the stored hash is Argon2id.
 *
 * An unreachable service does not stop a password change. Refusing every
 * change while a third party is down would lock people into the password they
 * are trying to leave, so the answer is `unknown` and the caller lets it through.
 */
const RANGE_URL = 'https://api.pwnedpasswords.com/range/';
const TIMEOUT_MS = 2000;

export type BreachResult = 'breached' | 'clear' | 'unknown';

export async function checkBreached(password: string): Promise<BreachResult> {
  const digest = createHash('sha1').update(password, 'utf8').digest('hex').toUpperCase();
  const prefix = digest.slice(0, 5);
  const suffix = digest.slice(5);
  const base = process.env.PWNED_PASSWORDS_URL || RANGE_URL;

  try {
    const res = await fetch(base + prefix, {
      headers: { 'Add-Padding': 'true', 'User-Agent': 'rasibe-cpms' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return 'unknown';

    for (const line of (await res.text()).split('\n')) {
      const [candidate, count] = line.trim().split(':');
      if (candidate === suffix && Number(count) > 0) return 'breached';
    }
    return 'clear';
  } catch {
    return 'unknown';
  }
}
