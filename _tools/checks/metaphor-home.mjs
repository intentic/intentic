#!/usr/bin/env node
// `docs/marketing/landing-blueprint.md` records both halves of one rule: the four product nouns (machine, sandbox,
// persona, project) are explained in ONE picture, that picture is reached from the docs, and the home page never
// carries it — a page that has to land one claim on a stranger cannot also teach four definitions. The rule survived
// as prose for exactly as long as nobody edited it, so it is read here instead.
//
// Nothing is named by path. The scene is found by its SHAPE (the one module that lists all four nouns as part ids),
// and the two pages are found by Astro's routing (`src/pages/index.astro` is a site's home, `src/pages/docs/*.astro`
// its docs), so renaming the module, the figure or the page keeps the guard pointed at them.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { finish } from "./lib/report.mjs";
import { byName, root, trackedFiles, untrackedFiles } from "./lib/repo.mjs";

/** The nouns the picture exists to define. A scene naming all four is the picture, wherever it lives. */
const PART_IDS = ["machine", "sandbox", "persona", "project"];
const ASTRO = /\.astro$/;
const SOURCE = /\.(astro|[cm]?ts|[cm]?js)$/;
const IMPORT = /(?:^|\n)\s*import\s[^;'"]*?from\s*["']([^"']+)["']/g;
const HOME = /(^|\/)src\/pages\/index\.astro$/;
const DOCS_PAGE = /(^|\/)src\/pages\/docs\/[^/]+\.astro$/;

/* Untracked too: the turn that moves this picture writes the new page before anything stages it. */
const tracked = [...trackedFiles(), ...untrackedFiles()];
const read = (path) => readFileSync(join(root, path), "utf8");
const show = (path) => relative(root, path).replaceAll("\\", "/");

/** One `exports` entry against one subpath: an exact key, or a `*` pattern with what it matched substituted in. */
const expandExport = (pattern, target, subpath) => {
    if (pattern === subpath) {
        return target;
    }
    const star = pattern.indexOf("*");
    if (star === -1) {
        return undefined;
    }
    const head = pattern.slice(0, star);
    const tail = pattern.slice(star + 1);
    if (!subpath.startsWith(head) || !subpath.endsWith(tail)) {
        return undefined;
    }
    return target.replace("*", subpath.slice(head.length, subpath.length - tail.length));
};

/** Resolves a workspace specifier through the owner's own `exports`, so a package that moves its src still resolves. */
const throughExports = (specifier) => {
    const depth = specifier.startsWith("@") ? 2 : 1;
    const segments = specifier.split("/");
    const owner = byName.get(segments.slice(0, depth).join("/"));
    if (owner === undefined) {
        return undefined;
    }
    const subpath = segments.length > depth ? `./${segments.slice(depth).join("/")}` : ".";
    for (const [pattern, target] of Object.entries(owner.pkg.exports ?? {})) {
        const hit = typeof target === "string" ? expandExport(pattern, target, subpath) : undefined;
        if (hit !== undefined) {
            return join(owner.dir, hit);
        }
    }
    return undefined;
};

/* The repo writes ESM, so a relative specifier carries the COMPILED extension; .astro carries its own. */
const resolveFrom = (file, specifier) => {
    if (!specifier.startsWith(".")) {
        return throughExports(specifier);
    }
    const path = join(dirname(file), specifier);
    return [path, path.replace(/\.[cm]?js$/, ".ts"), `${path}.ts`].find((candidate) => SOURCE.test(candidate) && existsSync(candidate));
};

/* Every module reachable from an .astro file, and the edges between them: one forward crawl from the templates. */
const edges = new Map();
const queue = tracked.filter((path) => ASTRO.test(path)).map((path) => join(root, path));
const seen = new Set(queue);
while (queue.length > 0) {
    const file = queue.shift();
    const targets = [...read(show(file)).matchAll(IMPORT)]
        .map(([, specifier]) => resolveFrom(file, specifier))
        .filter((target) => target !== undefined && existsSync(target));
    edges.set(file, targets);
    for (const target of targets) {
        if (!seen.has(target)) {
            seen.add(target);
            queue.push(target);
        }
    }
}

/** The picture itself: a module that lists all four nouns as the parts of one scene. */
const scenes = tracked.filter((path) => {
    if (ASTRO.test(path) || !/\.[cm]?ts$/.test(path)) {
        return false;
    }
    const text = read(path);
    return /\bparts:\s*\[/.test(text) && PART_IDS.every((id) => text.includes(`id: "${id}"`));
});

/* Who reaches the scene, walking the same edges backwards. */
const reaching = new Set();
if (scenes.length === 1) {
    const wanted = [join(root, scenes[0])];
    while (wanted.length > 0) {
        const target = wanted.pop();
        for (const [file, targets] of edges) {
            if (targets.includes(target) && !reaching.has(file)) {
                reaching.add(file);
                wanted.push(file);
            }
        }
    }
}

const reachingPages = [...reaching].map(show);
const missing = scenes.length === 1 && !reachingPages.some((path) => DOCS_PAGE.test(path)) ? [show(scenes[0])] : [];
const promoted = reachingPages.filter((path) => HOME.test(path));

finish(
    [
        [
            "the four nouns (machine, sandbox, persona, project) are defined nowhere: the docs spend two of them\n" +
                "  (persona, project) with no other page defining either (docs/marketing/landing-blueprint.md)",
            scenes.length === 0 ? ["no module lists all four as the parts of one scene"] : [],
        ],
        [
            "the four nouns are defined twice, so two pictures can disagree about what a persona is\n" +
                "  (docs/marketing/landing-blueprint.md: one picture, on one page)",
            scenes.length > 1 ? scenes : [],
        ],
        [
            "defined, but on no docs page: the picture has to be READ, and every later docs page spends its words\n" +
                "  (docs/marketing/landing-blueprint.md: do not delete it from the docs)",
            missing.map((path) => `${path} is reached by no src/pages/docs/*.astro`),
        ],
        [
            "the home page carries the four-noun picture. That page lands ONE claim on a stranger; four definitions\n" +
                "  and a second reading of the site's own metaphor cost it (docs/marketing/landing-blueprint.md:\n" +
                "  do not promote it onto this page). If a picture of those four nouns is wanted there, redraw the temple",
            promoted.map((path) => `${path} reaches ${show(scenes[0] ?? "")}`),
        ],
    ],
    scenes.length === 1
        ? [`${show(scenes[0])} defines the four nouns once, ${reachingPages.filter((path) => DOCS_PAGE.test(path)).length} docs page(s) reach it, the home page does not`]
        : [],
);
