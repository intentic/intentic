import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { repoRoot } from "@intentic/constants/node";
import { expect, test } from "vitest";

// Refuses module-level reactive state in an extension unless declared through sandboxRef (extension-api/src/scope.ts);
// state that isn't scoped survives a sandbox switch and shows stale data.
// Scoped to what the browser actually loads: walked from each extension's UI entry (src/extension.ts) through its
// relative imports, not listed or filtered by vue imports.
// .vue files are walked through (their imports count) but not checked themselves, since their state is
// per-component-instance and dies with it.

const ROOT = repoRoot(import.meta.url);
const EXTENSIONS = join(ROOT, `_extensions`);

// Exemptions are per finding, not per file, keyed by the exact string a failing test prints.
const EXEMPT = new Map<string, string>([
    [
        `maintenance/src/runs.ts: let sequence`,
        `A per-tab counter that makes two run ids minted in the same millisecond differ. It holds nothing about a
         workspace, and emptying it on a switch would make collisions likelier rather than less.`,
    ],
]);

const allowed = (offenders: readonly string[]): string[] => offenders.filter((offender) => !EXEMPT.has(offender));

// Matches every relative specifier, static or dynamic; lazy import(`./View.vue`) is how most of the browser-side graph
// is reached.
// Matches all three quote characters, backticks included, since this repo writes string literals in backticks.
const relativeImports = (text: string): string[] =>
    [...text.matchAll(/(?:from|import)\s*\(?\s*["'`](\.[^"'`]*)["'`]/g)].map((match) => match[1] ?? ``);

// Resolves one specifier against the importing file; .js is rewritten to .ts, and an extensionless specifier is tried
// as both a file and a directory index.
// A specifier that resolves to nothing (a package, a type-only path) is simply not followed.
const resolveImport = (from: string, specifier: string): string | undefined => {
    const base = resolve(dirname(from), specifier);
    const candidates = base.endsWith(`.vue`) ? [base] : [base.replace(/\.js$/, `.ts`), `${base}.ts`, `${base}.vue`, join(base, `index.ts`)];
    return candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile());
};

// Browser-side import graph of one extension, from its UI entry outward.
// An extension with no entry contributes nothing here, correctly: it contributes no UI either.
const reachableFrom = (entry: string): Set<string> => {
    const seen = new Set<string>();
    const queue = [entry];
    while (queue.length > 0) {
        const file = queue.pop() ?? ``;
        if (seen.has(file)) {
            continue;
        }
        seen.add(file);
        for (const specifier of relativeImports(readFileSync(file, `utf8`))) {
            const next = resolveImport(file, specifier);
            if (next !== undefined) {
                queue.push(next);
            }
        }
    }
    return seen;
};

const extensionSources = (): { path: string; text: string }[] => {
    const entries = readdirSync(EXTENSIONS, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => join(EXTENSIONS, entry.name, `src`, `extension.ts`))
        .filter((entry) => statSync(entry, { throwIfNoEntry: false })?.isFile() === true);
    // One set across every entry: extensions share modules, and a file reached twice is one file to check.
    const reached = new Set<string>();
    for (const entry of entries) {
        for (const file of reachableFrom(entry)) {
            reached.add(file);
        }
    }
    return (
        [...reached]
            .filter((file) => file.endsWith(`.ts`))
            .map((file) => ({ path: relative(EXTENSIONS, file).replaceAll(`\\`, `/`), text: readFileSync(file, `utf8`) }))
    );
};

// Set near the true count so a scan that silently shrinks fails loud, not passes green.
const MIN_SCANNED = 90;

// Column 0 only: the same call indented is inside a function or setup, created per caller, not once.
const MODULE_LEVEL_REACTIVE = /^(?:export )?const\s+(\w+)[^=\n]*=\s*(ref|shallowRef|reactive|shallowReactive)[(<]/gm;
const MODULE_LEVEL_LET = /^(?:export )?let\s+(\w+)/gm;

const scanned = extensionSources();

test("the guard is actually looking at the extensions", () => {
    expect(scanned.length).toBeGreaterThanOrEqual(MIN_SCANNED);
});

// A failure means the named binding is state one sandbox fills that the next inherits; if it shouldn't survive a
// switch, declare it with sandboxRef(() => ...).
// If it genuinely belongs to the app rather than a workspace, add it to EXEMPT with the reason.
test("module-level reactive state in an extension is declared through sandboxRef", () => {
    const offenders = scanned.flatMap(({ path, text }) =>
        [...text.matchAll(MODULE_LEVEL_REACTIVE)].map((match) => `${path}: ${match[1]} = ${match[2]}(…)`),
    );

    expect(allowed(offenders)).toEqual([]);
});

// A module-scope `let` is the same claim as a ref, without vue's help; refused rather than scoped, since the fix is the
// same either way.
// Per-sandbox state becomes a sandboxRef; per-app state becomes a constant or moves inside the function that mutates
// it.
test("an extension keeps no reassignable module-level binding", () => {
    const offenders = scanned.flatMap(({ path, text }) => [...text.matchAll(MODULE_LEVEL_LET)].map((match) => `${path}: let ${match[1]}`));

    expect(allowed(offenders)).toEqual([]);
});

// Declaring state correctly doesn't help if what fills it is hand-written; sandboxPoll (extension-api background.ts)
// bundles the reliability rules a repeating poll needs.
// A repeating clock (setInterval) in extension source is refused for that reason; a one-shot setTimeout (a debounce, a
// timed notice) is untouched.
test("an extension does not run its own repeating clock", () => {
    const offenders = scanned.filter(({ text }) => text.includes(`setInterval(`)).map(({ path }) => `${path}: setInterval(…)`);

    expect(allowed(offenders)).toEqual([]);
});
