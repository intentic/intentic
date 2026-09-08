import { readFileSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { repoRoot } from "@intentic/constants/node";
import { compile } from "tailwindcss";
import { expect, test } from "vitest";

// CI guard for the promise that every class a first-party extension screen uses is one core has declared
// (styles/extension-surface.css), not one it happens to emit because that screen's source sits in this repo.
//
// This is the invariant the "extensions can live in their own repository" plan rests on. A class the surface forgot
// still works today, since Tailwind sees it while scanning something else, and fails only later, silently, once the
// extension has moved out: no error, no 404, the screen just renders as a near-miss of itself.
//
// It compiles the design system with source scanning switched off, so the only classes it can emit are the promised
// ones, then feeds it every token the extension sources contain; if the output grows, something was reachable only by
// being read.

const ROOT = repoRoot(import.meta.url);
const require = createRequire(import.meta.url);

const SURFACE = `
@layer theme, base, primeng, components, utilities;
@import "tailwindcss" source(none);
@import "./_editor/ui/src/styles/index.css";
@import "./_editor/ui/src/styles/opt-in/extension-surface.css";
`;

// Tailwind's compiler does not touch the filesystem itself; `@import` is resolved by whatever the caller supplies.
// Relative ids resolve against the importing sheet's directory; the one bare id is the framework itself.
const loadStylesheet = async (id: string, base: string): Promise<{ path: string; base: string; content: string }> => {
    const path = id.startsWith(`.`) ? join(base, id) : require.resolve(join(id, `index.css`));
    return { path, base: dirname(path), content: readFileSync(path, `utf8`) };
};

const sourceFiles = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const path = join(dir, entry.name);
        return entry.isDirectory() ? sourceFiles(path) : path.endsWith(`.vue`) || path.endsWith(`.ts`) ? [path] : [];
    });

// Every token an extension source contains that could be a class, erring hard towards more: a false positive compiles
// to nothing and costs nothing, while a missed real class would let the defect above through. Each token is offered
// both as delimited and with surrounding punctuation trimmed, since Tailwind's own scanner sees the trimmed form.
// Asserted equivalent to that scanner's answer on this tree, not a reimplementation of it.
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

// Tokens that compile to a utility but are not one anybody wrote: `flex-shrink` is a real Tailwind class and a real CSS
// property used in a `<style>` block; `antialiased` is a real utility and an ordinary English word used in prose;
// `top-11` appears in prose arguing against ever writing it literally. Named here rather than worked around, since
// editing the prose would only move the coincidence to the next person who writes the word.
const NOT_CLASSES = new Set([`flex-shrink`, `antialiased`, `top-11`]);

const classesOf = (css: string): Set<string> =>
    new Set([...css.matchAll(/\.(-?(?:[A-Za-z_]|\\.)(?:[\w-]|\\.)*)/gu)].map((match) => (match[1] ?? ``).replaceAll(/\\(.)/gu, `$1`)));

// A fresh compiler per build: `build()` accumulates the candidates it has been given, so two calls on one instance
// would measure the union rather than each set.
const surfaceBuild = async (): Promise<(candidates: string[]) => string> => (await compile(SURFACE, { base: ROOT, loadStylesheet })).build;

test("every class the first-party extensions use is one the surface promises", async () => {
    const screens = readdirSync(join(ROOT, `_extensions`), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => join(ROOT, `_extensions`, entry.name, `src`))
        .filter((dir) => statSync(dir, { throwIfNoEntry: false })?.isDirectory() === true);

    const promised = classesOf((await surfaceBuild())([]));
    const reached = classesOf((await surfaceBuild())(candidatesIn(screens.flatMap(sourceFiles))));
    const offSurface = [...reached].filter((name) => !promised.has(name) && !NOT_CLASSES.has(name)).toSorted();

    // Read the failure like this: each name is a class that works only while its extension is built here. Put it on the
    // scale, give it a name in tokens.css, or move the rule into the extension's own stylesheet.
    expect(offSurface).toEqual([]);
}, 60_000);

// The bill for the promise, asserted rather than admired: declaring a family whole emits utilities nobody is using yet.
// The ceiling is generous enough that ordinary additions do not trip it and tight enough that a multiplied family
// cannot land unnoticed. Raise it on purpose, with the new figure in the commit.
test("the promise stays within its size budget", async () => {
    const css = (await surfaceBuild())([]);
    expect({ bytes: css.length > 900_000, classes: classesOf(css).size > 8_000 }).toEqual({ bytes: false, classes: false });
}, 60_000);
