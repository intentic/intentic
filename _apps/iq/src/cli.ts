#!/usr/bin/env node
import type { StricliProcess } from "@stricli/core";
import { run } from "@stricli/core";
import { app } from "./app.js";

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

// Annotate stricli's terse alias errors in place — wrap the real stream's write (process.stderr itself is a
// getter-only property, so it can't be shadowed on a wrapper object; the write method is what stricli calls).
const originalWrite = process.stderr.write.bind(process.stderr);
process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
    const text = typeof chunk === "string" ? chunk : chunk.toString();
    const alias = /No alias registered for -(\w)/.exec(text)?.[1];
    const redirect = alias !== undefined ? FLAG_REDIRECTS[alias] : undefined;
    return (originalWrite as (value: string | Uint8Array, ...args: unknown[]) => boolean)(
        redirect === undefined ? chunk : `${text.trimEnd()} — ${redirect}\n`,
        ...rest,
    );
}) as typeof process.stderr.write;

await run(app, process.argv.slice(2), { process: process as StricliProcess });
// Grep convention: 0 hits, 1 none, 2 anything else — clamp stricli's negative scanner/routing codes.
if (process.exitCode !== undefined && process.exitCode !== 0 && process.exitCode !== 1) {
    process.exitCode = 2;
}
