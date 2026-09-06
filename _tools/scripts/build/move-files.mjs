#!/usr/bin/env node
/* MOVE FILES AND TAKE THEIR IMPORTS WITH THEM. The one tool a directory-structure change is made of.
 *
 *   node _tools/scripts/build/move-files.mjs moves.json [--dry-run] [--force]
 *
 * `moves.json` is `[{ "from": "...", "to": "..." }]`, repo-relative, files or directories. A directory expands
 * to every tracked file under it. For each move it runs `git mv` (history, not delete-and-create) and then
 * rewrites every module specifier the move invalidated:
 *
 *   - in the moved file, whose own relative imports now sit at a different depth;
 *   - in every importer of it, anywhere in the repository, including `vi.mock` and dynamic `import()`;
 *   - in the package.json `exports` of the package that owns it, so a SUBPATH EXPORT keeps its specifier and
 *     only its target moves. That distinction is the whole reason this resolves through the manifests: a
 *     consumer writing `@intentic/sandbox-contract/tunnel-ids` must not have to know the file moved.
 *
 * IT KEEPS THE STYLE EACH FILE ALREADY USES, because the repository does not have one: the daemon and the
 * libraries write ESM with the emitted extension (`./turn-plan.js` for `turn-plan.ts`), the Vue app writes
 * extensionless relatives, and a directory import (`./chores`) stays a directory import. A codemod that
 * normalised those would put a diff on every line it touched and lose the argument in review.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It does not touch a config's path literal — tsconfig `references`, vite
 * aliases, a Dockerfile COPY, a check's baseline key. Those are a `rg` sweep per phase, listed in the plan,
 * because each one is a decision (a baseline key is RENAMED, never added) and a codemod that guessed would be
 * the thing nobody reviews. Print, sweep, then run the checks.
 *
 * THE SAFETY IS ABOUT CONTENT, NOT CLEANLINESS. It refuses to move a file that has unstaged modifications
 * (--force overrides), and says nothing about the rest of the tree: in this repository an agent's whole delta
 * is uncommitted by design, so "refuse on a dirty tree" would mean "never runs". */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { repoRoot } from "../../constants/src/node.mjs";

const TS_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".vue"];
// What a TypeScript file is called by the code that imports it, once the compiler has had its say.
const EMITTED = { ".ts": ".js", ".tsx": ".js", ".mts": ".mjs", ".cts": ".cjs" };
const CODE = /\.(ts|tsx|mts|cts|js|mjs|cjs|vue|astro)$/;

/* Every place a module specifier can appear, and nowhere else. A quoted string that merely LOOKS like a path
 * (a fixture, a route, a log line) is not rewritten, which is why this is an import-context match rather than
 * a scan for strings beginning with a dot.
 *
 * BACKTICKS COUNT. This repository writes most of its strings in them, `await import(`./x.js`)` inside a test
 * included, and a codemod that only knew about quotes left exactly those behind — where they fail at LOAD
 * rather than at compile, in a suite that names the importer. A backtick string carrying `${` is a computed
 * specifier and is left alone.
 *
 * SO DOES A TYPE ARGUMENT. `vi.importActual<typeof import("./x")>("./x")` names the module TWICE and the two
 * are different syntax: the first is an `import(` the pattern already saw, the second sits behind a `<…>` the
 * call name no longer touches. Rewriting one and not the other is the worst of both — the file type-checks
 * against the new path and loads the old one. */
const SPECIFIER =
    /(?<=\bfrom\s*|\bimport\s*\(\s*|\brequire\(\s*|\bimport\s+|\b(?:vi\.)?(?:mock|doMock|unmock|importActual|importOriginal|importMock)\s*(?:<[^>\n]*>)?\s*\(\s*)(["'`])([^"'`\n$]+)\1/g;

const posix = (path) => path.split("\\").join("/");
const withoutExtension = (path) => path.replace(/\.[^./]+$/, "");
const extensionOf = (path) => /\.[^./]+$/.exec(path)?.[0] ?? "";

// A directory move is stated once and means every tracked file under it.
export const expandMoves = (map, tracked) =>
    map.flatMap(({ from, to }) => {
        if (tracked.has(from)) {
            return [{ from, to }];
        }
        const under = [...tracked].filter((path) => path.startsWith(`${from}/`));
        return under.map((path) => ({ from: path, to: `${to}/${path.slice(from.length + 1)}` }));
    });

/* Where a relative specifier lands in the checkout. The repo writes the EMITTED extension (`./x.js` for
 * `x.ts`), so the resolution has to undo that, and a bare specifier may name a directory with an index. */
export const resolveRelative = (fromFile, specifier, tracked) => {
    const base = posix(join(dirname(fromFile), specifier));
    const emitted = /\.([cm]?)js$/.exec(base);
    const candidates = emitted
        ? [base.replace(/\.([cm]?)js$/, ".$1ts"), base.replace(/\.[cm]?js$/, ".tsx"), base]
        : [base, ...TS_EXTENSIONS.map((extension) => `${base}${extension}`), ...TS_EXTENSIONS.map((extension) => `${base}/index${extension}`)];
    return candidates.find((candidate) => tracked.has(candidate));
};

/* The same target, written the way this file writes its imports. Three styles, decided by what the ORIGINAL
 * specifier did: the emitted extension, no extension at all, or a directory that resolves through its index. */
export const specifierFor = (fromFile, target, original) => {
    const directoryImport = /\/index\.[^./]+$/.test(target) && !/(^|\/)index(\.[^./]+)?$/.test(original);
    const wanted = directoryImport ? dirname(target) : target;
    const rel = posix(relative(dirname(fromFile), wanted));
    /* Which of the three spellings this file uses, decided by what the ORIGINAL said rather than by any
     * house rule: the file's real extension (`.vue`, and the `.mjs` of plumbing that runs unbuilt), the
     * extension TypeScript emits (`./turn-plan.js` for turn-plan.ts), or none at all. Asking whether the
     * original ends with the target's own extension is what keeps a dotted filename — `environment.default`
     * — from being read as an extension nobody wrote. */
    const styled = directoryImport || original.endsWith(extensionOf(target))
        ? rel
        : /\.[cm]?js$/.test(original)
          ? `${withoutExtension(rel)}${EMITTED[extensionOf(target)] ?? extensionOf(target)}`
          : withoutExtension(rel);
    return styled.startsWith(".") ? styled : `./${styled}`;
};

// One file's specifiers, re-aimed at where their targets ended up. Returns the new text and what changed.
export const rewriteSpecifiers = (text, fromFile, finalOf, tracked) => {
    const changes = [];
    const rewritten = text.replaceAll(SPECIFIER, (match, quote, specifier) => {
        if (!specifier.startsWith(".")) {
            return match;
        }
        const target = resolveRelative(fromFile, specifier, tracked);
        /* Nothing moved at either end: leave it exactly as written. Recomputing every specifier would also
         * NORMALISE the ones that are merely roundabout (`../secrets/x.js` from inside `secrets/`), which is
         * a diff on a line the move had no business touching. */
        if (target === undefined || (finalOf(fromFile) === fromFile && finalOf(target) === target)) {
            return match;
        }
        const replacement = specifierFor(finalOf(fromFile), finalOf(target), specifier);
        if (replacement === specifier) {
            return match;
        }
        changes.push({ from: specifier, to: replacement });
        return `${quote}${replacement}${quote}`;
    });
    return { text: rewritten, changes };
};

/* A package's own manifest is where a subpath export's TARGET moves while its KEY stays put. `dist` paths are
 * the same source file seen after the build, so they move with it. */
export const rewriteManifest = (text, packageDir, finalOf, tracked) => {
    const changes = [];
    // Where the package itself ends up, so that moving a whole package (which takes its exports with it) is
    // correctly a no-op here, and only a move INSIDE the package rewrites a target.
    const movedPackageDir = dirname(finalOf(`${packageDir}/package.json`));
    const rewritten = text.replaceAll(/"(\.\/(?:src|dist)\/[^"]+)"/g, (match, value) => {
        const asSource = value.startsWith("./dist/")
            ? `src/${value.slice("./dist/".length).replace(/\.d\.ts$/, ".ts").replace(/\.([cm]?)js$/, ".$1ts")}`
            : value.slice(2);
        const candidates = [`${packageDir}/${asSource}`, `${packageDir}/${asSource.replace(/\.ts$/, ".tsx")}`, `${packageDir}/${asSource.replace(/\.ts$/, ".vue")}`];
        const source = candidates.find((candidate) => tracked.has(candidate));
        if (source === undefined) {
            return match;
        }
        const moved = finalOf(source);
        if (moved === source) {
            return match;
        }
        const insidePackage = moved.startsWith(`${movedPackageDir}/`) ? moved.slice(movedPackageDir.length + 1) : moved;
        const replacement = value.startsWith("./dist/")
            ? `./dist/${insidePackage.slice("src/".length).replace(/\.tsx?$/, value.endsWith(".d.ts") ? ".d.ts" : ".js")}`
            : `./${insidePackage}`;
        if (replacement === value) {
            return match;
        }
        changes.push({ from: value, to: replacement });
        return `"${replacement}"`;
    });
    return { text: rewritten, changes };
};

/* Everything is computed against the tree as it stands and applied afterwards: a rewrite that ran in the
 * middle of a directory move would resolve half its specifiers against the old tree and half against the new. */
export const planEdits = (root, tracked, finalOf) => {
    const edits = [];
    for (const path of tracked) {
        const manifest = path.endsWith("/package.json");
        if (!CODE.test(path) && !manifest) {
            continue;
        }
        const text = readFileSync(join(root, path), "utf8");
        const result = manifest ? rewriteManifest(text, dirname(path), finalOf, tracked) : rewriteSpecifiers(text, path, finalOf, tracked);
        if (result.changes.length > 0) {
            edits.push({ path, text: result.text, changes: result.changes });
        }
    }
    return edits;
};

const refuse = (message) => {
    console.error(`move-files: ${message}`);
    process.exit(1);
};

const main = () => {
    const root = repoRoot(import.meta.url);
    const args = process.argv.slice(2);
    const mapPath = args.find((arg) => !arg.startsWith("--"));
    if (mapPath === undefined) {
        console.error("usage: node _tools/scripts/build/move-files.mjs moves.json [--dry-run] [--force]");
        process.exit(2);
    }

    const git = (...argv) => execFileSync("git", argv, { cwd: root, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
    const tracked = new Set(git("ls-files", "-z").split("\0").filter((path) => path !== ""));
    const moves = expandMoves(JSON.parse(readFileSync(mapPath, "utf8")), tracked);
    const missing = moves.filter(({ from }) => !tracked.has(from)).map(({ from }) => from);
    if (missing.length > 0) {
        refuse(`not tracked: ${missing.join(", ")}`);
    }
    const modified = new Set(git("diff", "--name-only").split("\n").filter(Boolean));
    const dirty = moves.filter(({ from }) => modified.has(from)).map(({ from }) => from);
    if (dirty.length > 0 && !args.includes("--force")) {
        refuse(`these have unstaged changes and would move with them (--force to accept): ${dirty.join(", ")}`);
    }

    const destination = new Map(moves.map(({ from, to }) => [from, to]));
    const finalOf = (path) => destination.get(path) ?? path;
    const edits = planEdits(root, tracked, finalOf);

    for (const { path, changes } of edits) {
        for (const { from, to } of changes) {
            console.log(`${finalOf(path)}: ${from} → ${to}`);
        }
    }
    console.log(`move-files: ${moves.length} file(s), ${edits.length} file(s) rewritten, ${edits.reduce((sum, edit) => sum + edit.changes.length, 0)} specifier(s)`);
    if (args.includes("--dry-run")) {
        return;
    }

    for (const { from, to } of moves) {
        mkdirSync(join(root, dirname(to)), { recursive: true });
        git("mv", from, to);
    }
    for (const { path, text } of edits) {
        writeFileSync(join(root, finalOf(path)), text);
    }
};

if (process.argv[1] !== undefined && resolve(process.argv[1]) === import.meta.filename) {
    main();
}
