import { posix } from "node:path";
import type { WorkspaceDepEdge, WorkspaceDepUsage, WorkspaceGraph } from "@intentic/sandbox-contract";
import { importsOf } from "./import-scan.js";
import { packageFiles, readSources } from "./package-files.js";
import { readPackageGraph, readWorkspaceManifests, type WorkspaceManifest } from "./package-graph.js";

// What each declared workspace dependency is for, read from the dependent's own files rather than its manifest: a value
// import in a file it ships, only types, only its tests and tooling, a file that names it without importing it (a
// Dockerfile copying its build, a stylesheet reaching its files by path), or nothing at all. The strongest use wins.

// Files that build, test or describe a package rather than ship in it, by path inside the package.
const TOOLING_DIR = /(?:^|\/)(?:tests?|__tests__|__mocks__|e2e|fixtures?|scripts|bench(?:marks?)?|stories|\.storybook)\//;
const TOOLING_FILE = new RegExp(
    [
        String.raw`\.(?:test|spec|testing|stories|bench|e2e)\.[^/]+$`,
        // A build or lint tool's own config, whatever the tool: vite.config.ts, electron.vite.config.ts, tsconfig.app.json.
        String.raw`(?:^|\/)(?:[\w-]+\.)*(?:vite|vitest|eslint|prettier|playwright|astro|tailwind|postcss|svelte|nuxt|next|webpack|rollup|babel|jest|tsup|tsdown|uno|stylelint|knip|electron\.vite)\.config\.[^/]+$`,
        String.raw`(?:^|\/)(?:tsconfig[^/]*\.json|bunfig\.toml|biome\.jsonc?|turbo\.json|layers\.json|\.[^/]+)$`,
    ].join("|"),
);
export const isTooling = (inPackage: string): boolean => TOOLING_DIR.test(inPackage) || TOOLING_FILE.test(inPackage);

// Read for import statements.
const CODE = /\.(?:[cm]?[jt]sx?|vue|svelte|astro|css|scss|sass|less|pcss)$/;
// Read only for a sibling's name or path: what packs, configures or runs a package without importing it.
const NAMING = /(?:^|\/)(?:Dockerfile[^/]*|[^/]+\.(?:sh|json|jsonc|ya?ml|toml|html))$/;
// The dependent's own manifest is the declaration being judged, and a lockfile repeats it.
const DECLARATION = /(?:^|\/)(?:package\.json|pnpm-lock\.yaml|package-lock\.json|bun\.lockb?)$/;

const RANK: Readonly<Record<WorkspaceDepUsage, number>> = { none: 0, tooling: 1, reference: 2, types: 3, code: 4 };
const stronger = (a: WorkspaceDepUsage | undefined, b: WorkspaceDepUsage): WorkspaceDepUsage => (a === undefined || RANK[b] > RANK[a] ? b : a);

interface Sibling {
    readonly name: string;
    readonly dir: string;
}

// The package a specifier lands in: a bare one by its name (`@scope/pkg` or `@scope/pkg/sub`), a relative one by the
// directory it resolves into, from `from`, a repository-relative path.
const landsIn = (siblings: readonly Sibling[], byName: ReadonlyMap<string, Sibling>, from: string, specifier: string): Sibling | undefined => {
    if (specifier.startsWith(".")) {
        const target = posix.normalize(posix.join(posix.dirname(from), specifier));
        return siblings.find(({ dir }) => target === dir || target.startsWith(`${dir}/`));
    }
    const parts = specifier.split("/");
    return byName.get(specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!);
};

// Whether `text` names `needle` as a whole token: a name is not part of a longer one (`@x/sdk` in `@x/sdk-node`).
const names = (text: string, needle: string): boolean => {
    for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + 1)) {
        const next = text[at + needle.length];
        if (next === undefined || !/[\w-]/.test(next)) {
            return true;
        }
    }
    return false;
};

/**
 * Each declared edge's usage, read from the files of every dependent. `packages` are the workspace's manifests;
 * `edges` the declared edges. Returns the edges with `usage` filled.
 */
export const withUsage = async (
    repoDir: string,
    packages: readonly WorkspaceManifest[],
    edges: readonly WorkspaceDepEdge[],
): Promise<WorkspaceDepEdge[]> => {
    if (edges.length === 0) {
        return [];
    }
    // Longest directory first, so a package nested in another's directory owns its own files.
    const siblings: Sibling[] = packages.map(({ name, dir }) => ({ name, dir })).toSorted((a, b) => b.dir.length - a.dir.length);
    const byName = new Map(siblings.map((sibling) => [sibling.name, sibling]));
    const declared = new Map<string, Set<string>>();
    for (const { from, to } of edges) {
        (declared.get(from) ?? declared.set(from, new Set()).get(from)!).add(to);
    }
    const usage = new Map<string, WorkspaceDepUsage>();
    const note = (from: string, to: string, use: WorkspaceDepUsage): void => {
        const key = `${from}>${to}`;
        usage.set(key, stronger(usage.get(key), use));
    };

    // A sibling's command named in the dependent's own scripts (`"test": "suites"`) runs it as tooling.
    const commands = new Map(packages.map(({ name, manifest }) => [name, commandsOf(name, manifest["bin"])]));
    for (const { name, manifest } of packages) {
        const declaredScripts = manifest["scripts"];
        const scripts = typeof declaredScripts === "object" && declaredScripts !== null ? Object.values(declaredScripts).join("\n") : "";
        for (const to of declared.get(name) ?? []) {
            if ((commands.get(to) ?? []).some((command) => names(scripts, command))) {
                note(name, to, "tooling");
            }
        }
    }

    const dependents = siblings.filter(({ name }) => declared.has(name));
    const files = (
        await packageFiles(
            repoDir,
            dependents.map(({ dir }) => dir),
        )
    ).filter((path) => !DECLARATION.test(path) && (CODE.test(path) || NAMING.test(path)));
    await readSources(repoDir, files, (path, text) => {
        const owner = siblings.find(({ dir }) => path.startsWith(`${dir}/`));
        const targets = owner === undefined ? undefined : declared.get(owner.name);
        if (owner === undefined || targets === undefined) {
            return;
        }
        const tooling = isTooling(path.slice(owner.dir.length + 1));
        const imported = new Set<string>();
        if (CODE.test(path)) {
            for (const { specifier, typeOnly } of importsOf(path, text)) {
                const target = landsIn(siblings, byName, path, specifier);
                if (target !== undefined && target !== owner && targets.has(target.name)) {
                    imported.add(target.name);
                    note(owner.name, target.name, tooling ? "tooling" : typeOnly ? "types" : "code");
                }
            }
        }
        for (const to of targets) {
            const sibling = byName.get(to);
            if (sibling === undefined || imported.has(to)) {
                continue;
            }
            // A path names a sibling only with a slash in it: a one-segment directory (`docs`) is any word.
            if (names(text, sibling.name) || (sibling.dir.includes("/") && names(text, sibling.dir))) {
                note(owner.name, to, tooling ? "tooling" : "reference");
            }
        }
    });
    return edges.map((edge) => ({ ...edge, usage: usage.get(`${edge.from}>${edge.to}`) ?? "none" }));
};

// The commands a manifest's `bin` puts on PATH: a string `bin` is named after the package, unscoped.
const commandsOf = (name: string, bin: unknown): string[] => {
    if (typeof bin === "string") {
        return [name.split("/").at(-1)!];
    }
    return typeof bin === "object" && bin !== null ? Object.keys(bin) : [];
};

// A read reads every file of every dependent, a few hundred milliseconds on a large monorepo: one in flight per
// repository, and its answer kept a few seconds, so a view and its refetch on focus share one.
const KEEP_MS = 15_000;
const recent = new Map<string, { readonly at: number; readonly graph: Promise<WorkspaceGraph> }>();

/** The repository's package graph, each edge with its usage. */
export const readUsedPackageGraph = (repoDir: string): Promise<WorkspaceGraph> => {
    const held = recent.get(repoDir);
    if (held !== undefined && Date.now() - held.at < KEEP_MS) {
        return held.graph;
    }
    const graph = (async () => {
        const manifests = readWorkspaceManifests(repoDir);
        const declared = readPackageGraph(repoDir, manifests);
        return { ...declared, edges: await withUsage(repoDir, manifests, declared.edges) };
    })();
    recent.set(repoDir, { at: Date.now(), graph });
    // A failed read is not kept: the next ask tries again.
    graph.catch(() => recent.delete(repoDir));
    return graph;
};
