#!/usr/bin/env node
// Type-only import, erased at runtime: this file must have no runtime import of its own; everything else loads
// dynamically below.
import type { StricliProcess } from "@stricli/core";

// Piping into `head` closes stdout mid-write; EPIPE is a clean stop, not a crash (grep convention).
process.stdout.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EPIPE") {
        process.exit(typeof process.exitCode === "number" ? process.exitCode : 0);
    }
    throw error;
});

// Maps stricli's terse alias errors to redirects, for agents arriving with grep muscle memory.
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

// What a verb takes; shown for the two errors that both mean an unknown flag token.
const FLAG_HELP = "the flags a verb takes are in `iq <verb> --help`; scope with --in/--glob/--only and size with --limit/--budget";

// Wraps stderr.write, unshadowable directly; sent to stdout since agents often redirect stderr away.
const emit = process.stdout.write.bind(process.stdout);
process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
    const text = typeof chunk === "string" ? chunk : chunk.toString();
    const alias = /No alias registered for -(\w)/.exec(text)?.[1];
    // An unknown long flag surfaces as a surplus positional, so "too many arguments" covers two different mistakes.
    const surplus = /Too many arguments[^"]*"([^"]*)"/.exec(text)?.[1];
    const redirect =
        alias !== undefined
            ? FLAG_REDIRECTS[alias]
            : surplus?.startsWith("-") === true
              ? `${surplus} is not a flag: ${FLAG_HELP}`
              : /Too many arguments/.test(text)
                ? 'each verb takes ONE query: quote multi-word queries (iq q "…") and scope with --in <dir>'
                : /No flag registered for --([\w-]+)/.test(text)
                  ? FLAG_HELP
                  : undefined;
    return (emit as (value: string | Uint8Array, ...args: unknown[]) => boolean)(
        redirect === undefined ? chunk : `${text.trimEnd()}, ${redirect}\n`,
        ...rest,
    );
}) as typeof process.stderr.write;

// Dynamic import so a broken module graph fails inside a catchable block instead of crashing before any handler runs.
// On failure, reports it as an install fault on stdout, not silence, since a silent failure reads as zero results.
let cli: { run: typeof import("@stricli/core").run; app: typeof import("./app.js").app; normalizeArgv: typeof import("./lib/argv.js").normalizeArgv };
try {
    const [core, appModule, argvModule] = await Promise.all([import("@stricli/core"), import("./app.js"), import("./lib/argv.js")]);
    cli = { run: core.run, app: appModule.app, normalizeArgv: argvModule.normalizeArgv };
} catch (error) {
    const detail = error instanceof Error ? error.message.split("\n")[0] : String(error);
    process.stdout.write(
        `iq: cannot start, ${detail}\n` +
            `iq: this is a broken install, NOT an empty result, do not read it as 0 hits or fall back to grep silently. Reinstall iq (or rebuild its workspace deps) and report it.\n`,
    );
    process.exit(2);
}

const { argv, notes, hints } = cli.normalizeArgv(process.argv.slice(2));
if (notes.length > 0) {
    // Also stdout: this is how `search` or `ask` learns its real verb name, past the usual `2>/dev/null`.
    process.stdout.write(`iq: grep dialect absorbed: ${notes.join(", ")}\n`);
}
for (const hint of hints) {
    process.stdout.write(`iq: ${hint}\n`);
}
await cli.run(cli.app, argv, { process: process as StricliProcess });
// Grep convention: 0 hits, 1 none, 2 anything else; clamps stricli's other exit codes.
if (process.exitCode !== undefined && process.exitCode !== 0 && process.exitCode !== 1) {
    process.exitCode = 2;
}
