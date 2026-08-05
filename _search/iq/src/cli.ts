#!/usr/bin/env node
import type { StricliProcess } from "@stricli/core";
import { run } from "@stricli/core";
import { app } from "./app.js";
import { normalizeArgv } from "./lib/argv.js";

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
    const redirect =
        alias !== undefined
            ? FLAG_REDIRECTS[alias]
            : /Too many arguments/.test(text)
              ? 'each verb takes ONE query — quote multi-word queries (iq q "…") and scope with --in <dir>'
              : /No flag registered for --([\w-]+)/.test(text)
                ? "the flags a verb takes are in `iq <verb> --help`; scope with --in/--glob/--only and size with --limit/--budget"
                : undefined;
    return (emit as (value: string | Uint8Array, ...args: unknown[]) => boolean)(
        redirect === undefined ? chunk : `${text.trimEnd()} — ${redirect}\n`,
        ...rest,
    );
}) as typeof process.stderr.write;

const { argv, notes, hints } = normalizeArgv(process.argv.slice(2));
if (notes.length > 0) {
    // Also stdout: this is how a verb like `search` or `ask` learns its real name, and it was being dropped by
    // the same `2>/dev/null`.
    process.stdout.write(`iq: grep dialect absorbed: ${notes.join(", ")}\n`);
}
for (const hint of hints) {
    process.stdout.write(`iq: ${hint}\n`);
}
await run(app, argv, { process: process as StricliProcess });
// Grep convention: 0 hits, 1 none, 2 anything else — clamp stricli's negative scanner/routing codes.
if (process.exitCode !== undefined && process.exitCode !== 0 && process.exitCode !== 1) {
    process.exitCode = 2;
}
