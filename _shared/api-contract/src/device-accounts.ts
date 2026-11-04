// SEVERAL ACCOUNTS IN ONE BROWSER: the words the platform and the editor share about which account a call is for.
//
// A browser holds one active platform session and, beside it, the other accounts signed in on it (Better Auth's
// multi-session device sessions). The cookie is the browser's, not a page's: a tab still drawing one account can find its
// next call riding another's. So the account a page is drawn for travels with the calls that change something, and comes
// back on every answer, and neither side acts on a call meant for someone else.

/**
 * The account id a call is meant for, sent by the page on every call that changes something, and the account id the
 * platform answered as, on every answer. Absent from an answer to nobody signed in.
 */
export const ACCOUNT_HEADER = `x-intentic-account`;

/** The platform's reason for refusing a call meant for an account other than the one its session is (HTTP 409). */
export const ACCOUNT_CHANGED = `ACCOUNT_CHANGED`;

/** How many accounts one browser keeps signed in at once; past it, adding one is not offered. */
export const MAX_DEVICE_ACCOUNTS = 5;

/** What an account id may be spelled with, where one is carried in a header (Better Auth's ids are of this alphabet). */
export const ACCOUNT_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u;
