import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { readWorkspaceManifests } from "../workspace/deps/package-graph.js";
import type { Ecosystem } from "./registry-freshness.js";

// A version pin already used anywhere in this workspace is treated as a decision already made; the freshness hook stays
// silent about it, even at the cost of never nagging a uniformly stale workspace. Built once per turn, lazily, only if
// a pin is actually looked up.

export type WorkspacePins = (ecosystem: Ecosystem, name: string) => ReadonlySet<string>;

const EMPTY: ReadonlySet<string> = new Set();

const record = (into: Map<string, Set<string>>, name: string, specifier: unknown): void => {
    if (typeof specifier !== "string") {
        return;
    }
    const version = specifier.replace(/^[\^~>=<\s]+/, "").trim();
    // A range with no concrete version, or a workspace/catalog reference, pins nothing.
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

// The pnpm catalog, where most versions in a workspace like this actually live; read from the file directly since a
// catalog entry is not a package dependency.
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
            // An unreadable tree means no opinion, erring toward reporting rather than failing a hook mid tool-call.
        }
        return built;
    };
    return (ecosystem, name) => {
        // npm only: catalog and manifests here are npm's; answering for PyPI risks a false suppression by name.
        if (ecosystem !== "npm") {
            return EMPTY;
        }
        index ??= build();
        return index.get(name) ?? EMPTY;
    };
};
