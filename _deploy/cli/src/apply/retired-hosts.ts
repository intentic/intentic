import { errorMessage } from "@intentic/base/errors";
import { createStore, type Orphan, type OrphanEntry, type PruneOutcome, type Providers, resolveInputs } from "@intentic/engine";
import { ownershipOf } from "@intentic/graph";
import { hostTarget, listHostStamps, type SshExecutor, type SshTarget } from "@intentic/providers";
import type { RetiredHost } from "./baseline.js";

// A host migration moves a host node to a new address; the graph then only ever reaches the new machine, so the old
// one would go unscanned forever. Each retired host is listed on its own, strictly (a failure is "could not look", not
// "clean"), and what it still runs is split by owner like any orphan scan: this intent's own containers are leftovers to
// delete, unowned ones are reported, another intent's are none of ours.
export interface RetiredScan {
    readonly host: RetiredHost;
    // Set when the host could not be listed: it stays retired, to be scanned again next run.
    readonly error?: string;
    readonly leftovers: readonly OrphanEntry[];
    readonly unowned: readonly Orphan[];
}

export const retiredTarget = (host: RetiredHost, env: Readonly<Record<string, string | undefined>>): SshTarget | string => {
    const missing = new Set<string>();
    const inputs = resolveInputs(host.node.inputs, createStore(), env, { lenient: false, missingSecrets: missing });
    if (missing.size > 0) {
        return `reaching it needs ${[...missing].toSorted().join(", ")}, which is not set`;
    }
    return hostTarget(inputs);
};

export const scanRetiredHosts = async (
    hosts: readonly RetiredHost[],
    args: {
        readonly ssh: SshExecutor;
        readonly env: Readonly<Record<string, string | undefined>>;
        readonly owner: string | undefined;
        readonly providers: Providers;
    },
): Promise<RetiredScan[]> => {
    const scans: RetiredScan[] = [];
    for (const host of hosts) {
        const target = retiredTarget(host, args.env);
        if (typeof target === "string") {
            scans.push({ host, error: target, leftovers: [], unowned: [] });
            continue;
        }
        let rows;
        try {
            rows = await listHostStamps(args.ssh, target);
        } catch (error) {
            scans.push({ host, error: errorMessage(error), leftovers: [], unowned: [] });
            continue;
        }
        // `delete` parses the host's SSH block out of these inputs, so a leftover is torn down on the old machine.
        const inputs = resolveInputs(host.node.inputs, createStore(), args.env, { lenient: false });
        const leftovers: OrphanEntry[] = [];
        const unowned: Orphan[] = [];
        for (const row of rows) {
            const ownership = ownershipOf(row.owner, args.owner);
            const type = row.type as OrphanEntry["type"];
            if (ownership === "unowned") {
                unowned.push({ id: row.id, type });
            } else if (ownership === "mine" && args.providers[type] !== undefined) {
                leftovers.push({ id: row.id, type, inputs, ...(row.protected ? { protected: true } : {}) });
            }
        }
        scans.push({ host, leftovers, unowned });
    }
    return scans;
};

// A retired host is confirmed clean when it could be listed and nothing of this intent's, nor anything unowned, is
// left on it once prune ran: every leftover deleted. A protected leftover, or an unowned container a person has not
// removed yet, keeps it retired and reported. Pass the prune of these leftovers alone (an id can repeat across hosts),
// or no outcome when prune did not run (deletions awaiting `--yes`).
export const stillRetired = (scans: readonly RetiredScan[], pruned: PruneOutcome | undefined): RetiredHost[] => {
    const deleted = new Set((pruned?.deleted ?? []).map((resource) => `${resource.type}\0${resource.id}`));
    return scans
        .filter(
            (scan) =>
                scan.error !== undefined ||
                scan.unowned.length > 0 ||
                scan.leftovers.some((leftover) => !deleted.has(`${leftover.type}\0${leftover.id}`)),
        )
        .map((scan) => scan.host);
};
