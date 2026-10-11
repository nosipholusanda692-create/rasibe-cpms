# Identity numbers and bank accounts

The consultant write path used to accept any string for `idNumber`. That value is encrypted and its fingerprint is unique, so a mistyped number is stored as if it were a person, and a second typing of the same mistake collides with it. `server/src/lib/identity.ts` checks the number before either of those happens.

`consultants.ts` is the one place the field is written. It uses `saIdNumber` in place of `z.string().optional()`. Blank is treated as omitted, so a consultant with no South African identity number — the seeded records that have none — can still be created.

## Identity number

Thirteen digits.

| Part | Rule |
| --- | --- |
| Date of birth | The first six digits are `YYMMDD`. `YY` above this year's last two digits is 19xx; otherwise it is 20xx. The day has to exist, and it cannot be in the future. |
| Check digit | Luhn, on all thirteen digits. |
| All zeros | Refused even though Luhn accepts it. |

Spaces and hyphens are removed first. That is the same normalisation as the blind index, so `9001015800088` and `900101 5800 088` are one number and still collide.

A passport is not an identity number. The field stays optional: leave it out rather than inventing a format for every other document.

The rule is applied when a number is written, not when it is read. The two seeded numbers in `db/04_seed.sql`, `9107045000084` and `8804125000080`, are synthetic and pass it: their dates match the seeded dates of birth and their check digits are valid. A database built before this change holds numbers that fail. They are still returned as stored, and an edit to that field has to supply a valid one.

## Bank account reference

There is no single South African check digit. Each bank verifies an account against its own branch code, and applying the identity-number Luhn here would refuse real accounts. The check is the shape:

- Digits only, once spaces and hyphens are removed.
- Seven to sixteen digits. Seven is the short end of numbers still in circulation; sixteen covers the longer ones.
- Not all zeros.

`****4417`, which is what the seed stores, is a mask for the screen. It is not an account number, and the schema refuses it.

Banking is still not written by the API. `docs/ENCRYPTION.md` records that, and it has not changed. `bankAccountRef` is the schema for the write, when that write is added. Until then the suite calls the schema directly.

## Evidence

The server suite creates consultants with `9001015800088` and `9202025800080`, refuses `9001015800085` (the check digit), `0000000000000`, and `9002295800087` (29 February 1990, which was not a leap year, and the check digit is otherwise valid). Editing to all zeros is refused on the patch path as well. A date of birth of 31 December 2026 is refused when today is 1 January 2026. The bank schema accepts `1234567890`, including with spaces, and refuses zeros, the seed mask, six digits, and seventeen digits.
