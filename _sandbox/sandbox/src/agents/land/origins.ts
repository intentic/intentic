import { defaultGit, type GitRunner } from "@intentic/scaffold";
import type { OriginAgent } from "@intentic/sandbox-contract";
import type { Logger } from "pino";
import { headSha } from "../../git/changes/changes.js";
import { materializedPaths } from "../../git/changes/changes-porcelain.js";
import type { AgentsRegistry } from "../registry/agents-registry.js";
import { landedMessageOf } from "../registry/agents-store.js";
import { type ExpiryTracker, pathWeight } from "../registry/expiry.js";

// Per-file attribution for the Changes panel, derived from git, never recorded separately: land patches landedTip's
// range in and records the tip (land.ts), so the claim is the diff back to the merge-base, not the frozen creation base
// a rebase would inflate. A path expires from the claim once the user commits it.

// One landing identified by what it did, not who did it: the same agent landing twice makes two claims, both measured.
const landingKey = (repo: string, head: string, tip: string): string => `${repo} ${head} ${tip}`;

export interface AgentOrigins {
    // path -> ids that landed it, newest first; empty when nothing here is attributable.
    readonly forRepo: (repo: string, dir: string, head?: string) => Promise<Record<string, string[]>>;
    // Resolved here, not the client: attribution reads the whole registry, archived agents included.
    readonly identify: (ids: Iterable<string>) => Record<string, OriginAgent>;
    // Cache sizes and text weight for the durable resource series; these maps were once a memory leak.
    readonly metrics: () => Readonly<Record<string, number>>;
}

export const createAgentOrigins = (
    options: { readonly agents: AgentsRegistry; readonly logger: Logger; readonly expiry: ExpiryTracker },
    git: GitRunner = defaultGit,
): AgentOrigins => {
    const { agents, logger, expiry } = options;
    // Every span here is between two fixed shas, so one diff each is all it costs; dropped once absorbed.
    const cache = new Map<string, readonly string[]>();
    const anchors = new Map<string, string>();
    // Unresolvable shas are remembered, so a broken landing fails once, not every scan; a restart retries.
    const unresolvable = new Set<string>();

    // Every path a span touches, including both legs of a rename (`--no-renames`, since git defaults renames on):
    // `--name-only` alone reports a rename only at its destination, hiding the deletion from the panel entirely.
    const pathsBetween = async (dir: string, key: string, args: readonly string[]): Promise<readonly string[]> => {
        const hit = cache.get(key);
        if (hit !== undefined) {
            return hit;
        }
        const { stdout } = await git(dir, ["diff", "--name-only", "--no-renames", "-z", ...args]);
        // Copied out of stdout, never sliced: a sliced path would pin the whole parent listing here.
        const paths = materializedPaths(stdout);
        cache.set(key, paths);
        return paths;
    };

    // What the agent wrote, read as it wrote it (anchor..tip).
    const landedPaths = (dir: string, repo: string, anchor: string, tip: string): Promise<readonly string[]> =>
        pathsBetween(dir, `landed ${repo} ${anchor} ${tip}`, [anchor, tip]);

    // What the land actually put in the tree (landedHead..tip); both ends fixed, so read once per landing, ever.
    const appliedPaths = (dir: string, repo: string, landedHead: string, tip: string): Promise<readonly string[]> =>
        pathsBetween(dir, `applied ${repo} ${landedHead} ${tip}`, [landedHead, tip]);

    // Where the branch left the main line, so the claim is the agent's own work, not what a rebase pulled in; falls
    // back to the recorded base for unrelated histories. Keyed on tip alone: a rebase already mints a new tip.
    const anchorOf = async (dir: string, repo: string, head: string, tip: string, base: string): Promise<string> => {
        const key = `anchor ${repo} ${tip}`;
        const hit = anchors.get(key);
        if (hit !== undefined) {
            return hit;
        }
        let anchor = base;
        try {
            const merged = (await git(dir, ["merge-base", head, tip])).stdout.trim();
            if (merged !== "") {
                anchor = merged;
            }
        } catch {
            // Unrelated histories: the recorded base is all there is.
        }
        anchors.set(key, anchor);
        return anchor;
    };

    // An absorbed landing is never read again, so its cached spans are dead weight, dropped the moment the mark lands.
    const dropSpans = (repo: string, landedHead: string, tip: string, anchor: string): void => {
        cache.delete(`landed ${repo} ${anchor} ${tip}`);
        cache.delete(`applied ${repo} ${landedHead} ${tip}`);
        expiry.drop(repo, landedHead);
        anchors.delete(`anchor ${repo} ${tip}`);
    };

    return {
        metrics: () => ({
            spans: cache.size,
            anchors: anchors.size,
            unresolvable: unresolvable.size,
            pathCharacters: pathWeight(cache.values()),
        }),
        // Straight off persisted entries (finds archived agents too); an id with no entry left is simply omitted.
        identify: (ids) => {
            const identities: Record<string, OriginAgent> = {};
            for (const id of ids) {
                const entry = agents.entry(id);
                if (entry === undefined) {
                    continue;
                }
                const landed = landedMessageOf(entry);
                identities[id] = {
                    provider: entry.provider,
                    ...(entry.title !== undefined ? { title: entry.title } : {}),
                    // Written at land time from the diff, describing the change, not the ask the title names.
                    ...(landed === undefined ? {} : { landedMessage: landed }),
                };
            }
            return identities;
        },
        forRepo: async (repo, dir, knownHead) => {
            // One entry per agent landed into this repo, newest first, the order the panel shows chips in.
            const landings = agents
                .ids()
                .flatMap((id) => {
                    const composed = agents.entry(id)?.repos.find((candidate) => candidate.repo === repo);
                    if (composed?.landedTip === undefined || composed.landedHead === undefined) {
                        return [];
                    }
                    // Absorbed or unresolvable landings skip all git; a fresh land gets a new, unmarked row.
                    if (composed.absorbed !== undefined || unresolvable.has(landingKey(repo, composed.landedHead, composed.landedTip))) {
                        return [];
                    }
                    return [{ id, base: composed.base, tip: composed.landedTip, head: composed.landedHead, at: composed.landedAt ?? 0 }];
                })
                .toSorted((a, b) => b.at - a.at);
            if (landings.length === 0) {
                return {};
            }
            const head = knownHead ?? (await headSha(dir, git));
            if (head === undefined) {
                return {};
            }
            const origins: Record<string, string[]> = {};
            for (const landing of landings) {
                try {
                    // Own paths narrowed to what this land put in the tree, minus what history has since absorbed.
                    const applied = new Set(await appliedPaths(dir, repo, landing.head, landing.tip));
                    const retired = await expiry.committedSince(dir, repo, landing.head, head);
                    const anchor = await anchorOf(dir, repo, head, landing.tip, landing.base);
                    let total = 0;
                    let claimed = 0;
                    for (const path of await landedPaths(dir, repo, anchor, landing.tip)) {
                        if (!applied.has(path)) {
                            continue;
                        }
                        total += 1;
                        if (retired.has(path)) {
                            continue;
                        }
                        claimed += 1;
                        (origins[path] ??= []).push(landing.id);
                    }
                    // Nothing left to claim: recorded on the entry so no scan re-derives it; cached spans drop too.
                    if (claimed === 0) {
                        dropSpans(repo, landing.head, landing.tip, anchor);
                        void agents
                            .markLandingAbsorbed(landing.id, repo, landing.head, landing.tip, total)
                            .catch((error: unknown) =>
                                logger.debug({ err: error, repo, agent: landing.id }, "agent origins: absorbed mark not persisted"),
                            );
                    }
                } catch (error) {
                    // Unresolvable shas leave the agent unattributed; remembered so the next scan skips it outright.
                    unresolvable.add(landingKey(repo, landing.head, landing.tip));
                    logger.debug({ err: error, repo, agent: landing.id }, "agent origins: delta unresolvable");
                }
            }
            return origins;
        },
    };
};
