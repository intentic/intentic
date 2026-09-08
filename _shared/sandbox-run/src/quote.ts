// Quoters for embedding a value in a string another parser reads, kept here since providers, sandbox and cli all depend
// on this leaf package. Compose outward, one call per parser the value crosses; quoting only one layer turns a
// shell-safe statement into an injection, or the reverse.

// Characters that never need quoting in a POSIX word: flags, names, tags, NAME=value; else, single-quoted.
const PLAIN_WORD = /^[\w@%+=:,./-]+$/;

// One shell word: single quotes have no interior escapes at all, so the only thing to handle is the delimiter itself
// (close, escape, reopen: `'\''`).
export const shellQuote = (word: string): string => (PLAIN_WORD.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`);

// A Postgres string literal: interior quotes doubled, the SQL-standard escape psql honours without depending on
// standard_conforming_strings. Backslashes are not escaped, since under the default setting one is one, not two.
export const sqlLiteral = (value: string): string => `'${value.replaceAll("'", "''")}'`;

// A quoted Postgres identifier (role, database), a different delimiter and doubling than sqlLiteral: a literal is a
// string, an identifier a column reference. Quoted so the call site states its own guarantee.
export const sqlIdentifier = (name: string): string => `"${name.replaceAll(`"`, `""`)}"`;

// Two incompatible .env dialects; pick by the reader, not the file extension:
// - envLine, for util.parseEnv and `docker compose --env-file`: both strip a quoted value's delimiters, so it must be
//   quoted.
// - dockerEnvLine, for `docker run --env-file`: takes the line literally, quotes included, so it must not be quoted.
// Using the wrong one silently corrupts the value; it is not an error.

// One `KEY=value` line for a .env; picks a delimiter the value doesn't contain, since neither parser escapes inside a
// quoted value. Single quotes come first: compose interpolates `$` inside double quotes, corrupting a bcrypt hash.
export const envLine = (key: string, value: string): string => {
    const delimiter = [`'`, `"`, "`"].find((candidate) => !value.includes(candidate));
    if (delimiter === undefined) {
        throw new Error(`cannot write ${key} to a .env: the value contains all three quote characters, which its parser cannot express`);
    }
    return `${key}=${delimiter}${value}${delimiter}\n`;
};

// One `KEY=value` line for `docker run --env-file`: the value is emitted raw, so quoting it here would store the quotes
// as part of the secret. A newline can't be held (it would start a new variable), so it throws.
export const dockerEnvLine = (key: string, value: string): string => {
    if (value.includes("\n")) {
        throw new Error(
            `cannot write ${key} to a docker --env-file: the value contains a newline, which that file's parser reads as the start of another variable`,
        );
    }
    return `${key}=${value}\n`;
};
