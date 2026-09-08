#!/usr/bin/env node
// Moves files with `git mv` and rewrites every specifier the move invalidates: in the moved file, in every importer
// (`vi.mock`, dynamic `import()`), and in a package's `exports` targets, keeping each file's import style. Config path
// literals (tsconfig, vite, Dockerfile, baseline keys) are a separate sweep; refuses a file with unstaged changes
// unless `--force`.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { repoRoot } from "../../constants/src/node.mjs";

const TS_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".vue"];
// TypeScript extension to what an importer sees after compilation.
const EMITTED = { ".ts": ".js", ".tsx": ".js", ".mts": ".mjs", ".cts": ".cjs" };
const CODE = /\.(ts|tsx|mts|cts|js|mjs|cjs|vue|astro)$/;

// Matches real import syntax only, skipping a computed `${...}` specifier and matching typeof-import args too.
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

// Resolves a relative specifier to the tracked file it names; undoes the emitted extension and a bare specifier may
// resolve to a directory's index.
export const resolveRelative = (fromFile, specifier, tracked) => {
    const base = posix(join(dirname(fromFile), specifier));
    const emitted = /\.([cm]?)js$/.exec(base);
    const candidates = emitted
        ? [base.replace(/\.([cm]?)js$/, ".$1ts"), base.replace(/\.[cm]?js$/, ".tsx"), base]
        : [base, ...TS_EXTENSIONS.map((extension) => `${base}${extension}`), ...TS_EXTENSIONS.map((extension) => `${base}/index${extension}`)];
    return candidates.find((candidate) => tracked.has(candidate));
};

// Rewrites the target using the style the original specifier used: emitted extension, no extension, or a directory
// index.
export const specifierFor = (fromFile, target, original) => {
    const directoryImport = /\/index\.[^./]+$/.test(target) && !/(^|\/)index(\.[^./]+)?$/.test(original);
    const wanted = directoryImport ? dirname(target) : target;
    const rel = posix(relative(dirname(fromFile), wanted));
    // Original's ending decides the spelling: a dotted name like `environment.default` isn't seen as an extension.
    const styled = directoryImport || original.endsWith(extensionOf(target))
        ? rel
        : /\.[cm]?js$/.test(original)
          ? `${withoutExtension(rel)}${EMITTED[extensionOf(target)] ?? extensionOf(target)}`
          : withoutExtension(rel);
    return styled.startsWith(".") ? styled : `./${styled}`;
};

// One file's specifiers, re-aimed at where their targets ended up; returns the new text and the changes made.
export const rewriteSpecifiers = (text, fromFile, finalOf, tracked) => {
    const changes = [];
    const rewritten = text.replaceAll(SPECIFIER, (match, quote, specifier) => {
        if (!specifier.startsWith(".")) {
            return match;
        }
        const target = resolveRelative(fromFile, specifier, tracked);
        // Nothing moved at either end; leave unchanged rather than normalise an already-roundabout specifier.
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

// Rewrites a subpath export's target while keeping its key; a `dist` path is the built form of the source and moves
// with it.
export const rewriteManifest = (text, packageDir, finalOf, tracked) => {
    const changes = [];
    // Moving the whole package is a no-op here; only a move inside the package rewrites a target.
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

// Computed against the tree as it stands, applied afterwards; mid-move it would resolve half the specifiers against the
// old tree, half the new.
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
