import { dirname, isAbsolute } from "node:path";
import { insideRel } from "@intentic/base/contained";
import type { Services } from "../../composition.js";
import { mainLineSha } from "../../git/main-line-tip.js";
import { agentRepoAnchor } from "../land/agent-changes.js";
import { landedBy } from "../overlap/branch-drift.js";
import type { InFlightOverlap } from "../files-in-flight.js";
import { isIsolated, type PersistedAgent } from "../registry/agents-store.js";
import { landMarksOf } from "../registry/land-marks.js";
import { sharedTitleOf } from "../seal/seal-family.js";
import { opt } from "../../opt.js";

// What `agents ls` and `agents show` say of the work in flight (conversations/overlap/): which files a conversation has
// changed and not landed, who else is changing them, and held work that stopped merging into its line.

// Paths `show` lists of a conversation's own, and per conversation sharing them; the counts say how many more.
const SHOWN_PATHS = 20;
// Paths an `ls --touching` row names under itself.
export const TOUCHING_SHOWN = 5;

export type FleetOverlapDeps = Partial<Pick<Services, "inFlight">> & { readonly agents: Pick<Services["agents"], "entry"> };

/** On a roster row: held work found no longer merging into its line, since when, and how many files clash. */
export interface FleetDriftRow {
    readonly since: number;
    readonly files: number;
}

/** A conversation as `show` names it: its id, and its title where it may be shown. */
export interface FleetNamed {
    readonly id: string;
    readonly title?: string;
}

/** In `show`: the clash file by file, each with the conversations whose landed work it clashes with. */
export interface FleetDrift extends FleetDriftRow {
    // Whether a resolve turn, or the parent, was asked to fix it, rather than only told.
    readonly asked: boolean;
    readonly repos: readonly {
        readonly repo: string;
        readonly onto: string;
        readonly paths: readonly { readonly path: string; readonly by?: readonly FleetNamed[] }[];
        readonly more?: number;
    }[];
}

export interface FleetOverlap {
    // How many files it has changed and not landed, and the first of them.
    readonly files: number;
    readonly paths: readonly string[];
    // The other live conversations changing some of the same files.
    readonly others: readonly InFlightOverlap[];
    readonly drift?: FleetDrift;
}

export const fleetDriftRow = (entry: PersistedAgent): FleetDriftRow | undefined => {
    const drift = landMarksOf(entry).drift;
    return drift === undefined ? undefined : { since: drift.at, files: drift.repos.reduce((total, repo) => total + repo.paths.length + (repo.more ?? 0), 0) };
};

const fleetDrift = (deps: FleetOverlapDeps, entry: PersistedAgent): FleetDrift | undefined => {
    const drift = landMarksOf(entry).drift;
    const row = fleetDriftRow(entry);
    if (drift === undefined || row === undefined) {
        return undefined;
    }
    const named = (id: string): FleetNamed => {
        const lander = deps.agents.entry(id);
        return { id, ...opt("title", lander === undefined ? undefined : sharedTitleOf(lander)) };
    };
    return {
        ...row,
        asked: drift.asked === true,
        repos: drift.repos.map(({ repo, onto, paths, more }) => ({
            repo,
            onto,
            paths: paths.map(({ path, by }) => ({ path, ...opt("by", by?.map(named)) })),
            ...opt("more", more),
        })),
    };
};

/** One conversation's work in flight as `show` prints it; undefined when it has none and nothing drifted. */
export const fleetOverlapOf = (deps: FleetOverlapDeps, entry: PersistedAgent): FleetOverlap | undefined => {
    const paths = deps.inFlight?.pathsOf(entry.id) ?? [];
    const drift = fleetDrift(deps, entry);
    if (paths.length === 0 && drift === undefined) {
        return undefined;
    }
    const others = (deps.inFlight?.overlapsOf(entry.id) ?? []).map((other) => ({ ...other, paths: other.paths.slice(0, SHOWN_PATHS) }));
    return { files: paths.length, paths: paths.slice(0, SHOWN_PATHS), others, ...opt("drift", drift) };
};

/** A land refused on conflicts, file by file, with the conversations whose landed commits changed each since this branch
 *  left the main line: who to ask about the other side. Files nobody here landed are left out, so is a repo with none. */
export interface FleetRefusedBy {
    readonly repo: string;
    readonly paths: readonly { readonly path: string; readonly by: readonly FleetNamed[] }[];
}

// Files read per repo; a refusal past this is one to read with `git log` by hand.
const REFUSED_READ = 40;

export const fleetRefusedBy = async (deps: Pick<Services, "agentWorktrees"> & FleetOverlapDeps, entry: PersistedAgent): Promise<readonly FleetRefusedBy[] | undefined> => {
    if (!isIsolated(entry) || (entry.landing.conflicts?.length ?? 0) === 0) {
        return undefined;
    }
    const named = (id: string): FleetNamed => {
        const lander = deps.agents.entry(id);
        return { id, ...opt("title", lander === undefined ? undefined : sharedTitleOf(lander)) };
    };
    const repos = await Promise.all(
        (entry.landing.conflicts ?? []).map(async ({ repo, paths }): Promise<FleetRefusedBy | undefined> => {
            const composed = entry.placement.repos.find((each) => each.repo === repo);
            const main = deps.agentWorktrees.mainDir(repo);
            const head = await mainLineSha(main);
            if (composed === undefined || head === undefined) {
                return undefined;
            }
            const anchor = await agentRepoAnchor(deps.agentWorktrees, entry, composed);
            const by = await landedBy(main, anchor, head, paths.slice(0, REFUSED_READ).map(({ path }) => path));
            const found = [...by].filter(([, ids]) => ids.length > 0 && !ids.every((id) => id === entry.id));
            return found.length === 0 ? undefined : { repo, paths: found.map(([path, ids]) => ({ path, by: ids.filter((id) => id !== entry.id).map(named) })) };
        }),
    );
    const kept = repos.filter((repo) => repo !== undefined);
    return kept.length === 0 ? undefined : kept;
};

/** A path a shell named, as the index keys it: workspace-relative. An absolute one under the shared tree or under a
 *  conversation's own checkout (`<worktrees>/<id>/…`) is taken relative to it; any other is kept as typed. */
export const indexedPath = (path: string, workspaceRoot: string, worktreesRoot: string): string => {
    if (!isAbsolute(path)) {
        return path;
    }
    const inTree = insideRel(workspaceRoot, path);
    if (inTree !== undefined) {
        return inTree;
    }
    const inCheckout = insideRel(worktreesRoot, path);
    if (inCheckout === undefined) {
        return path;
    }
    // The first segment is the conversation's id; what follows mirrors the shared tree.
    return inCheckout.split("/").slice(1).join("/");
};

/** Where the conversations' own checkouts live, read off the worktrees' own naming. */
export const worktreesRootOf = (worktrees: Pick<Services["agentWorktrees"], "conversationDir">): string => dirname(worktrees.conversationDir("_"));
