import type { DesiredStateGraph, Ownership } from "@intentic/graph";
import { ownershipOf } from "@intentic/graph";
import type { ResourceType } from "@intentic/resources";
import type { ListedResource, ScanSource } from "../provider.js";
import { resolveInputs } from "../resolve-inputs.js";
import { createStore } from "../store.js";
import type { EngineConfig, Orphan, OrphanEntry, OrphanScan, ScanSkip } from "../types.js";
import { makeContext, runScope } from "./reconcile.js";

// Where one listed resource stands: part of the graph, or outside it with rule 6's ownership answer. Only "mine" may be
// pruned; "unowned" is reported; "theirs" belongs to another intent sharing the host or zone.
export type ListedVerdict = "declared" | Exclude<Ownership, "mine"> | "orphan";

export const classifyListed = (listed: ListedResource, declared: ReadonlySet<string>, owner: string | undefined): ListedVerdict => {
    const ownership = ownershipOf(listed.owner, owner);
    if (ownership === "theirs") {
        return "theirs";
    }
    if (declared.has(listed.id)) {
        return "declared";
    }
    return ownership === "mine" ? "orphan" : "unowned";
};

// Enumerate live stamped resources (via each provider's `list`) and sort the ones the desired graph lacks by owner.
// Providers without `list` are skipped. Runs once per command, not per reconcile iteration, a scan opens real
// connections. Scan sources are the graph's nodes with leniently-resolved inputs over an EMPTY store: refs resolve to
// PENDING, which is fine because `list` implementations only parse the ref-free inventory sources (host, cloudflare).
// Each orphan carries the inputs its provider's `delete` needs, they hold connection secrets, so entries are for
// engine/CLI plumbing, never serialization.
export const collectOrphans = async (graph: DesiredStateGraph, config: EngineConfig): Promise<OrphanScan> => {
    const scope = runScope(config);
    const emit = config.onEvent ?? (() => {});
    const store = createStore();
    const sources: ScanSource[] = Object.values(graph.resources).map((node) => ({
        id: node.id,
        type: node.type as ResourceType,
        inputs: resolveInputs(node.inputs, store, scope.env, { lenient: true }),
    }));
    const skips = new Map<string, ScanSkip>();
    const ctx = {
        ...makeContext("", store, scope),
        skipped: (source: string, reason: string) => {
            skips.set(`${source}\0${reason}`, { source, reason });
        },
    };
    const declared = new Set(Object.keys(graph.resources));
    const orphans: OrphanEntry[] = [];
    const unowned: Orphan[] = [];
    let foreign = 0;
    let owned = 0;
    for (const [type, provider] of Object.entries(config.providers)) {
        if (provider?.list === undefined) {
            continue;
        }
        // The scan is the longest silent stretch of a plan (one live connection per list-bearing provider),
        // narrate it so a consumer can show which provider is being scanned instead of a blank spinner.
        scope.log(`orphan scan: ${type}`);
        for (const listed of await provider.list(sources, ctx)) {
            if (ownershipOf(listed.owner, scope.owner) === "mine") {
                owned += 1;
            }
            const verdict = classifyListed(listed, declared, scope.owner);
            const kind = type as ResourceType;
            if (verdict === "orphan") {
                emit({ kind: "orphan", id: listed.id, type: kind, ownership: "mine" });
                orphans.push({ id: listed.id, type: kind, inputs: listed.inputs, ...(listed.protected === true ? { protected: true } : {}) });
            } else if (verdict === "unowned") {
                emit({ kind: "orphan", id: listed.id, type: kind, ownership: "unowned" });
                unowned.push({ id: listed.id, type: kind });
            } else if (verdict === "theirs") {
                foreign += 1;
            }
        }
    }
    return { orphans, unowned, foreign, owned, skipped: [...skips.values()] };
};
