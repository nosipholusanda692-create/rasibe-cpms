import { z } from 'zod';
import { queryInt } from './validation.js';

/**
 * Paging for the list endpoints (NFR-PER-006).
 *
 * Until now a list returned every row it could see. That is fine against eight
 * consultants and four clients; it is not fine against the pool the business
 * expects to hold, and a response that grows without bound is the kind of thing
 * that works in a demonstration and fails in a year.
 *
 * The shape is deliberately additive: `items` is unchanged, so an existing
 * caller that ignores the rest keeps working. Everything else is advisory.
 */

export const DEFAULT_PAGE_SIZE = 25;

/**
 * The ceiling matches the one already used on the consultant search, so there
 * is one bound rather than two. A caller wanting everything pages for it.
 */
export const MAX_PAGE_SIZE = 100;

export const pageQuery = z.object({
  page: queryInt(1, 10_000).default(1),
  pageSize: queryInt(1, MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
});

export interface Page {
  page: number;
  pageSize: number;
  offset: number;
}

export function readPage(query: unknown): Page {
  const { page, pageSize } = pageQuery.parse(query);
  return { page, pageSize, offset: (page - 1) * pageSize };
}

export interface Paged<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
  hasMore: boolean;
}

/**
 * The response envelope.
 *
 * `total` is the count before the limit, so the interface can say "25 of 180"
 * rather than only "25". It costs a second query, which is the honest price of
 * knowing how much there is.
 */
export function paged<T>(items: T[], total: number, p: Page): Paged<T> {
  const pageCount = Math.max(1, Math.ceil(total / p.pageSize));
  return {
    items,
    total,
    page: p.page,
    pageSize: p.pageSize,
    pageCount,
    hasMore: p.page < pageCount,
  };
}

/**
 * Appends LIMIT and OFFSET to a query that already has its own parameters.
 *
 * Returns the fragment and the two values, so a caller builds its WHERE clause
 * however it likes and then adds this without having to track parameter
 * numbering by hand — which is where this kind of change usually goes wrong.
 */
export function limitOffset(params: unknown[], p: Page): string {
  params.push(p.pageSize, p.offset);
  return `LIMIT $${params.length - 1} OFFSET $${params.length}`;
}

/**
 * Counts the rows a list query would return, reusing its WHERE clause.
 *
 * The count runs under the same row-level security as the list itself, so the
 * total is what this caller may see rather than what exists. A client manager
 * is told how many of their own records there are, not how many the system
 * holds.
 */
export function countQuery(from: string, where: string): string {
  return `SELECT count(*)::int AS n FROM ${from} WHERE ${where}`;
}
