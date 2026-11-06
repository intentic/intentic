import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { CodebaseHealth } from "@intentic/iq-engine";
import { within } from "@intentic/base/async";
import { pathExists } from "@intentic/base/fs";
import type { ChorePackage, ChoreShape, ChoreSignals } from "@intentic/sandbox-contract/schemas/maintenance";
import { REFERENCE_DIR } from "@intentic/workspace-ignore";
import { readWorkspaceManifestsAsync, type WorkspaceManifest } from "../workspace/deps/package-graph.js";
import type { Services } from "../composition.js";
import { generationMemo } from "../git/feed/generation-memo.js";

// Local chore evidence is shared by checkout generation. The age bound also refreshes ignored files and lets an index
// still building catch up. probes.ts holds facts that need a registry call or a shell-out.

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
export const packageSignals = async (repoDir: string, manifests?: readonly WorkspaceManifest[]): Promise<ChorePackage[]> =>
    await Promise.all(
        (manifests ?? (await readWorkspaceManifestsAsync(repoDir))).map(async ({ dir, name, manifest }) => {
            const entry: ChorePackage = {
                dir,
                name,
                dependencies: dependencyNames(manifest, "dependencies"),
                devDependencies: dependencyNames(manifest, "devDependencies"),
                documented: await pathExists(docPath(repoDir, dir)),
            };
            // `engines` is omitted, not undefined, when absent; exactOptionalPropertyTypes treats them differently.
            const engines = enginesOf(manifest);
            return engines === undefined ? entry : Object.assign(entry, { engines });
        }),
    );

// Bounds the Dockerfile/doc walk's depth and count; a route the rail badge polls must not walk a whole tree.
const SHAPE_DEPTH = 3;
const SHAPE_LIMIT = 20;

// CI files by convention; `.github/workflows` is a directory, the rest are single files at the repo root.
const CI_FILES = [".gitlab-ci.yml", ".circleci/config.yml", "azure-pipelines.yml", "Jenkinsfile", ".drone.yml", "bitbucket-pipelines.yml"];
const WORKFLOWS_DIR = join(".github", "workflows");

// Every read here is async: the route the rail badge polls must not hold the daemon's event loop for a repo's walk.
const entriesOf = async (dir: string) => await readdir(dir, { withFileTypes: true }).catch(() => []);

const listDir = async (dir: string): Promise<string[]> => (await entriesOf(dir)).filter((entry) => entry.isFile()).map((entry) => entry.name);

// Not a glob library, not unbounded recursion: a bounded walk may miss a file, which beats an unbounded poll.
const IGNORED = new Set(["node_modules", ".git", "dist", "build", ".cache", "coverage", ".venv", "target", "vendor"]);

const findFiles = async (root: string, matches: (name: string) => boolean, skipRootReference = false): Promise<string[]> => {
    const found: string[] = [];
    let frontier = [""];
    for (let depth = 0; depth <= SHAPE_DEPTH && frontier.length > 0 && found.length < SHAPE_LIMIT; depth++) {
        const next: string[] = [];
        // One level read at once, then folded in frontier order, so what is found (and where the limit cuts) is the
        // same as reading each directory in turn.
        const levels = await Promise.all(frontier.map((relative) => entriesOf(join(root, relative))));
        for (const [index, relative] of frontier.entries()) {
            for (const entry of levels[index]!) {
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
const declaredDeps = async (repoDir: string, manifests: readonly WorkspaceManifest[]): Promise<string[]> => {
    const names = new Set<string>();
    const collect = (manifest: Record<string, unknown>): void => {
        for (const block of DEP_BLOCKS) {
            for (const name of dependencyNames(manifest, block)) {
                names.add(name);
            }
        }
    };
    try {
        collect(JSON.parse(await readFile(join(repoDir, "package.json"), "utf8")) as Record<string, unknown>);
    } catch {
        // No root manifest, or one that fails to parse; workspace packages below are still read.
    }
    for (const { manifest } of manifests) {
        collect(manifest);
    }
    return [...names].toSorted();
};

const LOCKFILES = ["pnpm-lock.yaml", "package-lock.json", "yarn.lock", "bun.lockb"];
const present = async (repoDir: string, files: readonly string[]): Promise<string[]> => {
    const found = await Promise.all(files.map((file) => pathExists(join(repoDir, file))));
    return files.filter((_file, index) => found[index]);
};

// Every check is a stat or shallow readdir, cheap enough for a route the rail badge polls. `docs` looks for the
// repository map itself, not just the directory, since an empty `docs/architecture/` has nothing to gate on.
export const choreShape = async (repoDir: string, workspaceRoot = false, manifests?: readonly WorkspaceManifest[]): Promise<ChoreShape> => {
    const listed = manifests ?? (await readWorkspaceManifestsAsync(repoDir));
    const [docs, dockerfiles, workflows, ciFiles, lockfiles, packageManifest, deps] = await Promise.all([
        findFiles(join(repoDir, "docs", "architecture"), (name) => name.endsWith(".md")),
        findFiles(repoDir, isDockerfile, workspaceRoot),
        listDir(join(repoDir, WORKFLOWS_DIR)),
        present(repoDir, CI_FILES),
        present(repoDir, LOCKFILES),
        pathExists(join(repoDir, "package.json")),
        declaredDeps(repoDir, listed),
    ]);
    return {
        docs,
        dockerfiles,
        ci: [...workflows.filter((name) => name.endsWith(".yml") || name.endsWith(".yaml")).map((name) => `${WORKFLOWS_DIR}/${name}`), ...ciFiles],
        lockfile: lockfiles.length > 0,
        packageManifest,
        deps,
    };
};

// How long the polled list waits on one repo's rankings, under the 30 s the editor calls a stalled query. The history
// read behind them can take minutes when it has to start over (no kept fold, a rewritten branch); it goes on in the
// engine, which keeps it, and a later poll finds it done.
const HEALTH_WAIT_MS = 20_000;

// Rankings that say nothing: `indexed: false` keeps every chore that reads them from acting, as a half-built index does,
// and keeps the reading out of the generation memo so the next ask tries again.
const NO_RANKINGS: CodebaseHealth = {
    hotspots: [],
    modules: [],
    totals: { files: 0, symbols: 0, complexity: 0, hotspots: 0 },
    freshness: { state: "building" },
};

// One repo's rankings, or none: an engine that fails or is slow costs the list its rankings, never the whole answer
// (Oct 28-Nov 6: 137 list calls answered 500 on one history read that ran out of time).
const rankingsOf = async (services: Pick<Services, "iq" | "logger">, repo: string): Promise<CodebaseHealth> => {
    try {
        return await within(services.iq.health({ scope: { repo }, limit: RANKING_LIMIT }), HEALTH_WAIT_MS, NO_RANKINGS);
    } catch (error) {
        services.logger.warn({ err: error, repo }, "chores: code health unavailable, listing without rankings");
        return NO_RANKINGS;
    }
};

const choreSignals = async (services: Pick<Services, "iq" | "workspace" | "logger">, repo: string): Promise<ChoreSignals> => {
    const repoDir = join(services.workspace.root, repo);
    const [health, manifests] = await Promise.all([rankingsOf(services, repo), readWorkspaceManifestsAsync(repoDir)]);
    const [packages, shape] = await Promise.all([packageSignals(repoDir, manifests), choreShape(repoDir, repo === "", manifests)]);
    return {
        packages,
        shape,
        hotspots: health.hotspots,
        keyModules: health.modules,
        totals: health.totals,
        // Only a fresh index may drive a verdict; "stale" (behind by a few files) is fine, "building" is not.
        indexed: health.freshness.state !== "building",
    };
};

// One repo's reading in flight, the order it began in, and the reading queued behind it for callers that asked after.
interface Flight {
    readonly begun: number;
    readonly reading: Promise<ChoreSignals>;
    next?: Promise<ChoreSignals>;
}

export interface SharedChoreSignals {
    // A caller's place in line, taken as it arrives, before it asks for any repo.
    readonly asked: () => number;
    // Reuses evidence when its checkout generation matches within the age bound. Without feed coverage, a fresh
    // reading starts after `asked`, shared with everyone who was already waiting.
    readonly of: (repo: string, asked: number) => Promise<ChoreSignals>;
}

// The rail badge and the panel ask at once, each walking every repo through one iq engine that answers them one by one,
// so the second paid for every reading the first had just taken. A reading is shared only with callers that asked before
// it began when no generation can vouch for freshness. A generation-validated completed reading can serve the next
// caller too, avoiding another index request and another synchronous manifest/shape scan.
export const sharedChoreSignals = (services: Pick<Services, "iq" | "workspace" | "logger">): SharedChoreSignals => {
    let clock = 0;
    const flights = new Map<string, Flight>();
    const memo = generationMemo<ChoreSignals>({ maxAgeMs: 10_000, cacheable: (signals) => signals.indexed });
    const begin = (repo: string): Promise<ChoreSignals> => {
        const reading = memo(repo, [join(services.workspace.root, repo)], "", () => choreSignals(services, repo));
        const flight: Flight = { begun: (clock += 1), reading };
        flights.set(repo, flight);
        // Kept while a next reading is queued behind it, which takes its place as it begins.
        const settled = (): void => {
            if (flights.get(repo) === flight && flight.next === undefined) {
                flights.delete(repo);
            }
        };
        void flight.reading.then(settled, settled);
        return flight.reading;
    };
    return {
        asked: () => (clock += 1),
        of: (repo, asked) => {
            const flight = flights.get(repo);
            if (flight === undefined) {
                return begin(repo);
            }
            if (flight.begun > asked) {
                return flight.reading;
            }
            flight.next ??= flight.reading.then(
                () => begin(repo),
                () => begin(repo),
            );
            return flight.next;
        },
    };
};
