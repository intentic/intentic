import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { readWorkspaceManifests } from "../workspace/package-graph.js";
import type { Ecosystem } from "./registry-freshness.js";

/* WHAT THIS WORKSPACE ALREADY USES, which is the difference between a check worth having on and one that gets
 * switched off in a day.
 *
 * The freshness hook's single largest source of false alarms is also its most legitimate case: a new package
 * inside a monorepo should pin the version the rest of the tree pins, not whatever the registry published this
 * morning. Measured over this workspace's own history, most version literals an agent wrote that were "behind"
 * were behind for exactly that reason and were CORRECT. A notice that could not tell them apart would report
 * the whole catalog as a problem every time somebody scaffolded a package.
 *
 * So a version that already appears somewhere in this workspace is treated as a decision the project has
 * already made, and the hook says nothing about it. The cost is real and accepted: a workspace that is
 * uniformly a year behind is never nagged about it. That is the right trade — internal consistency beats
 * chasing latest, a bump is a deliberate piece of work somebody asks for, and the case this feature exists for
 * is the package NOTHING here has an opinion about yet.
 *
 * Built once, lazily, and only if a pin is actually seen: a turn that never touches a manifest never pays the
 * walk, and a turn that touches five pays it once. */

export type WorkspacePins = (ecosystem: Ecosystem, name: string) => ReadonlySet<string>;

const EMPTY: ReadonlySet<string> = new Set();

const record = (into: Map<string, Set<string>>, name: string, specifier: unknown): void => {
    if (typeof specifier !== "string") {
        return;
    }
    const version = specifier.replace(/^[\^~>=<\s]+/, "").trim();
    // A range with no concrete version, or a workspace/catalog reference, says nothing about what is pinned.
    if (!/^\d+\.\d+/.test(version)) {
        return;
    }
    const existing = into.get(name);
    if (existing === undefined) {
        into.set(name, new Set([version]));
    } else {
        existing.add(version);
    }
};

const DEPENDENCY_BLOCKS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"] as const;

/* The pnpm catalog, which in a workspace like this one is where nearly every version actually lives. Read
 * straight from the file rather than through the manifest reader: a catalog entry is not a dependency of any
 * package, so nothing that walks packages would ever see it, and it is the one place most worth seeing. */
const catalogVersions = (root: string, into: Map<string, Set<string>>): void => {
    const file = join(root, "pnpm-workspace.yaml");
    if (!existsSync(file)) {
        return;
    }
    let parsed: { catalog?: Record<string, unknown>; catalogs?: Record<string, Record<string, unknown>> } | undefined;
    try {
        parsed = parse(readFileSync(file, "utf8")) as typeof parsed;
    } catch {
        return;
    }
    for (const [name, specifier] of Object.entries(parsed?.catalog ?? {})) {
        record(into, name, specifier);
    }
    for (const named of Object.values(parsed?.catalogs ?? {})) {
        for (const [name, specifier] of Object.entries(named)) {
            record(into, name, specifier);
        }
    }
};

export const createWorkspacePins = (root: string): WorkspacePins => {
    let index: Map<string, Set<string>> | undefined;
    const build = (): Map<string, Set<string>> => {
        const built = new Map<string, Set<string>>();
        try {
            catalogVersions(root, built);
            for (const { manifest } of readWorkspaceManifests(root)) {
                for (const block of DEPENDENCY_BLOCKS) {
                    for (const [name, specifier] of Object.entries((manifest as Record<string, unknown>)[block] ?? {})) {
                        record(built, name, specifier);
                    }
                }
            }
        } catch {
            // An unreadable tree means no opinion, which errs toward reporting. A missed suppression is one
            // notice too many; a walk that threw here would be a hook that failed in front of a tool call.
        }
        return built;
    };
    return (ecosystem, name) => {
        // npm only, deliberately: the catalog and the manifests this reads are npm's, and pretending to answer
        // for PyPI from them would suppress a real notice on the strength of a name collision.
        if (ecosystem !== "npm") {
            return EMPTY;
        }
        index ??= build();
        return index.get(name) ?? EMPTY;
    };
};
