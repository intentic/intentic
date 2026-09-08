import { parseEnv } from "node:util";
import { expect, test } from "vitest";
import { envLine, shellQuote, sqlLiteral } from "./quote.js";

// Each case is a value that broke a real call site, asserted through the parser it broke (parseEnv, a shell), not the
// emitted text: text alone would pass a wrong escaping scheme.

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
    expect(sqlLiteral(`x'; DROP DATABASE postgres; --`)).toBe(`'x''; DROP DATABASE postgres; --'`);
    // standard_conforming_strings=on: a backslash is a backslash, doubling it would store two.
    expect(sqlLiteral(String.raw`a\b`)).toBe(String.raw`'a\b'`);
});

// The inverse of shellQuote for one word: strips the outer quotes, then collapses each `'\''` seam. Kept off a real
// shell to keep this test out of the integration budget, while still decoding rather than transcribing.
const unquoteShell = (word: string): string => (word.startsWith(`'`) ? word.slice(1, -1).replaceAll(`'\\''`, `'`) : word);

test("a SQL literal inside a shell command needs BOTH layers, and composes", () => {
    const password = `x'"; id; #`;
    const statement = `ALTER ROLE "app" LOGIN PASSWORD ${sqlLiteral(password)}`;
    // Layer 1, Postgres: the quote that would end the string is doubled, so the injected statement is data.
    expect(statement).toBe(`ALTER ROLE "app" LOGIN PASSWORD 'x''"; id; #'`);
    // Layer 2, the shell: the whole statement arrives as one argv word, byte-identical.
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
    // The injection: parseEnv ends a quoted value at its delimiter with no escape, so it parses as two keys.
    const injected = `ab"\nEVIL=1`;
    // The old serialization let a stored value inject a new key; parseEnv's key order is its own business.
    expect(Object.keys(parseEnv(`SECRET="${injected}"\n`))).toContain("EVIL");
    expect(Object.keys(parseEnv(envLine("SECRET", injected)))).toEqual(["SECRET"]);
    expect(parseEnv(envLine("SECRET", injected))).toEqual({ SECRET: injected });
});

test("a value holding all three delimiters is refused, not silently truncated", () => {
    expect(() => envLine("SECRET", `a"b'c\`d`)).toThrow(/all three quote characters/);
});

// Single quotes are preferred since `docker compose --env-file` interpolates `$` inside a double-quoted value (a bcrypt
// hash's `$2b$` would be eaten); only a value with a single quote falls through to double quotes.
test("envLine prefers the delimiter that is literal to compose as well as to parseEnv", () => {
    expect(envLine("PASSWORD_HASH", "$2b$12$abcdef")).toBe(`PASSWORD_HASH='$2b$12$abcdef'\n`);
    expect(envLine("RESTIC_PASSWORD", "abc123")).toBe(`RESTIC_PASSWORD='abc123'\n`);
    expect(envLine("QUOTED", `it's`)).toBe(`QUOTED="it's"\n`);
});

test("a .env line written BY a shell command needs both layers too", () => {
    // Both the .env delimiter and shell metacharacters at once; one call each, neither reaches the other's.
    const value = `pa'ss$(id)`;
    const word = shellQuote(envLine("ADMIN_PASSWORD", value));
    expect(unquoteShell(word)).toBe(envLine("ADMIN_PASSWORD", value));
    expect(parseEnv(unquoteShell(word))).toEqual({ ADMIN_PASSWORD: value });
});
