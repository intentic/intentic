import { z } from "zod";

/* A WORKFLOW SCRIPT AS AN AGENT WRITES IT: the shape Claude Code's own Workflow tool takes, so a script an agent already
   knows how to write runs here too, on any provider. It opens with `export const meta = { … }`, a pure literal naming the
   workflow (its name, a line describing it, the phases it moves through), and the rest is the body of an async function:
   it calls agent(), parallel(), pipeline(), phase() and log(), and what it returns is the run's result. The meta literal
   is cut out here and read on its own (script-vm.ts reads it in the same sandbox as the body, with nothing to call), so
   nothing about a run needs the body to have run first. */

const PhaseSchema = z.object({ title: z.string().min(1).max(120), detail: z.string().max(500).optional() });

export const ScriptMetaSchema = z.object({
    name: z.string().min(1).max(80),
    description: z.string().max(500).optional(),
    phases: z.array(PhaseSchema).max(40).optional(),
});

// How long a script may be: a program that coordinates agents, not one that does their work.
const MAX_SCRIPT_CHARS = 200_000;

export interface ScriptParts {
    // The meta literal's own text, `{ … }`, for script-vm.ts to read as a value.
    readonly metaLiteral: string;
    // Everything after it: the body of the async function the run executes.
    readonly body: string;
}

const OPENING = /^\s*(?:\/\/[^\n]*\n\s*|\/\*[\s\S]*?\*\/\s*)*export\s+const\s+meta\s*=\s*/u;

// Where the string opened by the quote at `at` closes, a backslash escaping whatever follows it; undefined if never.
const stringEnd = (text: string, at: number): number | undefined => {
    const quote = text[at];
    for (let next = at + 1; next < text.length; next += 1) {
        if (text[next] === "\\") {
            next += 1;
        } else if (text[next] === quote) {
            return next;
        }
    }
    return undefined;
};

// Where what opens at `at` closes, for a string, a template literal or a comment, so its braces are not counted; `at`
// itself for any other character; undefined for one that never closes.
const skipped = (text: string, at: number): number | undefined => {
    const char = text[at];
    if (char === '"' || char === "'" || char === "`") {
        return stringEnd(text, at);
    }
    if (char === "/" && text[at + 1] === "/") {
        const newline = text.indexOf("\n", at);
        return newline < 0 ? text.length : newline;
    }
    if (char === "/" && text[at + 1] === "*") {
        const close = text.indexOf("*/", at + 2);
        return close < 0 ? undefined : close + 1;
    }
    return at;
};

// Where the literal opened at `start` closes: braces counted outside strings, template literals and comments.
const literalEnd = (text: string, start: number): number | undefined => {
    let depth = 0;
    for (let at = start; at < text.length; at += 1) {
        const next = skipped(text, at);
        if (next === undefined) {
            return undefined;
        }
        if (next !== at) {
            at = next;
            continue;
        }
        depth += text[at] === "{" ? 1 : text[at] === "}" ? -1 : 0;
        if (depth === 0 && text[at] === "}") {
            return at + 1;
        }
    }
    return undefined;
};

/** The script's meta literal and body, or why it is not a workflow script. */
export const splitScript = (source: string): ScriptParts | { readonly fault: string } => {
    if (source.length > MAX_SCRIPT_CHARS) {
        return { fault: `The script is ${source.length} characters; keep it under ${MAX_SCRIPT_CHARS}.` };
    }
    const opening = OPENING.exec(source);
    if (opening === null || source[opening[0].length] !== "{") {
        return { fault: "A workflow script opens with `export const meta = { name: \"…\", description: \"…\" }`, a plain object literal." };
    }
    const start = opening[0].length;
    const end = literalEnd(source, start);
    if (end === undefined) {
        return { fault: "The `meta` literal never closes: check its braces and quotes." };
    }
    const rest = source.slice(end).replace(/^\s*;?/u, "");
    if (/^\s*(?:import|export)\s/mu.test(rest)) {
        return { fault: "A workflow script has no imports or exports past its `meta`: everything it calls (agent, parallel, pipeline, phase, log) is already there." };
    }
    return { metaLiteral: source.slice(start, end), body: rest };
};
