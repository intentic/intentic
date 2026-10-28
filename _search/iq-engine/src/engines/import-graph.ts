import type { SqliteDb } from "@intentic/base/sqlite";
import { openIndex } from "../store/db.js";

// The resolved import graph shared by every engine that needs which file reaches which; not a verb itself. Built once
// because resolution needs the whole file set while the indexer sees one file at a time. Both directions (`imports`,
// `importedBy`) are built together rather than reversed per query.

const CANDIDATE_SUFFIXES = [".ts", ".tsx", ".mts", ".js", ".jsx", ".mjs", ".vue", ".py", ".go", ".rs", ".java"];
const INDEX_BASES = ["/index", "/main", "/mod"];

export interface ImportGraph {
    readonly pathsById: ReadonlyMap<number, string>;
    readonly idByPath: ReadonlyMap<string, number>;
    // A → the files A imports.
    readonly imports: ReadonlyMap<number, ReadonlySet<number>>;
    // B → the files that import B.
    readonly importedBy: ReadonlyMap<number, ReadonlySet<number>>;
}

// First chunk per file, a generated banner or package.json name; passed in so callers share one scan.
export const fileHeads = (db: SqliteDb): Map<number, string> =>
    new Map(
        db
            .all("SELECT file_id, text FROM chunks WHERE id IN (SELECT MIN(id) FROM chunks GROUP BY file_id)")
            .map((row) => [Number(row["file_id"]), String(row["text"] ?? "")]),
    );

const dirOf = (path: string): string => path.slice(0, Math.max(0, path.lastIndexOf("/")));

// Resolve `.`/`..` segments in an already-joined path.
const normalize = (path: string): string => {
    const parts: string[] = [];
    for (const segment of path.split("/")) {
        if (segment === "" || segment === ".") {
            continue;
        }
        if (segment === "..") {
            parts.pop();
            continue;
        }
        parts.push(segment);
    }
    return parts.join("/");
};

// TypeScript's ESM rule means source imports the emitted name, so `./widget.js` resolves to a real neighbour
// `widget.ts`; the .js→.ts rewrites are tried before extensionless and directory-index forms. Stop on the first
// match: eagerly constructing every suffix and index form allocated dozens of unused strings per relative import.
const resolveFile = (base: string, known: ReadonlySet<string>): string | undefined => {
    if (known.has(base)) {
        return base;
    }
    const jsLike = /\.(js|jsx|mjs|cjs)$/.exec(base);
    if (jsLike !== null) {
        const stem = base.slice(0, -jsLike[0].length);
        for (const suffix of [".ts", ".tsx", ".mts"]) {
            const candidate = `${stem}${suffix}`;
            if (known.has(candidate)) {
                return candidate;
            }
        }
    }
    for (const suffix of CANDIDATE_SUFFIXES) {
        const candidate = `${base}${suffix}`;
        if (known.has(candidate)) {
            return candidate;
        }
    }
    for (const indexBase of INDEX_BASES) {
        for (const suffix of CANDIDATE_SUFFIXES) {
            const candidate = `${base}${indexBase}${suffix}`;
            if (known.has(candidate)) {
                return candidate;
            }
        }
    }
    return undefined;
};

// Workspace package name → its directory, from each package.json's "name"; lets a cross-package import
// (`@intentic/sdk`) resolve to that package's entry file instead of leaving the graph fragmented into islands.
const packageDirs = (db: SqliteDb, heads: ReadonlyMap<number, string>): Map<string, string> => {
    const dirs = new Map<string, string>();
    for (const row of db.all("SELECT id, path FROM files WHERE path LIKE '%package.json'")) {
        const name = /"name"\s*:\s*"([^"]+)"/.exec(heads.get(Number(row["id"])) ?? "")?.[1];
        if (name !== undefined) {
            dirs.set(name, dirOf(row["path"] as string));
        }
    }
    return dirs;
};

const resolveSpecifier = (
    specifier: string,
    fromPath: string,
    known: ReadonlySet<string>,
    packages: ReadonlyMap<string, string>,
): string | undefined => {
    const tryAll = (base: string): string | undefined => resolveFile(base, known);
    if (specifier.startsWith(".")) {
        return tryAll(normalize(`${dirOf(fromPath)}/${specifier}`));
    }
    // Longest package name wins, so `@scope/pkg/sub` prefers `@scope/pkg` over a shorter `@scope` entry.
    // Only slash-delimited prefixes can own this specifier. Probe longest first rather than scanning every package
    // for every import (including external dependencies, which have no owner in the workspace).
    let owner: string | undefined;
    let prefix = specifier;
    while (prefix !== "") {
        if (packages.has(prefix)) {
            owner = prefix;
            break;
        }
        const slash = prefix.lastIndexOf("/");
        if (slash === -1) {
            break;
        }
        prefix = prefix.slice(0, slash);
    }
    if (owner === undefined) {
        return undefined;
    }
    const dir = packages.get(owner)!;
    const subpath = specifier.slice(owner.length);
    return tryAll(normalize(`${dir}${subpath}`)) ?? tryAll(normalize(`${dir}/src${subpath}`));
};

export const buildImportGraph = (db: SqliteDb, allowed: ReadonlySet<string>, heads: ReadonlyMap<number, string>): ImportGraph => {
    const pathsById = new Map(
        db
            .all("SELECT id, path FROM files")
            .map((row) => [Number(row["id"]), row["path"] as string] as const)
            .filter(([, path]) => allowed.has(path)),
    );
    const idByPath = new Map([...pathsById].map(([id, path]) => [path, id] as const));
    const known = new Set(idByPath.keys());
    const packages = packageDirs(db, heads);
    const imports = new Map<number, Set<number>>();
    const importedBy = new Map<number, Set<number>>();
    for (const row of db.all("SELECT file_id, specifier FROM imports")) {
        const from = Number(row["file_id"]);
        const fromPath = pathsById.get(from);
        if (fromPath === undefined) {
            continue;
        }
        const resolved = resolveSpecifier(row["specifier"] as string, fromPath, known, packages);
        // Unresolved specifiers are the common case (node_modules, stdlib) and are simply not edges.
        if (resolved === undefined || resolved === fromPath) {
            continue;
        }
        const to = idByPath.get(resolved)!;
        (imports.get(from) ?? imports.set(from, new Set()).get(from)!).add(to);
        (importedBy.get(to) ?? importedBy.set(to, new Set()).get(to)!).add(from);
    }
    return { pathsById, idByPath, imports, importedBy };
};

// The whole indexed corpus as one graph, for callers holding an index directory rather than a db handle. Scope
// filtering is the query layer's job; impact reaches what it reaches regardless of what was in view.
export const loadImportGraph = (indexDir: string): ImportGraph => {
    const db = openIndex(indexDir, "read");
    try {
        const every = new Set(db.all("SELECT path FROM files").map((row) => row["path"] as string));
        return buildImportGraph(db, every, fileHeads(db));
    } finally {
        db.close();
    }
};
