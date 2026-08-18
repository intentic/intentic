import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { repoRoot } from "@intentic/constants/node";
import { expect, test } from "vitest";

/* THE STATE RULE FOR EXTENSIONS, MADE UNAVOIDABLE.
 *
 * A rail badge has to be filled from state that OUTLIVES its view being unmounted — a count you only see once
 * you have already opened the surface tells you nothing — so every extension that badges keeps a module-level
 * ref and a timer that fills it. That much is correct and the API asks for it.
 *
 * What nothing owned was the other end: emptying that state when the browser is pointed at a different
 * sandbox. Maintenance therefore showed `21` with a tooltip describing chores in a workspace the reader had
 * left, for up to ten minutes after the switch — and it was not one extension's slip. Six of them had the
 * identical shape, which is what a missing primitive looks like rather than what carelessness looks like.
 *
 * `sandboxRef` (extension-api/src/scope.ts) is the primitive, and this is the rule that keeps it the only
 * answer: module-level reactive state in an extension is declared through it, or it is refused here. A plain
 * `let` at module scope is refused for the same reason under another spelling.
 *
 * SCOPED TO WHAT THE BROWSER ACTUALLY LOADS, reached by walking each extension's UI entry (`src/extension.ts`,
 * the module the host calls `activate` on) through its own relative imports. More than half of what is under
 * `_extensions` runs in the daemon or in a CLI — a Slack client's connection map, an argument parser's switch
 * set — where there is no sandbox to be scoped to and no rail to mislead, and an extension with no
 * `src/extension.ts` contributes no UI at all.
 *
 * The graph, rather than "does the file import vue", and the difference is not academic: unifying these polls
 * behind `sandboxPoll` took the vue import out of all seven of them, so a vue-shaped filter would have silently
 * stopped looking at precisely the files this exists to watch — and passed, greener than before.
 *
 * `.vue` files are walked THROUGH but not checked: their state is per component instance and dies with the
 * component, which is the one thing module state does not do. Their imports still count, because a view's
 * helper module is as module-scoped as any other.
 *
 * Walked rather than listed, on the repo's rule: a list of "extensions that keep state" is a list that is
 * wrong within a week, and the one added to it last is the one that would have needed it. */

const ROOT = repoRoot(import.meta.url);
const EXTENSIONS = join(ROOT, `_extensions`);

/* Exemptions are per FINDING, not per file, and each carries the sentence that justifies it — so exempting one
 * counter does not quietly stop guarding everything else in the module it lives in. The key is the exact string
 * a test below reports, which is also what a failure prints, so granting one is a copy of the failure line and
 * a reason for it. */
const EXEMPT = new Map<string, string>([
    [
        `maintenance/src/runs.ts: let sequence`,
        `A per-tab counter that makes two run ids minted in the same millisecond differ. It holds nothing about a
         workspace, and emptying it on a switch would make collisions likelier rather than less.`,
    ],
]);

const allowed = (offenders: readonly string[]): string[] => offenders.filter((offender) => !EXEMPT.has(offender));

/* Every relative specifier the file names, static or dynamic — the lazy `import(\`./SomeView.vue\`)` behind a
 * registered view is how most of the browser-side graph is reached, and a view's own helper modules with it.
 *
 * All three quote characters, backticks included. This repo writes string literals in backticks by house
 * style, so a matcher that only knew `"` and `'` would follow the static imports and none of the lazy ones —
 * which is to say it would miss every view in the product and everything only a view imports. */
const relativeImports = (text: string): string[] =>
    [...text.matchAll(/(?:from|import)\s*\(?\s*["'`](\.[^"'`]*)["'`]/g)].map((match) => match[1] ?? ``);

/* Resolve one specifier against the importing file. `.js` is rewritten to `.ts` — several extensions write
 * ESM-correct specifiers that TypeScript resolves to source — and an extensionless one is tried as both a file
 * and a directory index. A specifier that resolves to nothing is simply not followed: it is a package, or a
 * type-only path this walk has no business failing over. */
const resolveImport = (from: string, specifier: string): string | undefined => {
    const base = resolve(dirname(from), specifier);
    const candidates = base.endsWith(`.vue`) ? [base] : [base.replace(/\.js$/, `.ts`), `${base}.ts`, `${base}.vue`, join(base, `index.ts`)];
    return candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile());
};

// The browser-side graph of one extension, from its UI entry outwards. Extensions with no entry contribute
// nothing here, which is correct: they contribute no UI either.
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
            // `.vue` is walked through above and checked by nobody: see the header.
            .filter((file) => file.endsWith(`.ts`))
            .map((file) => ({ path: relative(EXTENSIONS, file).replaceAll(`\\`, `/`), text: readFileSync(file, `utf8`) }))
    );
};

/* Nothing to guard is a broken guard, not a passing one. This floor is doing real work rather than being
 * defensive boilerplate: the previous version of this file selected files by "does it import vue", and
 * unifying the polls removed that import from all seven of the files it existed to watch. The scan silently
 * shrank and the suite went greener. A floor set near the true count is what turns that into a failure.
 *
 * 118 browser-side modules today, across 15 extensions with a UI entry. */
const MIN_SCANNED = 90;

// Column 0 is what makes it module state: the same call indented is inside a function, a component's setup, or
// a factory, and is created per caller rather than once per page load.
const MODULE_LEVEL_REACTIVE = /^(?:export )?const\s+(\w+)[^=\n]*=\s*(ref|shallowRef|reactive|shallowReactive)[(<]/gm;
const MODULE_LEVEL_LET = /^(?:export )?let\s+(\w+)/gm;

const scanned = extensionSources();

test("the guard is actually looking at the extensions", () => {
    expect(scanned.length).toBeGreaterThanOrEqual(MIN_SCANNED);
});

/* Read a failure like this: the named binding is state that one sandbox fills and the next sandbox inherits.
 * If it should not survive a switch — and for a badge, a presence map or a poll result it should not — declare
 * it with `sandboxRef(() => …)` and it is emptied for you. If it genuinely belongs to the app rather than to a
 * workspace, add it to EXEMPT above with the sentence that says why. */
test("module-level reactive state in an extension is declared through sandboxRef", () => {
    const offenders = scanned.flatMap(({ path, text }) =>
        [...text.matchAll(MODULE_LEVEL_REACTIVE)].map((match) => `${path}: ${match[1]} = ${match[2]}(…)`),
    );

    expect(allowed(offenders)).toEqual([]);
});

/* A `let` at module scope is the same claim written without vue's help — `let watched: readonly string[] = []`
 * in the deployments badge was one, and it decided which connections the poll asked about. It is refused
 * rather than scoped because the fix is the same either way: if it is per-sandbox it is a `sandboxRef`, and if
 * it is per-app it is a constant or it belongs inside the function that mutates it. */
test("an extension keeps no reassignable module-level binding", () => {
    const offenders = scanned.flatMap(({ path, text }) => [...text.matchAll(MODULE_LEVEL_LET)].map((match) => `${path}: let ${match[1]}`));

    expect(allowed(offenders)).toEqual([]);
});

/* THE OTHER HALF OF THE SAME RULE. Declaring the state correctly is worth little if the thing that FILLS it is
 * still hand-written: the poll behind a rail badge carries five rules that are each invisible until broken —
 * never reject, skip when the daemon is down, discard an answer that outlived its sandbox, keep the last good
 * value, stop the clock on disposal — and seven modules across six extensions had written them out by hand.
 *
 * `sandboxPoll` (extension-api background.ts) is those five rules in one place, so a repeating clock in an
 * extension's browser-side source is refused: whatever it drives wants that poll instead. A one-shot
 * `setTimeout` is untouched — a debounce, or "clear this notice in eight seconds", is not a background reader. */
test("an extension does not run its own repeating clock", () => {
    const offenders = scanned.filter(({ text }) => text.includes(`setInterval(`)).map(({ path }) => `${path}: setInterval(…)`);

    expect(allowed(offenders)).toEqual([]);
});
