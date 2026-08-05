import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Capability, CapabilityRecommendation } from "@intentic/sandbox-contract";
import { IGNORED_DIRS } from "@intentic/workspace-ignore";

// What the WORKSPACE says it needs, read off /work rather than asked of the user.
//
// The motivating case: the Docker Engine is baked into the base image but dormant, and the container stays
// unprivileged until the docker capability is added. So a checked-out repo whose dev database is a compose
// service — `pnpm db:up` in this very repo — fails with a bare "Cannot connect to the Docker daemon", which
// names neither the capability nor the one-time privileged rebuild that turns it on. A compose file sitting in
// the workspace IS the signal that the rebuild is worth offering.
//
// Recommendations are advisory and evidence-bearing: each carries the path that produced it, so the card can
// say WHY instead of asking to be trusted. Nothing is enabled automatically — adding a capability is the
// owner's decision, and this one costs a rebuild.

const COMPOSE_FILES = new Set(["docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"]);

// Depth 2 is the shape /work actually takes: loose files at the root, and one directory per repo below it.
// Deeper compose files are a service's own detail (a repo's _tools/, an example) rather than the thing the user
// runs, and scanning for them would turn a page load into a full-tree walk.
const SCAN_DEPTH = 2;

const findCompose = async (dir: string, prefix: string, depth: number): Promise<string | undefined> => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    const here = entries.find((entry) => entry.isFile() && COMPOSE_FILES.has(entry.name));
    if (here !== undefined) {
        return `${prefix}${here.name}`;
    }
    if (depth === 0) {
        return undefined;
    }
    const dirs = entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && !IGNORED_DIRS.has(entry.name));
    const found = await Promise.all(dirs.map((entry) => findCompose(join(dir, entry.name), `${prefix}${entry.name}/`, depth - 1)));
    return found.find((path) => path !== undefined);
};

export const capabilityRecommendations = async (root: string, active: readonly Capability[]): Promise<CapabilityRecommendation[]> => {
    if (active.some((capability) => capability.kind === "docker")) {
        return [];
    }
    const compose = await findCompose(root, "", SCAN_DEPTH);
    return compose === undefined ? [] : [{ kind: "docker", evidence: compose }];
};
