/* HOW A CLI CAPABILITY'S ENV VARS ARE NAMED, the one rule both ends of that wire have to apply. */

// `analytics` → `POSTGRES_URL_ANALYTICS`; the default-named `github` → `GITHUB_TOKEN_GITHUB`.
// ponytail: ids differing only by case or `-`/`_` (my-db vs my_db) map to the same suffix, last wins.
export const envSuffix = (id: string): string => id.toUpperCase().replaceAll("-", "_");
