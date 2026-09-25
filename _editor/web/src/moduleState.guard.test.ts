import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { allowedAt } from "@intentic/constants/allow";

// Refuses module-level reactive state in the editor unless it is declared through the sandbox scope (sandboxRef,
// sandboxShallowRef, sandboxValue from @intentic/extension-api, reset on every switch) or marked app-wide where it is
// declared: `// allow(module-state): <why it is not about one sandbox>` on the line above (@intentic/constants/allow).
// On the declaration rather than in a list here, so a rename carries it and a deletion takes it away.
// Found by shape over every module under src/, the way extension-host/sandboxScope.guard.test.ts reads the extensions:
// a .ts whole, a .vue's plain <script> only, since <script setup> runs per component instance and dies with it.

const SRC = import.meta.dirname;

// A component's plain <script> blocks: code that runs once, at module level, beside its per-instance <script setup>.
const PLAIN_SCRIPT = /<script(?![^>]*\bsetup\b)[^>]*>([\s\S]*?)<\/script>/g;
const isModule = (name: string): boolean => name.endsWith(`.vue`) || (name.endsWith(`.ts`) && !name.endsWith(`.test.ts`) && !name.endsWith(`.d.ts`));
const moduleCodeOf = (name: string, text: string): string =>
    name.endsWith(`.vue`) ? [...text.matchAll(PLAIN_SCRIPT)].map((match) => match[1] ?? ``).join(`\n`) : text;

// Every non-test module under src/, as a path relative to it; `testing/` holds the fakes suites share.
const sources = (): { path: string; text: string }[] => {
    const found: { path: string; text: string }[] = [];
    const walk = (dir: string): void => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            const full = join(dir, entry.name);
            if (entry.isDirectory()) {
                if (full !== join(SRC, `testing`)) {
                    walk(full);
                }
                continue;
            }
            if (isModule(entry.name)) {
                found.push({ path: relative(SRC, full).replaceAll(`\\`, `/`), text: moduleCodeOf(entry.name, readFileSync(full, `utf8`)) });
            }
        }
    };
    walk(SRC);
    return found;
};

// Set near the true count so a scan that silently shrinks fails loud, not passes green.
const MIN_SCANNED = 900;

// Column 0 only: the same call indented is inside a function or setup, created per caller, not once. The declaration
// may carry a type with arrows in it (`Ref<() => void>`), so the `=` is the one right before the call.
const MODULE_LEVEL_REACTIVE = /^(?:export )?(?:const|let)\s+(\w+)\b[^\n]*?=\s*(ref|shallowRef|reactive|shallowReactive)\s*[(<]/gm;

const CHECK = `module-state`;

const scanned = sources();
// Each module-level reactive declaration, as the failure names it, and whether its site carries the pragma.
const declarations = scanned.flatMap(({ path, text }) => {
    const lines = text.split(`\n`);
    return [...text.matchAll(MODULE_LEVEL_REACTIVE)].map((match) => {
        const line = text.slice(0, match.index).split(`\n`).length;
        return { finding: `${path}:${line}: ${match[1]} = ${match[2]}(…)`, allowed: allowedAt(lines, line, CHECK) };
    });
});
// Every pragma whose comment block does not end on a module-level reactive declaration, as `path:line`.
const PRAGMA = new RegExp(String.raw`^\s*//\s*allow\(${CHECK}\):`);
const COMMENT = /^\s*\/\//;
const DECLARES = new RegExp(MODULE_LEVEL_REACTIVE.source);
const strayPragmas = scanned.flatMap(({ path, text }) => {
    const lines = text.split(`\n`);
    return lines.flatMap((line, at) => {
        if (!PRAGMA.test(line)) {
            return [];
        }
        let next = at + 1;
        while (next < lines.length && COMMENT.test(lines[next]!)) {
            next++;
        }
        return DECLARES.test(lines[next] ?? ``) ? [] : [`${path}:${at + 1}`];
    });
});

test(`the guard is actually looking at the editor`, () => {
    expect(scanned.length).toBeGreaterThanOrEqual(MIN_SCANNED);
});

// A failure names state one sandbox fills that the next would inherit: declare it with sandboxRef(() => …) (or
// sandboxShallowRef/sandboxValue), with a dispose for whatever a switch must also end. If it genuinely belongs to the
// app rather than a sandbox, mark its declaration `// allow(module-state): <reason>`.
test(`module-level reactive state is declared through the sandbox scope, or marked app-wide`, () => {
    expect(declarations.filter(({ allowed }) => !allowed).map(({ finding }) => finding)).toEqual([]);
});

// A pragma left behind when its state was scoped or deleted would sit above whatever declaration moved up under it.
test(`every app-wide pragma sits on module-level reactive state`, () => {
    expect(strayPragmas).toEqual([]);
});
