// What sandbox-scope.mjs reads a file for: the places an editor file speaks of THE active sandbox without saying so, by
// shape, since the checks run before install. Kept apart from the check so its suite can feed it text.
import { allowedAt } from "./allow.mjs";

// Comments say what a shape is without being one: blanked, keeping offsets so line numbers still match. A Vue file's
// template comments too.
const blanked = (match) => match.replace(/[^\n]/g, ` `);
const uncommented = (text) =>
    text
        .replace(/<!--[\s\S]*?-->/g, blanked)
        .replace(/\/\*[\s\S]*?\*\/|(^|[^:\\])\/\/[^\n]*/g, (match, lead = ``) => lead + blanked(match.slice(lead.length)));

// An import or re-export names a binding without reading it: blanked too, however many lines it spans.
const unimported = (code) => code.replace(/^[ \t]*(?:import|export)\b[^;]*?\bfrom\s*["'][^"']+["'];?/gm, blanked);

const lineOf = (text, index) => text.slice(0, index).split(`\n`).length;

const CLOSE = { "(": `)`, "[": `]`, "{": `}` };

// The text between the bracket at `open` and the one that closes it, skipping strings, or undefined when it never closes.
export const balanced = (code, open) => {
    const stack = [];
    for (let at = open; at < code.length; at += 1) {
        const char = code[at];
        if (char === `"` || char === `'` || char === "`") {
            let end = at + 1;
            while (end < code.length && code[end] !== char) {
                end += code[end] === `\\` ? 2 : 1;
            }
            at = end;
        } else if (CLOSE[char] !== undefined) {
            stack.push(CLOSE[char]);
        } else if (char === stack.at(-1)) {
            stack.pop();
            if (stack.length === 0) {
                return code.slice(open + 1, at);
            }
        }
    }
    return undefined;
};

// The top-level arguments of a call's argument text, split at the commas no bracket or string holds.
const topLevelArgs = (args) => {
    const parts = [];
    let depth = 0;
    let start = 0;
    for (let at = 0; at < args.length; at += 1) {
        const char = args[at];
        if (char === `"` || char === `'` || char === "`") {
            let end = at + 1;
            while (end < args.length && args[end] !== char) {
                end += args[end] === `\\` ? 2 : 1;
            }
            at = end;
        } else if (CLOSE[char] !== undefined) {
            depth += 1;
        } else if (char === `)` || char === `]` || char === `}`) {
            depth -= 1;
        } else if (char === `,` && depth === 0) {
            parts.push(args.slice(start, at));
            start = at + 1;
        }
    }
    parts.push(args.slice(start));
    return parts;
};

// `at` given a value, written out (`at: id`) or as shorthand (`{ at }`, `{ at, background }`).
const NAMES_AT = /(?:^|[{,\s])at\s*(?::|,|\}|$)/;

// The `context: { … }` a call's options carry, when they carry one written out.
const contextOf = (args) => {
    const found = /\bcontext\s*:\s*\{/.exec(args);
    return found === null ? undefined : balanced(args, found.index + found[0].length - 1);
};

// Optional chaining and type arguments are the same call: `sandboxRpc.agents?.list(`, `rpcQuery<N>(`.
const RPC_CALL = /\bsandboxRpc\s*\??\.\s*\w+\s*\??\.\s*\w+\s*(?:\?\.\s*)?(?:<[^()]*?>\s*)?\(/g;
const RPC_QUERY = /\brpcQuery\s*(?:<[^()]*?>\s*)?\(/g;
const ACTIVE = /\bactiveSandboxId\b/;

const WHY = {
    active: `reads the active sandbox's id: speak of the sandbox this code stands in with useSandboxScope() (scope.id, scope.at)`,
    rpc: `calls sandboxRpc with no \`at\`, so it reaches the active sandbox: call scope.rpc from useSandboxScope(), or pass \`context: { at }\``,
    query: `reads rpcQuery with no \`at\`, so it keys and asks the active sandbox: use scope.query from useSandboxScope(), or pass \`{ at }\``,
};

/** Every single-sandbox read in `text`, as `{ line, why }`, less the ones a `// allow(sandbox-scope): <reason>` excuses. */
export const sandboxScopeCalls = (text) => {
    const lines = text.split(`\n`);
    const code = unimported(uncommented(text));
    const found = [];
    code.split(`\n`).forEach((line, index) => {
        if (ACTIVE.test(line)) {
            found.push({ line: index + 1, why: WHY.active });
        }
    });
    for (const match of code.matchAll(RPC_CALL)) {
        const args = balanced(code, match.index + match[0].length - 1) ?? ``;
        const context = contextOf(args);
        if (context === undefined || !NAMES_AT.test(context)) {
            found.push({ line: lineOf(code, match.index), why: WHY.rpc });
        }
    }
    for (const match of code.matchAll(RPC_QUERY)) {
        // Only the options, the third argument, aim the read: an input that carries a field named `at` aims nothing.
        const options = topLevelArgs(balanced(code, match.index + match[0].length - 1) ?? ``)[2] ?? ``;
        if (!NAMES_AT.test(options)) {
            found.push({ line: lineOf(code, match.index), why: WHY.query });
        }
    }
    return found.filter(({ line }) => !allowedAt(lines, line, `sandbox-scope`)).toSorted((a, b) => a.line - b.line);
};
