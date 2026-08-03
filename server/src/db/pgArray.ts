// Postgres array-literal rendering for array-typed query PARAMETERS.
//
// PGlite does not auto-serialize JS arrays for untyped parameters, and `pg`
// passes a string through unchanged. Call sites therefore bind the literal
// produced here as an ordinary parameter and add an explicit `::…[]` cast in
// the SQL, which restores the array type on both drivers. The values never
// enter the statement text — they stay bound — so this is not SQL building.
//
// Extracted at GB-15 from byte-identical private copies in
// matching/eligibility.ts, routes/requests.ts, routes/requestViews.ts and
// sweep/sweepSql.ts. Behaviour is unchanged, escaping included.

/**
 * Render `values` as a Postgres array literal, e.g. `{"open","alerting"}`.
 * Each element is double-quoted with `\` and `"` escaped, so a value carrying
 * either character round-trips instead of terminating the element early.
 */
export function toPgArrayLiteral(values: readonly string[]): string {
  const quoted = values.map((v) => `"${v.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`);
  return `{${quoted.join(',')}}`;
}
