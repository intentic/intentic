import { readFileSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { repoRoot } from "@intentic/constants/node";
import { compile } from "tailwindcss";
import { expect, test } from "vitest";

/* CI GUARD FOR THE PROMISE — that every class a first-party extension screen uses is one core has DECLARED
 * (styles/extension-surface.css), not one it happens to emit because that screen's source sits in this repo.
 *
 * This is the invariant the whole "extensions can live in their own repository" plan rests on, and it is
 * invisible without a test. The app builds fine either way: a class the surface forgot still works today,
 * because Tailwind sees it while scanning something else, and fails only later — silently, in somebody else's
 * sandbox, after the extension has moved out and its markup is no longer being read by anything. There is no
 * error, no 404 and no console warning; the screen simply renders as a near-miss of itself.
 *
 * HOW IT ASKS THE QUESTION. It compiles the design system with source scanning switched OFF, so the only
 * classes it can possibly emit are the promised ones, and then feeds it every token the extension sources
 * contain. If the output grows, something in those screens was reachable only by being read. */

const ROOT = repoRoot(import.meta.url);
const require = createRequire(import.meta.url);

const SURFACE = `
@layer theme, base, primeng, components, utilities;
@import "tailwindcss" source(none);
@import "./_editor/ui/src/styles/shared/index.css";
@import "./_editor/ui/src/styles/core/index.css";
@import "./_editor/ui/src/styles/extension-surface.css";
`;

// Tailwind's compiler does not touch the filesystem itself; `@import` is resolved by whatever the caller
// supplies. Relative ids resolve against the importing sheet's directory, and the one bare id is the framework
// itself, whose own entry then imports its parts relatively through this same function.
const loadStylesheet = async (id: string, base: string): Promise<{ path: string; base: string; content: string }> => {
    const path = id.startsWith(`.`) ? join(base, id) : require.resolve(join(id, `index.css`));
    return { path, base: dirname(path), content: readFileSync(path, `utf8`) };
};

const sourceFiles = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const path = join(dir, entry.name);
        return entry.isDirectory() ? sourceFiles(path) : path.endsWith(`.vue`) || path.endsWith(`.ts`) ? [path] : [];
    });

/* Every token an extension source contains that could be a class, erring hard towards MORE.
 *
 * Deliberately crude, and deliberately over-greedy: a candidate that is not a real utility compiles to nothing
 * and costs this test nothing, whereas a real class it failed to notice would let exactly the defect above
 * through. Each token is offered twice, once as it sits between delimiters and once with its surrounding
 * punctuation trimmed, because a class can end a sentence of markup or a CSS declaration can end in a colon —
 * and the trimmed form is what Tailwind's own scanner sees. Asserted equivalent to that scanner's answer on
 * this tree at the time of writing; it is not a reimplementation of it, only a wider net feeding the same
 * compiler, which is the half that actually decides what a class is. */
const candidatesIn = (files: readonly string[]): string[] => {
    const found = new Set<string>();
    for (const file of files) {
        for (const raw of readFileSync(file, `utf8`).split(/[\s"'`=<>{}();]+/u)) {
            if (raw === ``) {
                continue;
            }
            found.add(raw);
            const trimmed = raw.replace(/^[^\w@-]+/u, ``).replace(/[^\w\]%)]+$/u, ``);
            if (trimmed !== ``) {
                found.add(trimmed);
            }
        }
    }
    return [...found];
};

/* Tokens that compile to a utility but are not one anybody wrote. `flex-shrink` is a real Tailwind class AND a
 * real CSS property, so neither the net above nor the compiler can tell that this one came out of a `<style>`
 * block in MediaViewer.vue. Naming it here says "we looked", which is more honest than widening the promise to
 * cover a class no markup contains. */
const NOT_CLASSES = new Set([`flex-shrink`]);

const classesOf = (css: string): Set<string> =>
    new Set([...css.matchAll(/\.(-?(?:[A-Za-z_]|\\.)(?:[\w-]|\\.)*)/gu)].map((match) => (match[1] ?? ``).replaceAll(/\\(.)/gu, `$1`)));

// A fresh compiler per build: `build()` accumulates the candidates it has been given, so two calls on one
// instance would measure the union rather than each set.
const surfaceBuild = async (): Promise<(candidates: string[]) => string> =>
    (await compile(SURFACE, { base: ROOT, loadStylesheet })).build;

test("every class the first-party extensions use is one the surface promises", async () => {
    const screens = readdirSync(join(ROOT, `_extensions`), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => join(ROOT, `_extensions`, entry.name, `src`))
        .filter((dir) => statSync(dir, { throwIfNoEntry: false })?.isDirectory() === true);

    const promised = classesOf((await surfaceBuild())([]));
    const reached = classesOf((await surfaceBuild())(candidatesIn(screens.flatMap(sourceFiles))));
    const offSurface = [...reached].filter((name) => !promised.has(name) && !NOT_CLASSES.has(name)).toSorted();

    /* Read the failure like this: each name is a class that works ONLY while its extension is built here. An
     * arbitrary value (`w-[37px]`, `max-w-[64ch]`) can never be promised — put it on the scale, give it a name
     * in tokens.css if it deserves one, or move the rule into the extension's own stylesheet. Anything else is
     * a rung the surface is missing and should grow. */
    expect(offSurface).toEqual([]);
}, 60_000);

/* The bill for the promise, asserted rather than admired. Declaring a family whole emits utilities nobody is
 * using yet, which is what a promise costs and why the number belongs in front of whoever widens it next: this
 * is the file that turns "add one more variant" from a shrug into a decision. The ceiling is generous enough
 * that ordinary additions do not trip it and tight enough that a multiplied family — a breakpoint laid over
 * the colour matrix, say — cannot land unnoticed. Raise it on purpose, with the new figure in the commit. */
test("the promise stays within its size budget", async () => {
    const css = (await surfaceBuild())([]);
    expect({ bytes: css.length > 900_000, classes: classesOf(css).size > 8_000 }).toEqual({ bytes: false, classes: false });
}, 60_000);
