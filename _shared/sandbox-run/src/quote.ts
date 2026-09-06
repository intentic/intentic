/* EMBEDDING A VALUE IN A STRING SOMEONE ELSE WILL PARSE, the quoters, in one place.
 *
 * Every function here exists because a value crossed into a language whose delimiters it did not respect. The
 * class is always the same shape: a template literal wraps an interpolation in bare `'…'` or `"…"`, the values
 * are secrets or operator-typed config, and the assumption "no secret contains a quote" holds right up until a
 * restic password contains an apostrophe. Then the write either corrupts (a `.env` value silently truncated at
 * the quote, so the backup encrypts under a key nobody has) or executes (a `$(…)` past the closing quote of a
 * command this daemon runs on a host as root).
 *
 * They live in @intentic/sandbox-run because it is the one leaf package `providers`, `sandbox` and `cli` all
 * already depend on, and because shellQuote was already here, the copies in the daemon and in the provider
 * suite were duplicates of THIS function, and duplicates of a security primitive drift in the direction of the
 * one that was easier to write inline.
 *
 * The layering is the part worth reading twice. These compose OUTWARD, one call per parser the bytes pass
 * through, and a value that reaches a shell, then a file, then a container needs one call per hop:
 *   • a SQL statement inside a shell command, `shellQuote(… sqlLiteral(value) …)`
 *   • a .env line written by a shell command, `shellQuote(envLine(key, value))`
 * Quoting only the outer layer is the bug that makes a shell-safe statement a SQL injection, and quoting only
 * the inner one puts the value back in the shell's hands. Every site fixed by these functions had exactly one
 * of the two layers.
 *
 * What these do NOT fix: a value passed as an ARGUMENT is still readable in the host's process table, so a
 * correctly-quoted `printf` of a secret is a correctly-quoted secret in `ps`. Closing that means writing files
 * over stdin instead of argv, which changes how providers talk to hosts, tracked separately, deliberately not
 * smuggled in here. */

// Every character that never needs quoting in a POSIX shell word, flags, names, image tags, and NAME=value
// pairs of plain values all match, so the emitted command stays byte-identical to what the scripts always
// wrote and reads at a glance. Anything else (spaces, quotes, $, newlines, a multi-line HOST_SSH_KEY) is
// single-quote escaped, which is precisely the safety the hand-rolled `-e VAR=$value` splices never had.
const PLAIN_WORD = /^[\w@%+=:,./-]+$/;

/* One shell word. Single quotes are the only POSIX construct with no interior escapes at all, no `$`, no
 * backtick, no backslash, so the sole thing to handle is the delimiter itself: close the string, emit an
 * escaped quote, reopen (`'\''`). */
export const shellQuote = (word: string): string => (PLAIN_WORD.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`);

/* A Postgres string literal, `'…'` with interior quotes doubled, the SQL-standard escape, and the one psql
 * honours without depending on standard_conforming_strings. Backslashes are NOT escaped, deliberately: under
 * the default standard_conforming_strings=on a backslash in a regular literal is a backslash, and doubling it
 * here would silently store two. */
export const sqlLiteral = (value: string): string => `'${value.replaceAll("'", "''")}'`;

/* A quoted Postgres identifier, a role or database name. Separate from sqlLiteral because the delimiter is
 * different and so is the doubling, and because the two are not interchangeable: a name in literal quotes is a
 * string, and a value in identifier quotes is a column reference.
 *
 * The names this repo passes are resolver-sanitized to [a-z0-9_] already. Quoting them anyway is the point,
 * a call site that reads `CREATE ROLE ${sqlIdentifier(role)}` states its own guarantee, where one that reads
 * `CREATE ROLE "${role}"` is only correct as long as a sanitizer three packages away stays that strict. */
export const sqlIdentifier = (name: string): string => `"${name.replaceAll(`"`, `""`)}"`;

/* THERE ARE TWO .env DIALECTS AND THEY DISAGREE ABOUT QUOTES. Pick by the reader, not by the file extension:
 *   • envLine. Node's `util.parseEnv` and `docker compose --env-file`. Both strip a quoted value's
 *     delimiters, so a value MUST be quoted to survive spaces and newlines.
 *   • dockerEnvLine, `docker run --env-file`. Takes the rest of the line literally, quotes included, so a
 *     value must NOT be quoted: `RESTIC_PASSWORD='pw'` sets the password to `'pw'` WITH the apostrophes, and
 *     restic then encrypts under a key nobody can retype. Verified against docker, not inferred from docs.
 * Using the wrong one is silent both ways, a corrupt value, not an error. */

/* One `KEY=value` line for a `.env`, the desired-state one Node's `util.parseEnv` reads back, and the
 * per-service ones on a host that `docker compose --env-file` reads.
 *
 * Neither parser has an escape mechanism inside a quoted value: `K="a\"b"` is `a\` to parseEnv, not `a"b`. A
 * value ends at its own delimiter and nothing else, which is why the broken form of this function did not
 * merely mangle a value, `K="a"` followed by a newline and `EVIL=1` parses as TWO keys, so any writer that
 * accepted a `"` in a value let its caller add arbitrary entries to the file.
 *
 * With no escape available the only correct move is to pick a delimiter the value does not contain. SINGLE
 * quotes come first because they are the one delimiter that is literal to BOTH readers: compose interpolates
 * `$` inside a double-quoted env-file value, so a bcrypt hash written as `K="…$2b$…"` reaches the container
 * with pieces of itself replaced by empty strings, while `K='…$2b$…'` arrives whole. parseEnv treats all three
 * as literal and holds newlines in any of them, so a multi-line PEM key round-trips either way.
 *
 * A value containing all three cannot be represented, and THROWS, the alternative is a file that reads back
 * as something other than what the caller stored. */
export const envLine = (key: string, value: string): string => {
    const delimiter = [`'`, `"`, "`"].find((candidate) => !value.includes(candidate));
    if (delimiter === undefined) {
        throw new Error(`cannot write ${key} to a .env: the value contains all three quote characters, which its parser cannot express`);
    }
    return `${key}=${delimiter}${value}${delimiter}\n`;
};

/* One `KEY=value` line for a `docker run --env-file`. The value is emitted RAW, see the dialect note above:
 * this reader hands the container everything after the `=` verbatim, so quoting a value here would store the
 * quotes as part of the secret.
 *
 * With no delimiter there is also no way to hold a newline, and a newline is not a mangled value, it is the
 * start of another variable. That is how a restic password could append `RESTIC_REPOSITORY=` and point the
 * nightly backup somewhere else, so it THROWS rather than write a file that means more than the caller said. */
export const dockerEnvLine = (key: string, value: string): string => {
    if (value.includes("\n")) {
        throw new Error(
            `cannot write ${key} to a docker --env-file: the value contains a newline, which that file's parser reads as the start of another variable`,
        );
    }
    return `${key}=${value}\n`;
};
