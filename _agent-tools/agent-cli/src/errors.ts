// A failure as an agent reads it: one line with a code it can branch on, then the one step that gets it further.
//
//   webq: error: blocked: HTTP 403 from https://example.com/docs
//   webq: next: webq fetch https://example.com/docs --browser force --fresh
//
// After orca's CLI errors (MIT): an agent that reads only the first lines, only the last, or greps for `error:` must
// still see the failure, so it is one line in a fixed shape, and a code is never renamed once shipped (a reader may
// branch on it). Imports nothing at runtime: run.ts reports a broken install with it before anything else has loaded.
import type { Application, CommandContext } from "@stricli/core";

/** Every code these CLIs print, and what each one tells the reader. */
export const ERROR_CODES = {
    usage: "the command line is wrong: a verb, a flag or a value",
    not_found: "the file or page is not there",
    unsupported: "the tool does not read this kind of input",
    too_large: "over the size the tool reads",
    unreadable: "it is there but cannot be read: permissions, damage, a password",
    missing_tool: "a program the tool needs is not installed",
    fetch_failed: "the site did not answer with the page",
    blocked: "the site refused: a sign-in, a bot check, a rate limit, robots.txt",
    timeout: "the deadline passed first",
    broken_install: "the tool itself will not start",
    internal: "the tool failed on its own",
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;

const firstLine = (text: string): string => (text.split("\n")[0] ?? "").trim();

/** `<tool>: error: <code>: <message>`, then `<tool>: next: <step>` when there is a step worth naming. */
export const failure = (name: string, code: ErrorCode, message: string, next?: string): string =>
    `${name}: error: ${code}: ${firstLine(message)}\n${next === undefined ? "" : `${name}: next: ${firstLine(next)}\n`}`;

/** A path or URL as one shell word, so a `next:` step can be pasted as it is (`?` and `&` in a URL included). */
export const shellWord = (word: string): string => (/^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`);

/** The help a refused command line points at: the verb's own (`webq fetch --help`) when the line named one. */
export const helpCommand = (name: string, app: Application<CommandContext>, argv: readonly string[]): string => {
    const verb = argv[0];
    if (verb === undefined || verb.startsWith("-") || !("getRoutingTargetForInput" in app.root)) {
        return `${name} --help`;
    }
    // `git-attributes` names the `gitAttributes` route under stricli's allow-kebab-for-camel.
    const camel = verb.replaceAll(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
    const known = app.root.getRoutingTargetForInput(verb) ?? app.root.getRoutingTargetForInput(camel);
    return known === undefined ? `${name} --help` : `${name} ${verb} --help`;
};

// stricli's own refusals, as its English text words them (@stricli/core 1.x): the command line was wrong…
const REFUSED =
    /^(?:No command registered for |No flag registered for |No alias registered for |Failed to parse |Expected |Too many arguments|Cannot negate flag |Unable to parse arguments, )/;
// …or the command threw, and stricli is about to print its stack.
const THREW = /^(?:Command failed|Unable to load command (?:function|context)), /;
// The bold red stricli wraps them in on a terminal.
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

/**
 * stricli's error text in the failure shape: a refused command line is `usage`, with `help` (`webq fetch --help`) as
 * the next step; a command that threw is `internal`, its first line kept and the stack dropped. Anything else written
 * to stderr (a library's warning) is not stricli's and answers undefined, to pass through as it is.
 */
export const stricliFailure = (name: string, text: string, help: string): string | undefined => {
    const plain = text.replaceAll(ANSI, "").trim();
    if (REFUSED.test(plain)) {
        return failure(name, "usage", plain, help);
    }
    const threw = THREW.exec(plain);
    if (threw !== null) {
        return failure(
            name,
            "internal",
            plain.slice(threw[0].length),
            `this is ${name}'s own failure, not an empty answer: report it with the command that was run`,
        );
    }
    return undefined;
};
