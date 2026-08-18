import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
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
 * SCOPED TO FILES THAT IMPORT VUE, which is exactly the population at risk and costs nothing to determine.
 * More than half of what is under `_extensions` runs in the daemon or in a CLI — a Slack client's connection
 * map, an argument parser's switch set — where there is no sandbox to be scoped to and no rail to mislead. A
 * vue import is what marks a file as browser-side, and it is also the only way to reach `ref` in the first
 * place, so the two questions have the same answer.
 *
 * `.vue` files are exempt as a class rather than by entry: their state is per component instance and dies with
 * the component, which is the one thing module state does not do.
 *
 * Scanned rather than listed, on the repo's rule: a list of "extensions that keep state" is a list that is
 * wrong within a week, and the one added to it last is the one that would have needed it. */

const ROOT = repoRoot(import.meta.url);
const EXTENSIONS = join(ROOT, `_extensions`);

/* Exemptions carry a reason, not just a path. Empty today, and that is the point of writing it down: the next
 * addition is a decision somebody has to defend in review rather than a line quietly added to an array. */
const EXEMPT = new Map<string, string>();

const sourceFiles = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
            return entry.name === `node_modules` || entry.name === `dist` ? [] : sourceFiles(full);
        }
        return entry.name.endsWith(`.ts`) && !entry.name.endsWith(`.test.ts`) ? [full] : [];
    });

// Browser-side, asked as "does it import vue" — see the header. A type-only import counts: it means the file
// is compiled for the browser, and the rules below are about what it may declare, not about what it names.
const importsVue = (text: string): boolean => /^import\s[^;]*?\sfrom\s+["']vue["'];/ms.test(text);

const extensionSources = (): { path: string; text: string }[] => {
    const dirs = readdirSync(EXTENSIONS, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => join(EXTENSIONS, entry.name, `src`))
        .filter((dir) => statSync(dir, { throwIfNoEntry: false })?.isDirectory() === true);
    return dirs
        .flatMap(sourceFiles)
        .map((file) => ({ path: relative(EXTENSIONS, file).replaceAll(`\\`, `/`), text: readFileSync(file, `utf8`) }))
        .filter((file) => !EXEMPT.has(file.path) && importsVue(file.text));
};

// Nothing to guard is a broken guard, not a passing one — a moved or renamed directory would otherwise read as
// green. Well under the count today, so ordinary deletions do not trip it.
const MIN_SCANNED = 15;

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

    expect(offenders).toEqual([]);
});

/* A `let` at module scope is the same claim written without vue's help — `let watched: readonly string[] = []`
 * in the deployments badge was one, and it decided which connections the poll asked about. It is refused
 * rather than scoped because the fix is the same either way: if it is per-sandbox it is a `sandboxRef`, and if
 * it is per-app it is a constant or it belongs inside the function that mutates it. */
test("an extension keeps no reassignable module-level binding", () => {
    const offenders = scanned.flatMap(({ path, text }) => [...text.matchAll(MODULE_LEVEL_LET)].map((match) => `${path}: let ${match[1]}`));

    expect(offenders).toEqual([]);
});
