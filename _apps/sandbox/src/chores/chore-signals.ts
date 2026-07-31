import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ChorePackage, ChoreSignals } from "@intentic/sandbox-contract";
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

export const choreSignals = async (services: Services, repo: string): Promise<ChoreSignals> => {
    const health = await services.iq.health({ scope: { repo }, limit: RANKING_LIMIT });
    return {
        packages: packageSignals(join(services.workspace.root, repo)),
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
