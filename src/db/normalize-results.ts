/**
 * Makes `query()` return rows for UPDATE and DELETE, as it does for SELECT.
 *
 * TypeORM's Postgres driver returns `[rows, affectedCount]` for an
 * UPDATE ... RETURNING or DELETE ... RETURNING, and plain `rows` for
 * everything else. The code in this repository is written throughout as
 * `const [row] = await db.query('UPDATE ... RETURNING ...')`, which with the
 * driver's shape binds `row` to the whole rows array: always truthy, even
 * when no row matched. That silently disabled guards such as "only the first
 * driver to accept gets the ride" and "only one admin can send a payout".
 *
 * Normalising once, here, is safer than touching every call site: a new
 * query written the obvious way then behaves the obvious way. Nothing in the
 * code reads the affected-row count.
 *
 * Imported first in main.ts, before any module that runs a query.
 */

import { PostgresQueryRunner } from 'typeorm/driver/postgres/PostgresQueryRunner';

const original = PostgresQueryRunner.prototype.query;

PostgresQueryRunner.prototype.query = async function (
  this: PostgresQueryRunner,
  query: string,
  parameters?: any[],
  useStructuredResult?: boolean,
): Promise<any> {
  const result = await (original as any).call(this, query, parameters, useStructuredResult);
  if (
    !useStructuredResult &&
    Array.isArray(result) &&
    result.length === 2 &&
    Array.isArray(result[0]) &&
    typeof result[1] === 'number'
  ) {
    return result[0];
  }
  return result;
} as typeof original;
