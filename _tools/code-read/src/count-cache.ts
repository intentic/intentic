import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { highlightLangFor } from "./lang-for-path.js";
import { type CodeCount, codeLineStat, type LineStat } from "./stat.js";
import type { Grammars } from "./tokens.js";

// A count is a pure function of the two texts, the grammar a path resolves to, and the code that reads them. Kept by a
// caller's store (the daemon's is SQLite, so a restart or a second checkout of the same content reads it), keyed so a
// count an older reading made is never served. Node only: the app counts in the page and keeps nothing.

/** Where counts are kept: a pair of sides too far apart to diff is kept as nulls, which is as final as a number. */
export interface CountStore {
    readonly get: (key: string) => { readonly additions: number | null; readonly deletions: number | null } | undefined;
    readonly put: (key: string, additions: number | null, deletions: number | null) => void;
}

const here = import.meta.dirname;

// The files this module was loaded from, every level down: dist/**/*.js when built, src/**/*.ts under the source
// condition. Suites and declarations are not code that reads.
const readingFiles = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true })
        .toSorted((left, right) => left.name.localeCompare(right.name))
        .flatMap((entry) => {
            const path = join(dir, entry.name);
            if (entry.isDirectory()) {
                return readingFiles(path);
            }
            return /\.(js|ts)$/.test(entry.name) && !/\.(d|test)\.ts$/.test(entry.name) ? [path] : [];
        });

// The manifest of the `name` a package at `dir` would load, found the way Node looks: its own node_modules, then each one
// above. Walked by hand because Bun, which runs the suites, has no `module.findPackageJSON`.
const installedManifest = (dir: string, name: string): string | undefined => {
    for (let at = dir; ; at = dirname(at)) {
        const candidate = join(at, "node_modules", name, "package.json");
        if (existsSync(candidate)) {
            return candidate;
        }
        if (dirname(at) === at) {
            return undefined;
        }
    }
};

/** The reading digest of the code-read build at `dir`, with the dependencies its manifest at `manifestPath` names. */
export const readingIdOf = (dir: string, manifestPath: string): string => {
    const hash = createHash("sha256");
    for (const file of readingFiles(dir)) {
        hash.update(relative(dir, file)).update("\0").update(readFileSync(file)).update("\0");
    }
    // SAFETY: code-read's own package.json, whose `dependencies` is optional here and read only for its keys.
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { readonly dependencies?: Readonly<Record<string, string>> };
    for (const name of Object.keys(manifest.dependencies ?? {}).toSorted()) {
        // Read off disk rather than required, so the version is the installed one and not a module cache's.
        const found = installedManifest(dirname(manifestPath), name);
        // SAFETY: an installed package's manifest; a missing `version` hashes as empty, which still moves when one appears.
        const { version } = JSON.parse(readFileSync(found ?? manifestPath, "utf8")) as { readonly version?: string };
        hash.update(`${name}@${found === undefined ? "missing" : (version ?? "")}\0`);
    }
    return hash.digest("hex");
};

let reading: string | undefined;

/**
 * What a count depends on besides its two texts, as one digest: the content of the code-read build this process runs
 * (every file, any depth) and the installed version of each of its dependencies (shiki and its grammars). Hashed at
 * load rather than written by `pnpm build`, since `tsgo -b` (the declarations emit every check runs first) rebuilds
 * dist without that script, and an id file left beside newer output would key it as the old build.
 */
export const readingId = (): string => (reading ??= readingIdOf(here, join(here, "..", "package.json")));

const keyOf = (lang: string, before: string, after: string): string =>
    createHash("sha256").update(`${readingId()}\0${lang}\0${String(before.length)}\0`).update(before).update(after).digest("hex");

/**
 * `codeLineStat` behind `store`: a pair counted before is answered from it without loading a grammar. A path with no
 * grammar, and a walk that was abandoned or threw, are answered undefined and never kept: neither is a property of the
 * file. Without a store it is `codeLineStat` alone.
 */
export const keptLineStat = async (store: CountStore | undefined, before: string, after: string, path: string, grammars: Grammars): Promise<LineStat | undefined> => {
    // Resolved as codeLineStat resolves it, so a path it would not count is never keyed.
    const lang = highlightLangFor(path, Math.max(before.length, after.length), after === "" ? before : after);
    const key = store === undefined || lang === undefined ? undefined : keyOf(lang, before, after);
    const kept = key === undefined ? undefined : store?.get(key);
    if (kept !== undefined) {
        return kept.additions === null || kept.deletions === null ? undefined : { additions: kept.additions, deletions: kept.deletions };
    }
    // allow(silent-catch): a walk that threw is counted by git instead, as one with no grammar is, and is not kept
    const count: CodeCount | undefined = await codeLineStat(before, after, path, grammars).catch(() => undefined);
    if (count === undefined) {
        return undefined;
    }
    const stat = "stat" in count ? count.stat : undefined;
    if (key !== undefined) {
        store?.put(key, stat?.additions ?? null, stat?.deletions ?? null);
    }
    return stat;
};
