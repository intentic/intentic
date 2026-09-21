#!/usr/bin/env node
// The shared agent-CLI shell (@intentic/agent-cli/run) is the ONE thing this file may import at runtime: it pulls
// nothing in itself, so iq's own module graph — engine, index, embedder — still loads inside a catch that can
// report a bad install rather than dying as a stack an agent's `2>/dev/null` turns into an empty result.
import { runAgentCli } from "@intentic/agent-cli/run";

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

// Turns stricli's own wording into the one instruction that fixes the invocation; undefined keeps it as it is.
const redirect = (text: string): string | undefined => {
    const alias = /No alias registered for -(\w)/.exec(text)?.[1];
    // An unknown long flag surfaces as a surplus positional, so "too many arguments" covers two different mistakes.
    const surplus = /Too many arguments[^"]*"([^"]*)"/.exec(text)?.[1];
    const hint =
        alias !== undefined
            ? FLAG_REDIRECTS[alias]
            : surplus?.startsWith("-") === true
              ? `${surplus} is not a flag: ${FLAG_HELP}`
              : /Too many arguments/.test(text)
                ? 'each verb takes ONE query: quote multi-word queries (iq q "…") and scope with --in <dir>'
                : /No flag registered for --([\w-]+)/.test(text)
                  ? FLAG_HELP
                  : undefined;
    return hint === undefined ? undefined : `${text.trimEnd()}, ${hint}\n`;
};

await runAgentCli({
    name: "iq",
    noun: "result",
    rewriteStderr: redirect,
    load: async () => {
        const [appModule, argvModule] = await Promise.all([import("./app.js"), import("./lib/argv.js")]);
        return {
            app: appModule.app,
            prepareArgv: (raw) => {
                const { argv, notes, hints } = argvModule.normalizeArgv([...raw]);
                // The notes are how `search` or `ask` learns its real verb name; they ride on stdout with the hints.
                return { argv, lines: [...(notes.length > 0 ? [`grep dialect absorbed: ${notes.join(", ")}`] : []), ...hints] };
            },
        };
    },
});
