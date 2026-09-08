import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ChorePackage, ChoreShape, ChoreSignals } from "@intentic/sandbox-contract";
import { REFERENCE_DIR } from "@intentic/workspace-ignore";
import { readWorkspaceManifests } from "../workspace/deps/package-graph.js";
import type { Services } from "../composition.js";

// The cheap half of chore evidence: everything answerable without a subprocess or network call, recomputed on every GET
// /chores since the ingredients (manifest reads, stats, the resident iq index) are already free. probes.ts holds a fact
// only when it costs a registry call or a shell-out.

// Hotspots and key modules a chore ever needs; the complexity chore only asks if a file outranks this list.
const RANKING_LIMIT = 12;

// The architecture doc a package is expected to have: its own README, checked for existence only, not imported from the
// docs extension.
const docPath = (repoDir: string, packageDir: string): string => join(repoDir, packageDir, "README.md");

const dependencyNames = (manifest: Record<string, unknown>, block: string): string[] => {
    const deps = manifest[block];
    return typeof deps === "object" && deps !== null ? Object.keys(deps) : [];
};

const enginesOf = (manifest: Record<string, unknown>): Record<string, string> | undefined => {
    const engines = manifest["engines"];
    if (typeof engines !== "object" || engines === null) {
        return undefined;
    }
    const pairs = Object.entries(engines).filter((entry): entry is [string, string] => typeof entry[1] === "string");
    return pairs.length === 0 ? undefined : Object.fromEntries(pairs);
};

// A repo with no pnpm workspace has no packages; that's a true answer, not a gap. The root manifest is deliberately not
// folded in as a pseudo-package.
export const packageSignals = (repoDir: string): ChorePackage[] =>
    readWorkspaceManifests(repoDir).map(({ dir, name, manifest }) => {
        const entry: ChorePackage = {
            dir,
            name,
            dependencies: dependencyNames(manifest, "dependencies"),
            devDependencies: dependencyNames(manifest, "devDependencies"),
            documented: existsSync(docPath(repoDir, dir)),
        };
        // `engines` is omitted, not undefined, when absent; exactOptionalPropertyTypes treats them differently.
        const engines = enginesOf(manifest);
        return engines === undefined ? entry : Object.assign(entry, { engines });
    });

// Bounds the Dockerfile/doc walk's depth and count; a route the rail badge polls must not walk a whole tree.
const SHAPE_DEPTH = 3;
const SHAPE_LIMIT = 20;

// CI files by convention; `.github/workflows` is a directory, the rest are single files at the repo root.
const CI_FILES = [".gitlab-ci.yml", ".circleci/config.yml", "azure-pipelines.yml", "Jenkinsfile", ".drone.yml", "bitbucket-pipelines.yml"];
const WORKFLOWS_DIR = join(".github", "workflows");

const listDir = (dir: string): string[] => {
    try {
        return readdirSync(dir, { withFileTypes: true })
            .filter((entry) => entry.isFile())
            .map((entry) => entry.name);
    } catch {
        return [];
    }
};

// Not a glob library, not unbounded recursion: a bounded walk may miss a file, which beats an unbounded poll.
const IGNORED = new Set(["node_modules", ".git", "dist", "build", ".cache", "coverage", ".venv", "target", "vendor"]);

const findFiles = (root: string, matches: (name: string) => boolean, skipRootReference = false): string[] => {
    const found: string[] = [];
    let frontier = [""];
    for (let depth = 0; depth <= SHAPE_DEPTH && frontier.length > 0 && found.length < SHAPE_LIMIT; depth++) {
        const next: string[] = [];
        for (const relative of frontier) {
            let entries;
            try {
                entries = readdirSync(join(root, relative), { withFileTypes: true });
            } catch {
                continue;
            }
            for (const entry of entries) {
                const path = relative === "" ? entry.name : `${relative}/${entry.name}`;
                const rootReference = skipRootReference && relative === "" && entry.name === REFERENCE_DIR;
                if (entry.isDirectory() && !rootReference && !IGNORED.has(entry.name) && !entry.name.startsWith(".")) {
                    next.push(path);
                } else if (entry.isFile() && matches(entry.name) && found.length < SHAPE_LIMIT) {
                    found.push(path);
                }
            }
        }
        frontier = next;
    }
    return found;
};

// Matches `Dockerfile`, `Dockerfile.prod`, `web.Dockerfile`; compose files are not counted, they orchestrate images.
const isDockerfile = (name: string): boolean => name === "Dockerfile" || name.startsWith("Dockerfile.") || name.endsWith(".Dockerfile");

const DEP_BLOCKS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];

// Reads the root manifest directly, since a single-package repo has no workspace packages to read otherwise. All four
// dependency blocks count, since peerDependencies is how a UI framework or component library is declared.
const declaredDeps = (repoDir: string): string[] => {
    const names = new Set<string>();
    const collect = (manifest: Record<string, unknown>): void => {
        for (const block of DEP_BLOCKS) {
            for (const name of dependencyNames(manifest, block)) {
                names.add(name);
            }
        }
    };
    try {
        collect(JSON.parse(readFileSync(join(repoDir, "package.json"), "utf8")) as Record<string, unknown>);
    } catch {
        // No root manifest, or one that fails to parse; workspace packages below are still read.
    }
    for (const { manifest } of readWorkspaceManifests(repoDir)) {
        collect(manifest);
    }
    return [...names].toSorted();
};

// Every check is a stat or shallow readdir, cheap enough for a route the rail badge polls. `docs` looks for the
// repository map itself, not just the directory, since an empty `docs/architecture/` has nothing to gate on.
export const choreShape = (repoDir: string, workspaceRoot = false): ChoreShape => ({
    docs: findFiles(join(repoDir, "docs", "architecture"), (name) => name.endsWith(".md")),
    dockerfiles: findFiles(repoDir, isDockerfile, workspaceRoot),
    ci: [
        ...listDir(join(repoDir, WORKFLOWS_DIR))
            .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
            .map((name) => `${WORKFLOWS_DIR}/${name}`),
        ...CI_FILES.filter((file) => existsSync(join(repoDir, file))),
    ],
    lockfile: ["pnpm-lock.yaml", "package-lock.json", "yarn.lock", "bun.lockb"].some((file) => existsSync(join(repoDir, file))),
    packageManifest: existsSync(join(repoDir, "package.json")),
    deps: declaredDeps(repoDir),
});

export const choreSignals = async (services: Services, repo: string): Promise<ChoreSignals> => {
    const health = await services.iq.health({ scope: { repo }, limit: RANKING_LIMIT });
    const repoDir = join(services.workspace.root, repo);
    return {
        packages: packageSignals(repoDir),
        shape: choreShape(repoDir, repo === ""),
        hotspots: health.hotspots,
        keyModules: health.modules,
        totals: health.totals,
        // Only a fresh index may drive a verdict; "stale" (behind by a few files) is fine, "building" is not.
        indexed: health.freshness.state !== "building",
    };
};
