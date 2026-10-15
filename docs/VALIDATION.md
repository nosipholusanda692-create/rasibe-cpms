# Input validation

Every value from outside is checked against an allow-list before it is used:
what it may be, not what it may not be.

## Where it happens

**Request bodies.** Every route parses `req.body` with a zod schema before
reading it. Fields are typed, options are restricted to known values with
`z.enum`, and fields the schema does not name are dropped, so nothing the
client invents reaches a query. A value longer than its column allows is
refused by the database and answered with a 400 (below).

**Query strings.** The shared rules in `server/src/lib/validation.ts`:

| Rule | Accepts | Used for |
| --- | --- | --- |
| `isoDate` | a real calendar date as `YYYY-MM-DD` (2026-02-30 is refused) | `weekStart`, `availableFrom` |
| `queryInt(min, max)` | a whole number in range | `days`, `page`, `pageSize`, `endingWithinDays` |
| `enumList(values)` | one or more known values, comma separated | every `status` filter |
| `queryBool` | `true`, `false`, `1`, `0` | `includeInactive`, `unreadOnly`, `outstanding` |
| `searchText` | text up to 200 characters | every `search` and `location` |

`queryBool` replaces `z.coerce.boolean()`, which is `Boolean(value)`: the
string `"false"` is truthy, so `?includeInactive=false` used to mean true.

**Identifiers.** Every id in a path or query is checked as a UUID.

**Currency.** ISO 4217, as an allow-list in the database: `rate_card.currency`
and `invoice.currency` reference the `currency` table, which holds only the
currencies the business invoices in (ZAR today). Any other code is refused
with "That currency is not supported". Adding one is a row in that table,
once invoices and tax for it are handled; the format check alone would accept
`XYZ`, which is why the list is the control rather than the pattern.

**The database.** Column types, `CHECK` constraints, enums and triggers refuse
anything the application let through. `translateDbError` turns those refusals
into a message: a business rule becomes its own sentence, and a value
PostgreSQL cannot read (error class 22: wrong format, too long, too large)
becomes a 400 rather than a 500. A 500 is kept for faults that are genuinely
the server's.

## SQL injection

No value is ever placed in SQL text. Every query passes values as parameters
(`$1`, `$2`), which PostgreSQL receives separately from the statement and never
parses as SQL. Where a query is assembled from optional filters, only fixed
fragments written in the code and placeholder numbers are joined; column names
come from a fixed map, never from the request. Row-level security sits
underneath, so even a query that went wrong would only see what the signed-in
person may see.

## Evidence

`npm test`, section "Input validation on query strings": malformed numbers,
dates, options, lists, flags and over-long searches are each refused with 400,
and the valid forms the screens send still work. `src/test/e2e.ts` drives the
same requests the web client makes.
