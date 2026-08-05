import { parseEnv } from "node:util";
import { expect, test } from "vitest";
import { envLine, shellQuote, sqlLiteral } from "./quote.js";

/* Each case here is a value that broke a real call site, asserted through the PARSER it broke — parseEnv for
 * .env, a shell for the command forms. Asserting the emitted text alone would pass for an escaping scheme the
 * consumer does not implement, which is exactly how the `.env` writers came to backslash-escape a quote that
 * Node's parser reads as a literal backslash. */

test("a plain word stays bare, so an emitted command still reads like the hand-written scripts", () => {
    expect(shellQuote("--cap-add=SYS_ADMIN")).toBe("--cap-add=SYS_ADMIN");
    expect(shellQuote("/opt/intentic/backup")).toBe("/opt/intentic/backup");
});

test("shellQuote closes and reopens around an embedded single quote", () => {
    expect(shellQuote(`it's`)).toBe(`'it'\\''s'`);
    // The metacharacters that make this a security primitive rather than a formatter: none survive as syntax.
    expect(shellQuote(`a$(id)b`)).toBe(`'a$(id)b'`);
    expect(shellQuote("a`id`b")).toBe("'a`id`b'");
    expect(shellQuote(`x'; rm -rf /; '`)).toBe(`'x'\\''; rm -rf /; '\\'''`);
});

test("sqlLiteral doubles interior quotes and leaves backslashes alone", () => {
    expect(sqlLiteral("hunter2")).toBe(`'hunter2'`);
    expect(sqlLiteral(`it's`)).toBe(`'it''s'`);
    // The password that turned CREATE ROLE into two statements.
    expect(sqlLiteral(`x'; DROP DATABASE postgres; --`)).toBe(`'x''; DROP DATABASE postgres; --'`);
    // standard_conforming_strings=on: a backslash is a backslash, and doubling it would store two.
    expect(sqlLiteral(String.raw`a\b`)).toBe(String.raw`'a\b'`);
});

/* The inverse of shellQuote for one emitted word — strip the outer quotes, then collapse each `'\''` seam back
 * to the quote it stands for. A shell would do this; doing it here keeps the composition test off the machine
 * (and out of the integration budget) while still asserting through a decoder rather than a transcription. */
const unquoteShell = (word: string): string => (word.startsWith(`'`) ? word.slice(1, -1).replaceAll(`'\\''`, `'`) : word);

test("a SQL literal inside a shell command needs BOTH layers, and composes", () => {
    const password = `x'"; id; #`;
    const statement = `ALTER ROLE "app" LOGIN PASSWORD ${sqlLiteral(password)}`;
    // Layer 1, Postgres: the quote that would have ended the string literal is doubled, so the injected
    // statement is data. Derived from sqlLiteral, not transcribed — the escape belongs to the function.
    expect(statement).toBe(`ALTER ROLE "app" LOGIN PASSWORD 'x''"; id; #'`);
    // Layer 2, the shell: the whole statement arrives as ONE argv word, byte-identical. Quoting only this
    // layer is what made a shell-safe statement a SQL injection; quoting only the other made it a shell one.
    expect(unquoteShell(`${shellQuote(statement)}`)).toBe(statement);
});

test.each([
    ["a token", "ghp_abcdefghijklmnopqrstuvwxyz"],
    ["a double quote", `pa"ss`],
    ["a single quote", `it's`],
    ["a backtick", "a`b"],
    ["both straight quotes", `a"b'c`],
    ["a dollar sign compose would expand", "$NOT_A_VAR"],
    ["a multi-line PEM key", "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----"],
    ["a newline and an equals", "l1\nK2=v2"],
])("envLine round-trips %s through the parser that reads it back", (_label, value) => {
    expect(parseEnv(envLine("SECRET", value))).toEqual({ SECRET: value });
});

test("a value cannot add a second key to the file", () => {
    // The injection: `K="ab"` + newline + `EVIL=1` parses as TWO keys, because parseEnv ends a quoted value at
    // its delimiter and has no escape for it. Picking a delimiter the value lacks is what closes it.
    const injected = `ab"\nEVIL=1`;
    // The old serialization: one stored value became a key the caller never asked to set. The fact is that
    // EVIL exists at all, not where it sorts — parseEnv's key order is its own business.
    expect(Object.keys(parseEnv(`SECRET="${injected}"\n`))).toContain("EVIL");
    expect(Object.keys(parseEnv(envLine("SECRET", injected)))).toEqual(["SECRET"]);
    expect(parseEnv(envLine("SECRET", injected))).toEqual({ SECRET: injected });
});

test("a value holding all three delimiters is refused, not silently truncated", () => {
    expect(() => envLine("SECRET", `a"b'c\`d`)).toThrow(/all three quote characters/);
});

/* Single quotes are preferred for a reason the other reader of these files enforces: `docker compose
 * --env-file` interpolates `$` inside a DOUBLE-quoted value, so a bcrypt hash reaches the container with
 * `$2b$` eaten. Only a value that itself contains a single quote falls through to `"`. */
test("envLine prefers the delimiter that is literal to compose as well as to parseEnv", () => {
    expect(envLine("PASSWORD_HASH", "$2b$12$abcdef")).toBe(`PASSWORD_HASH='$2b$12$abcdef'\n`);
    expect(envLine("RESTIC_PASSWORD", "abc123")).toBe(`RESTIC_PASSWORD='abc123'\n`);
    expect(envLine("QUOTED", `it's`)).toBe(`QUOTED="it's"\n`);
});

test("a .env line written BY a shell command needs both layers too", () => {
    // The shape every provider .env writer now uses. The value carries the delimiter of the .env layer and the
    // metacharacters of the shell layer at once; one call each, and neither reaches the other's parser.
    const value = `pa'ss$(id)`;
    const word = shellQuote(envLine("ADMIN_PASSWORD", value));
    expect(unquoteShell(word)).toBe(envLine("ADMIN_PASSWORD", value));
    expect(parseEnv(unquoteShell(word))).toEqual({ ADMIN_PASSWORD: value });
});
