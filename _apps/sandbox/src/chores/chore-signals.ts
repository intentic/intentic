import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ChorePackage, ChoreShape, ChoreSignals } from "@intentic/sandbox-contract";
import { readWorkspaceManifests } from "../workspace/package-graph.js";
import type { Services } from "../composition.js";

/* THE CHEAP HALF of a repository's chore evidence: everything the daemon can answer without starting a
 * subprocess. It is recomputed on every GET /chores rather than cached, which is only defensible because of what
 * is in it — a directory read of package manifests the daemon already parses for the dependency graph, one stat
 * per package, and a call into the RESIDENT iq index that is answering search queries anyway. Nothing here shells
 * out, and nothing here waits on the network. Everything that would is a probe.
 *
 * The line between this and probes.ts is cost, not subject: `outdated` and `packages` are both facts about
 * dependencies, and they are on opposite sides of it because one needs the registry and the other needs a file
 * the daemon has already read. */

// How many hotspots and key modules a chore ever needs. The complexity chore asks whether a file is an OUTLIER in
// its own ranking, which a leaderboard answers and a full report only makes more expensive — and this list is
// carried per repo on a route the rail badge polls.
const RANKING_LIMIT = 12;

// The architecture document a package is expected to have. Named here rather than imported from the documentation
// extension: that extension owns generating and publishing them, this only asks whether one EXISTS, and a daemon
// route reaching into a browser extension's module for a path constant would be the wrong direction entirely.
const docPath = (repoDir: string, packageDir: string): string => join(repoDir, "docs", "architecture", packageDir, "doc.md");

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

/* A repo that is not a pnpm workspace has no packages, and that is a true answer rather than a gap: the chores
 * that read `packages` (documentation, libraries, runtime pins) then find nothing to say, which is right — a
 * single-package repo has no package to be undocumented and no second library to collide with the first.
 *
 * The ROOT manifest is deliberately not folded in as a pseudo-package. It would make every non-monorepo report
 * exactly one undocumented "package", which is a finding about our own modelling rather than about the code. */
export const packageSignals = (repoDir: string): ChorePackage[] =>
    readWorkspaceManifests(repoDir).map(({ dir, name, manifest }) => {
        const entry: ChorePackage = {
            dir,
            name,
            dependencies: dependencyNames(manifest, "dependencies"),
            devDependencies: dependencyNames(manifest, "devDependencies"),
            documented: existsSync(docPath(repoDir, dir)),
        };
        // `engines` is absent rather than undefined for a package that declares none — the wire schema makes it
        // optional, and exactOptionalPropertyTypes means the two are different values.
        const engines = enginesOf(manifest);
        return engines === undefined ? entry : Object.assign(entry, { engines });
    });

// How deep the Dockerfile and document sweeps look, and how many paths they carry. A bound on the walk, not on
// what exists: the question every applicability gate asks is "is there ANY", and a repo with forty Dockerfiles
// answers that as clearly as one with three — while a route the rail badge polls must not walk a whole tree.
const SHAPE_DEPTH = 3;
const SHAPE_LIMIT = 20;

// CI pipeline definitions, by the conventions that are a single known path. `.github/workflows` is a directory
// (any file in it counts); the rest are files at the repo root.
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

/* Repo-relative paths matching a predicate, breadth-first to a fixed depth. Deliberately not a glob library and
 * deliberately not recursive-without-bound: this runs per repo on every GET /chores, and the honest failure mode
 * of a bounded walk (a Dockerfile four directories deep goes unseen, so its chore stays hidden) is far better
 * than an unbounded one (a poll that walks node_modules). Ignored directories are skipped by name, the same
 * shortlist the workspace tree walk uses. */
const IGNORED = new Set(["node_modules", ".git", "dist", "build", ".cache", "coverage", ".venv", "target", "vendor"]);

const findFiles = (root: string, matches: (name: string) => boolean): string[] => {
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
                if (entry.isDirectory() && !IGNORED.has(entry.name) && !entry.name.startsWith(".")) {
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

// A Dockerfile by either convention — `Dockerfile`, `Dockerfile.prod`, `web.Dockerfile`. Compose files are
// deliberately not counted: they orchestrate images, they are not one to make smaller.
const isDockerfile = (name: string): boolean => name === "Dockerfile" || name.startsWith("Dockerfile.") || name.endsWith(".Dockerfile");

const DEP_BLOCKS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];

/* Every dependency name declared anywhere in the repo, sorted and deduplicated. The ROOT manifest is read
 * directly here even though `packageSignals` already walks the workspace packages, and that is the entire point:
 * a repository with no pnpm-workspace.yaml has no workspace packages, so a single-package Vite or Angular app
 * would otherwise declare no dependencies at all and every gate reading them would be silently dark.
 *
 * All four blocks, peer and optional included. A UI framework arrives as a peerDependency in every component
 * library in the ecosystem, and a gate that only read `dependencies` would decide such a package is not a React
 * package while every file in it imports React. */
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
        // No root manifest, or one that does not parse. The workspace packages below are still worth reading, and
        // an unparseable manifest is the repo's problem to report — not a reason for every gate here to throw.
    }
    for (const { manifest } of readWorkspaceManifests(repoDir)) {
        collect(manifest);
    }
    return [...names].toSorted();
};

/* What this repository is MADE OF, for the applicability gates. Every check here is a stat or a shallow readdir,
 * which is what lets it sit on a route the rail badge polls — anything that needed a subprocess would be a probe.
 *
 * `docs` looks for the architecture documents themselves rather than for the directory: an empty
 * `docs/architecture/` is a directory somebody made and never filled, and gating the drift survey on it would put
 * the chore back exactly where a repo with nothing to re-read cannot use it. */
export const choreShape = (repoDir: string): ChoreShape => ({
    docs: findFiles(join(repoDir, "docs", "architecture"), (name) => name.endsWith(".md")),
    dockerfiles: findFiles(repoDir, isDockerfile),
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
        shape: choreShape(repoDir),
        hotspots: health.hotspots,
        keyModules: health.modules,
        totals: health.totals,
        /* Only a FRESH index may drive a verdict. A build in progress has ranked whatever it has finished reading,
         * which is not the repository — and the complexity chore acting on that would send a turn at whichever
         * file happened to be indexed first. "stale" (the index is behind by some files) is fine: the ranking is
         * still over the whole repo, just missing the last few edits, which cannot promote a file into being an
         * outlier by three times its ranking's median. */
        indexed: health.freshness.state !== "building",
    };
};
