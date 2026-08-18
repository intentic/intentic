import { type IndexDb, openIndex } from "../store/db.js";

// The resolved import graph, shared by every engine that needs to know which file reaches which. This is not a
// verb — nothing here answers a query. It is the one place the raw specifier rows become edges, because
// resolution needs the whole file set and the indexer only ever sees one file at a time.
//
// Both directions are built together and returned together. `imports` (A → what A pulls in) is what ranking
// wants: importance flows from importers to the modules they depend on. `importedBy` is the same edges reversed,
// and it is what impact wants: a change lands in a file, and the question is who reaches it. Reversing on demand
// would mean walking every edge again per query, and the reversal is the cheap half of building this.

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

// First chunk per file — where a generated banner sits, and where a package.json's "name" is. Callers that need
// heads for their own reasons pass the same map back in, so one scan serves both.
export const fileHeads = (db: IndexDb): Map<number, string> =>
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

// TypeScript's ESM rule means source imports the EMITTED name: `./widget.js` is written in a file whose real
// neighbour is `widget.ts`. Missing that maps a TS monorepo to an empty graph, so the .js→.ts rewrites come
// first, ahead of the extensionless and directory-index forms.
const candidatesFor = (base: string): string[] => {
    const candidates = [base];
    const jsLike = /\.(js|jsx|mjs|cjs)$/.exec(base);
    if (jsLike !== null) {
        const stem = base.slice(0, -jsLike[0].length);
        candidates.push(`${stem}.ts`, `${stem}.tsx`, `${stem}.mts`);
    }
    for (const suffix of CANDIDATE_SUFFIXES) {
        candidates.push(`${base}${suffix}`);
    }
    for (const indexBase of INDEX_BASES) {
        for (const suffix of CANDIDATE_SUFFIXES) {
            candidates.push(`${base}${indexBase}${suffix}`);
        }
    }
    return candidates;
};

// Workspace package name → its directory, read from each package.json's "name". Lets a cross-package import
// (`@intentic/sdk`) resolve to that package's entry file — without it the graph fragments into one island per
// package, which in a monorepo loses exactly the structure this exists to show.
const packageDirs = (db: IndexDb, heads: ReadonlyMap<number, string>): Map<string, string> => {
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
    const tryAll = (base: string): string | undefined => candidatesFor(base).find((candidate) => known.has(candidate));
    if (specifier.startsWith(".")) {
        return tryAll(normalize(`${dirOf(fromPath)}/${specifier}`));
    }
    // Longest package name wins, so `@scope/pkg/sub` prefers `@scope/pkg` over a shorter `@scope` entry.
    const owner = [...packages.keys()]
        .filter((name) => specifier === name || specifier.startsWith(`${name}/`))
        .toSorted((a, b) => b.length - a.length)[0];
    if (owner === undefined) {
        return undefined;
    }
    const dir = packages.get(owner)!;
    const subpath = specifier.slice(owner.length);
    return tryAll(normalize(`${dir}${subpath}`)) ?? tryAll(normalize(`${dir}/src${subpath}`));
};

export const buildImportGraph = (db: IndexDb, allowed: ReadonlySet<string>, heads: ReadonlyMap<number, string>): ImportGraph => {
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

// The whole indexed corpus as one graph, for callers that hold an index directory rather than a db handle.
// Scope filtering is the query layer's job; impact is asked about a change, and a change reaches what it
// reaches regardless of what the asker was looking at.
export const loadImportGraph = (indexDir: string): ImportGraph => {
    const db = openIndex(indexDir, "read");
    try {
        const every = new Set(db.all("SELECT path FROM files").map((row) => row["path"] as string));
        return buildImportGraph(db, every, fileHeads(db));
    } finally {
        db.close();
    }
};
