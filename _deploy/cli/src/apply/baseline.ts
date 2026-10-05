import { readFile, writeFile } from "node:fs/promises";
import { errorMessage } from "@intentic/base/errors";
import type { OrphanScan } from "@intentic/engine";
import type { DesiredStateGraph, ResourceNode } from "@intentic/graph";
import { z } from "zod";

// The prune baseline: what the last apply left live, which the next apply diffs against to find what to delete. It is
// the last applied graph plus two sections nothing else remembers (2026-10-05):
// - pendingDeletion: nodes removed from the intent whose deletion is not confirmed yet (it waits for `--yes`, or its
//   delete failed for want of a secret). Kept until a delete succeeds, so a kind with no `list` (a repo, a Komodo
//   deployment, a tunnel, a database binding) never drops off unnoticed.
// - retiredHosts: machines a host migration moved away from, scanned for this intent's leftovers until one is clean.
// Its shape stays a superset of the artifact's, so a CLI from before these sections still reads the graph out of it.

// A machine a host migration moved away from, with the old host node (its SSH block) to reach it.
export interface RetiredHost {
    readonly id: string;
    readonly address: string;
    readonly node: ResourceNode;
    // ISO date of the migration that retired it.
    readonly since: string;
}

export interface Baseline {
    readonly version: 1;
    readonly owner?: string;
    // The last applied graph.
    readonly resources: Readonly<Record<string, ResourceNode>>;
    readonly pendingDeletion?: Readonly<Record<string, ResourceNode>>;
    readonly retiredHosts?: readonly RetiredHost[];
}

const nodeSchema = z.looseObject({
    id: z.string(),
    type: z.string(),
    inputs: z.record(z.string(), z.unknown()),
    dependsOn: z.array(z.string()),
});

const baselineSchema = z.looseObject({
    version: z.literal(1),
    owner: z.string().optional(),
    resources: z.record(z.string(), nodeSchema),
    pendingDeletion: z.record(z.string(), nodeSchema).optional(),
    retiredHosts: z.array(z.object({ id: z.string(), address: z.string(), node: nodeSchema, since: z.string() })).optional(),
});

// Reads a baseline: undefined only when the file does not exist. Anything else that stops it being read (permissions,
// invalid JSON, the wrong shape) throws, since an unreadable baseline is not "no baseline": treating it as one would
// silently forget everything it tracked. A plain artifact (a legacy baseline, or the intentic-applied tag's) reads too.
export const readBaseline = async (path: string): Promise<Baseline | undefined> => {
    let raw: string;
    try {
        raw = await readFile(path, "utf8");
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return undefined;
        }
        throw new Error(`cannot read the prune baseline at ${path}: ${errorMessage(error)}`, { cause: error });
    }
    let json: unknown;
    try {
        json = JSON.parse(raw);
    } catch (error) {
        throw new Error(`the prune baseline at ${path} is not valid JSON: ${errorMessage(error)}`, { cause: error });
    }
    const parsed = baselineSchema.safeParse(json);
    if (!parsed.success) {
        throw new Error(`the prune baseline at ${path} is not a baseline: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`);
    }
    return parsed.data as unknown as Baseline;
};

export const writeBaseline = async (path: string, baseline: Baseline): Promise<void> =>
    writeFile(path, `${JSON.stringify(baseline, undefined, 4)}\n`);

// The graph prune walks: the last applied graph plus everything still pending deletion. An edge to a node the result
// no longer holds is dropped (a pending node can outlive what it depended on), or ordering would read it as a cycle.
export const pruneBase = (baseline: Baseline): DesiredStateGraph => {
    const all: Record<string, ResourceNode> = { ...baseline.pendingDeletion, ...baseline.resources };
    return {
        version: 1,
        ...(baseline.owner !== undefined ? { owner: baseline.owner } : {}),
        resources: Object.fromEntries(
            Object.entries(all).map(([id, node]) => [id, { ...node, dependsOn: node.dependsOn.filter((dep) => all[dep] !== undefined) }]),
        ),
    };
};

// What the current graph no longer declares, in the prune base's order.
export const removedNodes = (base: DesiredStateGraph, current: DesiredStateGraph): ResourceNode[] =>
    Object.values(base.resources).filter((node) => current.resources[node.id] === undefined);

// Retired hosts still to be confirmed clean: the baseline's plus this run's migrations, one per (id, address), minus any
// whose address a current host uses again (the current graph scans and owns it then).
export const mergeRetiredHosts = (kept: readonly RetiredHost[], added: readonly RetiredHost[], current: DesiredStateGraph): RetiredHost[] => {
    const inUse = new Set(
        Object.values(current.resources)
            .filter((node) => node.type === "host")
            .map((node) => node.inputs["address"]),
    );
    const byKey = new Map<string, RetiredHost>();
    for (const host of [...kept, ...added]) {
        if (!inUse.has(host.address) && !byKey.has(`${host.id}@${host.address}`)) {
            byKey.set(`${host.id}@${host.address}`, host);
        }
    }
    return [...byKey.values()];
};

// The baseline a run leaves: the graph it applied, what is still pending deletion, and the retired hosts not yet clean.
export const nextBaseline = (args: {
    readonly graph: DesiredStateGraph;
    readonly owner: string | undefined;
    readonly pending: readonly ResourceNode[];
    readonly retiredHosts: readonly RetiredHost[];
}): Baseline => ({
    version: 1,
    ...(args.owner !== undefined ? { owner: args.owner } : {}),
    resources: args.graph.resources,
    ...(args.pending.length > 0 ? { pendingDeletion: Object.fromEntries(args.pending.map((node) => [node.id, node])) } : {}),
    ...(args.retiredHosts.length > 0 ? { retiredHosts: args.retiredHosts } : {}),
});

// The baseline a run starts from, or none. An explicit `--previous` that is missing, and any baseline that cannot be
// read, stop the run before it changes anything: going on would forget what that baseline tracked. `--first-apply`
// overrides both, for a person who knows there is nothing to forget (or accepts cleaning up by hand). A missing default
// file is left to the caller, which can tell a first apply from a lost baseline by what is live.
export const loadBaseline = async (
    path: string,
    options: { readonly explicit: boolean; readonly firstApply: boolean; readonly note: (line: string) => void },
): Promise<Baseline | undefined> => {
    let baseline: Baseline | undefined;
    try {
        baseline = await readBaseline(path);
    } catch (error) {
        if (!options.firstApply) {
            throw new Error(
                `${errorMessage(error)}. Nothing was applied or pruned: restore the file, or re-run with --first-apply to start a new baseline (whatever the old one tracked must then be removed by hand).`,
                { cause: error },
            );
        }
        options.note(`--first-apply: ignoring the unreadable prune baseline (${errorMessage(error)}); this run starts a new one.`);
        return undefined;
    }
    if (baseline === undefined && options.explicit && !options.firstApply) {
        throw new Error(
            `no prune baseline at ${path} (given with --previous). Nothing was applied or pruned: pass the right file, or --first-apply to start a new baseline.`,
        );
    }
    if (baseline !== undefined && options.firstApply) {
        options.note(`--first-apply ignored: the prune baseline at ${path} is readable, and this run prunes against it.`);
    }
    return baseline;
};

// No baseline file at the default path: a first apply, or a lost baseline (a fresh clone, a deleted file, a CI run
// without its tag). The file cannot say which, so ask the live infrastructure: anything already stamped with this
// intent's owner proves an earlier apply, and then going on would silently forget whatever that apply's baseline still
// meant to delete. Returns the line to print for a first apply; throws for a lost baseline or a scan that could not
// look everywhere. `--first-apply` skips the question.
export const checkFirstApply = async (args: {
    readonly path: string;
    readonly owner: string | undefined;
    readonly firstApply: boolean;
    readonly scan: () => Promise<OrphanScan>;
}): Promise<string> => {
    const start = "nothing will be pruned, and the baseline is written as this run goes";
    if (args.firstApply) {
        return `first apply (--first-apply): no prune baseline at ${args.path}; ${start}.`;
    }
    if (args.owner === undefined) {
        return `first apply: no prune baseline at ${args.path}, and no owner id to check that by (re-run \`intentic deploy resolve\` to stamp one); ${start}.`;
    }
    const scan = await args.scan();
    if (scan.owned > 0) {
        throw new Error(
            `no prune baseline at ${args.path}, yet ${scan.owned} live resource(s) carry this intent's owner stamp (${args.owner}): it was applied before and its baseline is lost. Nothing was applied or pruned. Restore the baseline (in CI, the intentic-applied tag), or re-run with --first-apply to start a new one; resources the lost baseline was still to delete must then be removed by hand.`,
        );
    }
    if (scan.skipped.length > 0) {
        const where = scan.skipped.map((skip) => `${skip.source} (${skip.reason})`).join(", ");
        throw new Error(
            `no prune baseline at ${args.path}, and whether this intent was applied before cannot be told: the scan could not read ${where}. Nothing was applied or pruned. Re-run once it is reachable, or with --first-apply.`,
        );
    }
    return `first apply: no prune baseline at ${args.path} and nothing live carries this intent's owner stamp; ${start}.`;
};
