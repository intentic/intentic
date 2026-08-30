/* `issues`, the core listener provider a bug intake's automation names — alongside `webchat` and `ci`, the
 * other two sources with no gateway extension behind them.
 *
 * ITS OWN MODULE, and a one-line one, for the reason `CI_PROVIDER` sits in ci/events.ts: three unrelated places
 * need the slug (the trigger catalogue, the ingest that resolves an automation by it, and the upsert that mints
 * an intake's ingest key), and the one thing that must not happen is three string literals agreeing by
 * coincidence. It carries no imports at all, so naming the source never drags a route's dependencies into a
 * module that only wanted to spell it. */
export const ISSUES_PROVIDER = "issues";
