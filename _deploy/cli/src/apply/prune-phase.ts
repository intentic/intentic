import { collectOrphans, type EngineConfig, type OrphanScan, type PruneOutcome, prune, pruneOrphans } from "@intentic/engine";
import type { DesiredStateGraph } from "@intentic/graph";
import type { Named } from "../lib/tables.js";
import { type Baseline, nextBaseline, removedNodes } from "./baseline.js";
import { type RetiredScan, stillRetired } from "./retired-hosts.js";

// What apply deletes after converging, and the baseline it leaves. Three sources feed the deletions: nodes the baseline
// holds that the graph dropped, this intent's own orphans the scan found, and this intent's leftovers on retired hosts.
// Without `--yes` none is deleted, yet the baseline still advances to the applied graph and keeps every removed node
// pending, so a later `--yes` prunes what this run listed and creations/updates are not held hostage meanwhile.
export interface PrunePhase {
    readonly scan: OrphanScan;
    // What waits for `--yes`; empty when prune ran.
    readonly pending: readonly Named[];
    readonly pruned: PruneOutcome;
    readonly baseline: Baseline;
}

const EMPTY: PruneOutcome = { deleted: [], skipped: [] };

const merge = (...outcomes: readonly PruneOutcome[]): PruneOutcome => ({
    deleted: outcomes.flatMap((outcome) => outcome.deleted),
    skipped: outcomes.flatMap((outcome) => outcome.skipped),
});

export const runPrunePhase = async (args: {
    readonly graph: DesiredStateGraph;
    // The baseline's graph plus its pending deletions (pruneBase), renames applied; undefined on a first apply.
    readonly base: DesiredStateGraph | undefined;
    readonly owner: string | undefined;
    readonly retired: readonly RetiredScan[];
    readonly yes: boolean;
    readonly config: EngineConfig;
    // Runs once before the first deletion: renew and verify the apply lock.
    readonly beforeDelete?: () => Promise<void>;
}): Promise<PrunePhase> => {
    const { graph, base, owner, retired, config } = args;
    const removed = base === undefined ? [] : removedNodes(base, graph);
    const scan = await collectOrphans(graph, config);
    const leftovers = retired.flatMap((host) => host.leftovers);
    // Protected resources are excluded from confirmation; they show up as skipped once prune actually runs.
    const deletions: Named[] = [
        ...removed.filter((node) => node.inputs["protect"] !== true),
        ...scan.orphans.filter((orphan) => orphan.protected !== true),
        ...leftovers.filter((leftover) => leftover.protected !== true),
    ].map(({ id, type }) => ({ id, type }));

    if (deletions.length > 0 && !args.yes) {
        return {
            scan,
            pending: deletions,
            pruned: EMPTY,
            baseline: nextBaseline({ graph, owner, pending: removed, retiredHosts: stillRetired(retired, undefined) }),
        };
    }
    if (deletions.length > 0) {
        await args.beforeDelete?.();
    }
    const fromBase = base === undefined ? EMPTY : await prune(base, graph, config);
    const fromScan = await pruneOrphans(scan.orphans, config);
    const fromRetired = await pruneOrphans(leftovers, config);
    // Only a delete that failed for want of a secret stays pending: protected and delete-less nodes are left in place on
    // purpose and reported, and a delete that failed otherwise has already failed the run, leaving the earlier baseline.
    const retry = new Set(fromBase.skipped.filter((skip) => skip.reason === "missing-secret").map((skip) => skip.id));
    return {
        scan,
        pending: [],
        pruned: merge(fromBase, fromScan, fromRetired),
        baseline: nextBaseline({
            graph,
            owner,
            pending: removed.filter((node) => retry.has(node.id)),
            retiredHosts: stillRetired(retired, fromRetired),
        }),
    };
};
