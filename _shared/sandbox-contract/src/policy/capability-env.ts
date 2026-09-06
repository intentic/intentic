/* HOW A CLI CAPABILITY'S ENV VARS ARE NAMED, the one rule both ends of that wire have to apply.
 *
 * The daemon writes the agent's shell env by suffixing every var a cli connector declares with the instance id
 * (cli-env.ts), so two connections of the same provider coexist on one flat environment. A connector's own
 * TOOL then has to read them back, and an extension may not import daemon internals, so without this the
 * rule would be spelled twice, and a change to it would silently split the writer from the reader. */

// `analytics` → `POSTGRES_URL_ANALYTICS`; the default-named `github` → `GITHUB_TOKEN_GITHUB`.
// ponytail: ids differing only by case or `-`/`_` (my-db vs my_db) map to the same suffix, last wins.
export const envSuffix = (id: string): string => id.toUpperCase().replaceAll("-", "_");
