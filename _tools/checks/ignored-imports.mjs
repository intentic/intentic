#!/usr/bin/env node
// Reports relative imports from tracked files that resolve only to ignored paths, naming the ignore rule.
// Such imports work locally but fail in clean checkouts; unresolved paths are left to typechecks and tests.
// Uses the active git index: the turn check's GIT_INDEX_FILE includes unignored new files as intent-to-add.
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { GitRefused, ignoredImports, SOURCE, trackedIn } from "./lib/ignored-imports.mjs";
import { cannotMeasure, finish } from "./lib/report.mjs";
import { root, subjectScope } from "./lib/repo.mjs";

// Ignored on purpose and written before anything imports them, each with what writes it. A path ending in `/` is the
// whole directory a generator owns. Name a file here only with the script that writes it before its first import.
const GENERATED = new Map([
    ["_platform/prisma/generated/", "`prisma generate`, which @intentic/prisma's build and generate scripts run before tsc compiles client.ts"],
]);

// A `dist/` directory is what a build writes and holds no source, so an import reaching into one runs after the build
// that fills it: the package's own post-build scripts (write-schema.mjs, write-lock.mjs) and the extension seed's test
// of its built bundle. The break this check guards is a SOURCE file a pattern swallowed, which cannot live in one.
const BUILD_OUTPUT = /(?:^|\/)dist\//;

const generatedBy = (target) => [...GENERATED.keys()].find((entry) => (entry.endsWith("/") ? target.startsWith(entry) : target === entry));

const scope = subjectScope();
let subjects = [];
let found = [];
try {
    const listed = trackedIn(root);
    subjects = listed.filter((path) => SOURCE.test(path) && (scope === undefined || scope.has(path)) && existsSync(join(root, path)));
    found = ignoredImports({
        root,
        subjects,
        tracked: new Set(listed),
        read: (path) => readFileSync(join(root, path), "utf8"),
        exists: (path) => statSync(join(root, path), { throwIfNoEntry: false })?.isFile() === true,
    });
} catch (error) {
    if (!(error instanceof GitRefused)) {
        throw error;
    }
    cannotMeasure(`ignored-imports: ${error.message}`);
}

const excused = found.filter(({ target }) => BUILD_OUTPUT.test(target) || generatedBy(target) !== undefined);
// A scoped run read a few files, so an entry it saw nothing reach is not evidence the entry is spent.
if (scope === undefined) {
    const reached = new Set(excused.map(({ target }) => generatedBy(target)));
    for (const entry of GENERATED.keys()) {
        if (!reached.has(entry)) {
            console.log(`ignored-imports: GENERATED names ${entry}, which no import reaches any more: drop it when you next edit _tools/checks/ignored-imports.mjs`);
        }
    }
}

finish(
    [
        [
            "a tracked file imports a path git ignores, so the import lands without its file and every clean checkout fails to load it: rename the file, or add a `!` exception to the rule; a file a build writes before its first import goes in GENERATED (_tools/checks/ignored-imports.mjs) with the script that writes it",
            found
                .filter((finding) => !excused.includes(finding))
                .map(({ file, line, target, rule }) => `${file}:${line} imports ${target}, which .gitignore ignores (${rule}), so it never lands: rename it or add a \`!\` exception`),
        ],
    ],
    [`${subjects.length} source files read: no relative import reaches a path git ignores (${excused.length} reach build output or a named generated file)`],
);
