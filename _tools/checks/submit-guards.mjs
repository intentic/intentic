#!/usr/bin/env node
// An Enter key bound to an async handler that writes something, with nothing stopping the second press while the first
// is still in flight. The button beside it is usually `:disabled`/`:loading` and so is safe; the keyboard path reaches
// the handler directly, and that is the path an impatient user takes. Measured shape, not a style preference: a held
// Enter on one such dialog fired five extension creations.
//
// Guarded is decided by structure, not by what a flag is called: before its first `await`, the handler must test
// something in an early return that it then also sets (or clears), or hand the work to a local that does. Naming the
// flags instead would pass `saveError` as a guard and fail `replying`.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { finish } from "./lib/report.mjs";
import { packages, root, VUE_FILE, walk } from "./lib/repo.mjs";

const vueHost = packages.find(({ pkg }) => pkg.dependencies?.vue !== undefined || pkg.devDependencies?.vue !== undefined);
const compiler = (() => {
    if (vueHost === undefined) {
        return undefined;
    }
    try {
        return createRequire(join(vueHost.dir, "package.json"))("vue/compiler-sfc");
    } catch {
        return undefined;
    }
})();

// A function body, from its opening brace to the matching one; brace-counted, since a body holds object literals and
// nested arrows that no bounded regex survives.
const bodyOf = (source, name) => {
    const start = new RegExp(`\\b(?:const|function)\\s+${name}\\b[^\\n]*?\\{`).exec(source);
    if (start === null) {
        return undefined;
    }
    let depth = 0;
    for (let at = start.index + start[0].length - 1; at < source.length; at += 1) {
        if (source[at] === "{") {depth += 1;}
        else if (source[at] === "}" && --depth === 0) {return source.slice(start.index, at + 1);}
    }
    return undefined;
};

// `const spec = creating.value` makes `spec` stand for `creating`: the early return tests the alias and the body clears
// the ref, and those have to be recognised as the same latch.
const aliases = (head) => {
    const map = new Map();
    for (const [, local, source] of head.matchAll(/\bconst\s+([a-zA-Z_$][\w$]*)\s*=\s*([a-zA-Z_$][\w$]*)(?:\.value)?/g)) {
        map.set(local, source);
    }
    return map;
};
const named = (text, map) => new Set([...text.matchAll(/([a-zA-Z_$][\w$]*)/g)].map(([, name]) => map.get(name) ?? name));

// True when the head refuses on something it then also latches: the one shape that actually stops a second press.
const latchesWhatItTests = (head) => {
    const map = aliases(head);
    const tested = new Set();
    for (const [, condition] of head.matchAll(/\bif\s*\(([\s\S]*?)\)\s*\{?\s*(?:\n\s*)?return\b/g)) {
        for (const identifier of named(condition, map)) {
            tested.add(identifier);
        }
    }
    const latched = new Set();
    for (const [, target] of head.matchAll(/([a-zA-Z_$][\w$]*)(?:\.value)?\s*=\s*(?!=)/g)) {
        latched.add(map.get(target) ?? target);
    }
    for (const [, target] of head.matchAll(/([a-zA-Z_$][\w$]*)\.(?:add|set|delete)\s*\(/g)) {
        latched.add(map.get(target) ?? target);
    }
    return [...tested].some((identifier) => latched.has(identifier));
};

// `useAsyncAction`'s `run` drops re-entry itself; so does any local that guards.
const delegatesToAGuard = (script, body, name, seen) => {
    for (const [, callee] of body.matchAll(/\b([a-zA-Z_$][\w$]*)\s*\(/g)) {
        if (callee === "run" || (callee !== name && guards(script, callee, seen))) {
            return true;
        }
    }
    return false;
};

// Whether one handler drops a second call; `seen` stops a cycle, and delegation is followed through locals.
const guards = (script, name, seen = new Set()) => {
    if (seen.has(name)) {
        return false;
    }
    seen.add(name);
    const body = bodyOf(script, name);
    if (body === undefined) {
        return false;
    }
    const firstAwait = body.indexOf("await");
    const head = firstAwait === -1 ? body : body.slice(0, firstAwait);
    return latchesWhatItTests(head) || delegatesToAGuard(script, body, name, seen);
};

const unguarded = [];
const checked = [];
if (compiler !== undefined) {
    const { parse: parseSfc } = compiler;
    for (const file of walk(root, VUE_FILE)) {
        const relative = file.slice(root.length + 1);
        const { descriptor, errors } = parseSfc(readFileSync(file, "utf8"), { filename: file });
        // An unparseable template is vue-templates.mjs's complaint, not this one's.
        if (errors.length > 0 || descriptor.template === null || descriptor.scriptSetup === null) {
            continue;
        }
        const script = descriptor.scriptSetup.content;
        const handlers = new Set();
        for (const [, binding] of descriptor.template.content.matchAll(/@key(?:up|down)\.enter[.\w]*="([^"]+)"/g)) {
            // `x && submit()`, `submit`, `submit()` all name the same handler.
            const handler = /([a-zA-Z_$][\w$]*)\s*\(/.exec(binding)?.[1] ?? /^\s*([a-zA-Z_$][\w$]*)\s*$/.exec(binding)?.[1];
            if (handler !== undefined) {
                handlers.add(handler);
            }
        }
        for (const handler of handlers) {
            const body = bodyOf(script, handler);
            // Not an async handler, or defined elsewhere: nothing to say about it.
            if (body === undefined || !/\bawait\b/.test(body)) {
                continue;
            }
            checked.push(`${relative}:${handler}`);
            if (!guards(script, handler)) {
                unguarded.push(`${relative}: \`${handler}\` is bound to Enter, awaits, and nothing drops the second press`);
            }
        }
    }
}

finish(
    [
        [
            "An Enter-bound handler can run again while its own write is still in flight (test an in-flight flag in an early return and set it before awaiting, or route the work through useAsyncAction)",
            unguarded,
        ],
    ],
    [
        compiler === undefined
            ? `submit guards: not read (vue/compiler-sfc needs node_modules, and this ran before the install)`
            : `submit guards: all ${checked.length} Enter-bound async handlers drop a second press`,
    ],
);
