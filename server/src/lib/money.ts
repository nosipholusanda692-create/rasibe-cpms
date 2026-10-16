/**
 * Money in this system is rands and cents, held as a JavaScript number only
 * while a total is being worked out. Binary floating point cannot hold 0.1 or
 * 1.005 exactly, so rounding with toFixed alone gives 1.00 for 1.005, and adding
 * rounded lines one by one can leave a total a cent away from the sum of the
 * lines it was built from.
 *
 * Every figure that is stored or printed goes through here, and each running
 * total is rounded after each addition, so the invoice always adds up.
 */

// Past this, a double no longer holds whole cents exactly.
const LARGEST = 1e13;

export function roundMoney(value: number): number {
  if (!Number.isFinite(value)) throw new RangeError('A money amount must be a finite number.');
  const abs = Math.abs(value);
  if (abs >= LARGEST) throw new RangeError('A money amount is too large to hold exactly.');
  // Under a millionth of a rand is no cents at all. It also keeps the number's
  // text free of an exponent, which the shift below relies on.
  if (abs < 1e-6) return 0;

  // Shift the decimal point through the number's own text rather than by
  // multiplying: 1.005 * 100 is 100.49999999999999, but "1.005e2" is 100.5.
  const cents = Math.round(Number(`${abs}e2`));
  const rands = Number(`${cents}e-2`);
  return value < 0 ? -rands : rands;
}
