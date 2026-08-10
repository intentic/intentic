#!/usr/bin/env node
// Type-only, so it is erased: this file must have NO runtime import of its own. Everything it needs is loaded
// dynamically below, where a failure is catchable. See the loader comment there for why.
import type { StricliProcess } from "@stricli/core";

// Piping into `head` closes stdout mid-write — treat EPIPE as a clean stop, not a crash (grep convention).
process.stdout.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EPIPE") {
        process.exit(typeof process.exitCode === "number" ? process.exitCode : 0);
    }
    throw error;
});

// Agents arrive with grep muscle memory — map stricli's terse alias errors to actionable redirects.
const FLAG_REDIRECTS: Record<string, string> = {
    i: "case-insensitive is the default; exact case: --case",
    A: "context lines: -C <n> (symmetric)",
    B: "context lines: -C <n> (symmetric)",
    r: "recursive is the default",
    n: "line numbers are always shown",
    l: "paths only: --files-only",
    e: "pass the pattern as the positional argument",
    v: "no invert-match; use --not-glob for path excludes",
    p: "a value starting with '-' needs the equals form, e.g. --features=-rerank",
};

// What a verb takes, for the two errors that both mean "this token is not a flag I know".
const FLAG_HELP = "the flags a verb takes are in `iq <verb> --help`; scope with --in/--glob/--only and size with --limit/--budget";

// Annotate stricli's terse alias errors in place, and put them on STDOUT — wrap the real stream's write
// (process.stderr itself is a getter-only property, so it can't be shadowed on a wrapper object; the write
// method is what stricli calls).
//
// Stdout because the reader is an agent: `iq … 2>/dev/null` is the reflex, and under it a mistyped flag came
// back as an empty result rather than an error. A transcript audit found `--max-hits` doing exactly that —
// the session read "no results", believed it, and fell back to grep. The exit code still says 2, so a script
// can still tell the difference.
const emit = process.stdout.write.bind(process.stdout);
process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
    const text = typeof chunk === "string" ? chunk : chunk.toString();
    const alias = /No alias registered for -(\w)/.exec(text)?.[1];
    // An unknown long flag reaches stricli as a surplus POSITIONAL, so "too many arguments" covers two unrelated
    // mistakes. Split them on the offending token: `--k 5` is a guessed flag name (transcripts: --k, --top,
    // --dir), and telling its author to quote their query sends them to fix the one thing that was already right.
    const surplus = /Too many arguments[^"]*"([^"]*)"/.exec(text)?.[1];
    const redirect =
        alias !== undefined
            ? FLAG_REDIRECTS[alias]
            : surplus?.startsWith("-") === true
              ? `${surplus} is not a flag — ${FLAG_HELP}`
              : /Too many arguments/.test(text)
                ? 'each verb takes ONE query — quote multi-word queries (iq q "…") and scope with --in <dir>'
                : /No flag registered for --([\w-]+)/.test(text)
                  ? FLAG_HELP
                  : undefined;
    return (emit as (value: string | Uint8Array, ...args: unknown[]) => boolean)(
        redirect === undefined ? chunk : `${text.trimEnd()} — ${redirect}\n`,
        ...rest,
    );
}) as typeof process.stderr.write;

/* THE WHOLE CLI, BEHIND ONE CATCHABLE IMPORT.
 *
 * A static `import` resolves before the first line of this file runs, which put a broken module graph out of
 * reach of every handler here — the process died as a raw node stack trace with nothing of iq's own in it.
 * That is not hypothetical: on 2026-08-09 a dependency was built against a package subpath its installed copy
 * did not export yet, and for nine hours EVERY verb died, `iq --help` included. A transcript audit found 15
 * crashed calls across 15 sessions, plus 4 more that returned literally nothing because the reflexive
 * `2>/dev/null` swallowed the stack — indistinguishable from "no matches". Fourteen of fifteen sessions
 * silently fell back to grep and never told anyone the search tool was down.
 *
 * So: load dynamically, and when the load fails say so in iq's own voice, on stdout, naming it as an install
 * fault rather than a search result. A broken tool that announces itself costs one turn; one that returns
 * silence costs a day. */
let cli: { run: typeof import("@stricli/core").run; app: typeof import("./app.js").app; normalizeArgv: typeof import("./lib/argv.js").normalizeArgv };
try {
    const [core, appModule, argvModule] = await Promise.all([import("@stricli/core"), import("./app.js"), import("./lib/argv.js")]);
    cli = { run: core.run, app: appModule.app, normalizeArgv: argvModule.normalizeArgv };
} catch (error) {
    const detail = error instanceof Error ? error.message.split("\n")[0] : String(error);
    process.stdout.write(
        `iq: cannot start — ${detail}\n` +
            `iq: this is a broken install, NOT an empty result — do not read it as 0 hits or fall back to grep silently. Reinstall iq (or rebuild its workspace deps) and report it.\n`,
    );
    process.exit(2);
}

const { argv, notes, hints } = cli.normalizeArgv(process.argv.slice(2));
if (notes.length > 0) {
    // Also stdout: this is how a verb like `search` or `ask` learns its real name, and it was being dropped by
    // the same `2>/dev/null`.
    process.stdout.write(`iq: grep dialect absorbed: ${notes.join(", ")}\n`);
}
for (const hint of hints) {
    process.stdout.write(`iq: ${hint}\n`);
}
await cli.run(cli.app, argv, { process: process as StricliProcess });
// Grep convention: 0 hits, 1 none, 2 anything else — clamp stricli's negative scanner/routing codes.
if (process.exitCode !== undefined && process.exitCode !== 0 && process.exitCode !== 1) {
    process.exitCode = 2;
}
