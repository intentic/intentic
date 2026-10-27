import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { writeFileAtomicSync } from "@intentic/base/fs";

// Which files of a package import which: every static and dynamic import of every file its typecheck compiles, `.vue`
// script blocks included, resolved the way the package's own compiler resolves them (relative paths and the tsconfig's
// `paths`). What a file imports is cached by its mtime and size, so a second ask reads only what changed since.

export interface ImportGraph {
    // What each project file imports, resolved; a target outside the package (a sibling library through an alias) is
    // kept, so a change there finds its importers here too. Bare package imports resolve to nothing and are dropped.
    readonly imports: ReadonlyMap<string, ReadonlySet<string>>;
    // The files importing each file: the project's, and the outside files the project reaches.
    readonly importers: ReadonlyMap<string, ReadonlySet<string>>;
}

export interface GraphSource {
    readonly files: readonly string[];
    readonly paths: Readonly<Record<string, readonly string[]>>;
    readonly pathsBase: string;
    // The import specifiers a file's text holds (ts.preProcessFile on it, or on each script block of a `.vue` file).
    readonly specifiersOf: (text: string) => readonly string[];
    // Where the cache lives; none keeps nothing.
    readonly cacheFile?: string | undefined;
}

// The scripts of a single-file component, where its imports are: `<script>` and `<script setup>` alike.
const SCRIPT_BLOCK = /<script\b[^>]*>([\s\S]*?)<\/script>/giu;
const scriptBlocksOf = (text: string): string[] => [...text.matchAll(SCRIPT_BLOCK)].map((match) => match[1] ?? "");

// What a specifier may resolve to, in the order a bundler resolver tries them.
const EXTENSIONS = [".ts", ".tsx", ".d.ts", ".mts", ".cts", ".vue", ".js", ".mjs", ".jsx"];
const JS_TO_TS = { ".js": [".ts", ".tsx"], ".mjs": [".mts"], ".cjs": [".cts"], ".jsx": [".tsx"] } as const;

const candidatesOf = (base: string): string[] => {
    const out = [base];
    for (const [js, tsExtensions] of Object.entries(JS_TO_TS)) {
        if (base.endsWith(js)) {
            out.push(...tsExtensions.map((ext) => base.slice(0, -js.length) + ext));
        }
    }
    out.push(...EXTENSIONS.map((ext) => base + ext), ...EXTENSIONS.map((ext) => join(base, `index${ext}`)));
    return out;
};

// The bases a specifier names through `paths`: the longest matching pattern's targets, `*` substituted.
const aliasBases = (specifier: string, paths: Readonly<Record<string, readonly string[]>>, pathsBase: string): string[] => {
    let best: { prefixLength: number; targets: readonly string[]; star: string } | undefined;
    for (const [pattern, targets] of Object.entries(paths)) {
        const star = pattern.indexOf("*");
        if (star === -1) {
            if (pattern === specifier && (best === undefined || pattern.length > best.prefixLength)) {
                best = { prefixLength: pattern.length, targets, star: "" };
            }
            continue;
        }
        const prefix = pattern.slice(0, star);
        const suffix = pattern.slice(star + 1);
        if (specifier.startsWith(prefix) && specifier.endsWith(suffix) && specifier.length >= prefix.length + suffix.length && (best === undefined || prefix.length > best.prefixLength)) {
            best = { prefixLength: prefix.length, targets, star: specifier.slice(prefix.length, specifier.length - suffix.length) };
        }
    }
    return best === undefined ? [] : best.targets.map((target) => resolve(pathsBase, target.replace("*", best.star)));
};

interface CachedFile {
    readonly mtimeMs: number;
    readonly size: number;
    readonly specifiers: readonly string[];
}
interface GraphCache {
    readonly version: 1;
    readonly files: Record<string, CachedFile>;
}

const readCache = (path: string | undefined): GraphCache["files"] => {
    if (path === undefined) {
        return {};
    }
    try {
        // SAFETY: written by writeCache below; a cache of another version or shape is ignored whole.
        const cache = JSON.parse(readFileSync(path, "utf8")) as GraphCache;
        return cache.version === 1 ? (cache.files ?? {}) : {};
    } catch {
        // allow(silent-catch): no cache yet, or one cut short, is a cold build: every file is read again
        return {};
    }
};

// Written whole and renamed into place, so a check reading it while another writes never sees half of it.
const writeCache = (path: string, files: GraphCache["files"]): void => {
    try {
        mkdirSync(dirname(path), { recursive: true });
        writeFileAtomicSync(path, JSON.stringify({ version: 1, files } satisfies GraphCache));
    } catch {
        // allow(silent-catch): a cache that cannot be written costs the next ask a full read, nothing more
    }
};

// Source files outside the project worth following, and how many: enough for the editor's libraries, bounded so an
// alias into a large tree cannot make one ask read all of it.
const FOLLOWED = /\.([cm]?tsx?|vue)$/u;
const MAX_OUTSIDE = 10_000;

const statOf = (file: string): { mtimeMs: number; size: number } | undefined => {
    try {
        const stat = statSync(file);
        return { mtimeMs: stat.mtimeMs, size: stat.size };
    } catch {
        // allow(silent-catch): a file removed since the tsconfig was read is not part of the graph
        return undefined;
    }
};

/** The package's import graph, reading only the files whose mtime or size moved since the cache was written. */
export const buildImportGraph = (source: GraphSource): ImportGraph => {
    const cached = readCache(source.cacheFile);
    const fresh: GraphCache["files"] = {};
    const inProject = new Set(source.files);
    const outside = new Map<string, boolean>();
    const exists = (path: string): boolean => {
        if (inProject.has(path)) {
            return true;
        }
        let known = outside.get(path);
        if (known === undefined) {
            known = existsSync(path) && statSync(path).isFile();
            outside.set(path, known);
        }
        return known;
    };
    const resolveSpecifier = (specifier: string, from: string): string | undefined => {
        const bases = specifier.startsWith(".") || specifier.startsWith("/") ? [resolve(dirname(from), specifier)] : aliasBases(specifier, source.paths, source.pathsBase);
        for (const base of bases) {
            const found = candidatesOf(base).find(exists);
            if (found !== undefined) {
                return found;
            }
        }
        return undefined;
    };
    const imports = new Map<string, Set<string>>();
    const importers = new Map<string, Set<string>>();
    let changed = false;
    const specifiersAt = (file: string, stat: { mtimeMs: number; size: number }): readonly string[] => {
        const hit = cached[file];
        if (hit !== undefined && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) {
            return hit.specifiers;
        }
        changed = true;
        const text = readFileSync(file, "utf8");
        return [...new Set((file.endsWith(".vue") ? scriptBlocksOf(text) : [text]).flatMap((block) => source.specifiersOf(block)))];
    };
    // The project's files first, then what they reach outside it (a sibling library's source through an alias), so a
    // change there is traced through that library's own files (a barrel re-exporting it) to the project files above.
    const queue = [...source.files];
    const queued = new Set(queue);
    for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
        const stat = statOf(file);
        if (stat === undefined) {
            continue;
        }
        const specifiers = specifiersAt(file, stat);
        fresh[file] = { ...stat, specifiers };
        const targets = new Set<string>();
        for (const specifier of specifiers) {
            const target = resolveSpecifier(specifier, file);
            if (target === undefined || target === file) {
                continue;
            }
            targets.add(target);
            const into = importers.get(target) ?? new Set<string>();
            into.add(file);
            importers.set(target, into);
            if (!queued.has(target) && FOLLOWED.test(target) && !target.includes("/node_modules/") && queued.size < source.files.length + MAX_OUTSIDE) {
                queued.add(target);
                queue.push(target);
            }
        }
        imports.set(file, targets);
    }
    if (source.cacheFile !== undefined && (changed || Object.keys(cached).length !== Object.keys(fresh).length)) {
        writeCache(source.cacheFile, fresh);
    }
    return { imports, importers };
};

/** How many project files import `file` at any depth, counting up to `stopAt` (past it the exact number does not matter). */
export const importersAtAnyDepth = (graph: ImportGraph, file: string, stopAt = Number.POSITIVE_INFINITY): number => {
    const seen = new Set<string>();
    const queue = [file];
    for (let next = queue.pop(); next !== undefined && seen.size <= stopAt; next = queue.pop()) {
        for (const importer of graph.importers.get(next) ?? []) {
            if (importer !== file && !seen.has(importer)) {
                seen.add(importer);
                queue.push(importer);
            }
        }
    }
    return seen.size;
};

/** The files a check of `file` loads: it and everything it imports at any depth, within what the graph knows. */
export const loadedBy = (graph: ImportGraph, roots: Iterable<string>): Set<string> => {
    const seen = new Set<string>();
    const queue = [...roots];
    for (let next = queue.pop(); next !== undefined; next = queue.pop()) {
        if (seen.has(next)) {
            continue;
        }
        seen.add(next);
        queue.push(...(graph.imports.get(next) ?? []));
    }
    return seen;
};

/** The project files above `file`: its direct importers in `project`, reached through any files outside the project in
 *  between (a library's barrel re-exporting it), never through another project file. */
export const projectImportersOf = (graph: ImportGraph, file: string, project: ReadonlySet<string>): Set<string> => {
    const found = new Set<string>();
    const seen = new Set<string>([file]);
    const queue = [file];
    for (let next = queue.pop(); next !== undefined; next = queue.pop()) {
        for (const importer of graph.importers.get(next) ?? []) {
            if (seen.has(importer)) {
                continue;
            }
            seen.add(importer);
            if (project.has(importer)) {
                found.add(importer);
            } else {
                queue.push(importer);
            }
        }
    }
    return found;
};
