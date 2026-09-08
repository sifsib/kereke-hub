// lib/finance/years.ts
//
// Builds the list of years a tenant actually has financial data for, so the
// finance dashboard's year selectors stop hiding history. Earlier the selectors
// were hardcoded to the current year and the one before it, which meant a church
// that uploaded 2023 statements could never reach them even though the records
// were sitting in `transactions` with their real dates intact.
//
// We derive the range from the transaction dates the finance page already holds
// in memory. That keeps this to zero extra reads and, importantly, avoids
// needing a new Firestore composite index just to read the earliest document.
// Nothing here has to be deployed ahead of the fix for it to work.

/**
 * Returns the years to offer in a selector, newest first.
 *
 * The current year is always present, even for a brand-new tenant with no
 * transactions yet, so a selector never renders empty. The range stretches down
 * to the oldest transaction and up to the newest, so a back-dated 2019 entry and
 * a post-dated pledge are both reachable.
 *
 * @param transactionDates the `date` field of each transaction (a "YYYY-MM-DD"
 *   string in this app, but anything `new Date()` can parse is tolerated).
 *   Missing or unparseable values are skipped rather than throwing.
 * @param opts.now injectable clock, mainly for tests.
 * @param opts.includeNextYear when true, guarantees next year is offered even if
 *   no data sits there yet. The ledger uses this so finance can capture a
 *   forward-dated entry, matching the old hardcoded `thisYear + 1` affordance.
 */
export function availableYears(
  transactionDates: readonly (string | null | undefined)[],
  opts: { now?: Date; includeNextYear?: boolean } = {},
): number[] {
  const currentYear = (opts.now ?? new Date()).getFullYear();

  let earliest = currentYear;
  let latest = currentYear;

  for (const raw of transactionDates) {
    if (!raw) continue;
    const d = new Date(raw);
    if (isNaN(d.getTime())) continue;
    const y = d.getFullYear();
    if (y < earliest) earliest = y;
    if (y > latest) latest = y;
  }

  if (opts.includeNextYear && currentYear + 1 > latest) {
    latest = currentYear + 1;
  }

  const years: number[] = [];
  for (let y = latest; y >= earliest; y--) years.push(y);
  return years;
}
