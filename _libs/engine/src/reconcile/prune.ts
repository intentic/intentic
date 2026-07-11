import type { DesiredStateGraph, ResourceNode } from "@intentic/graph";
import { linearize, refKey } from "@intentic/graph";
import type { ResourceType } from "@intentic/resources";
import { OUTPUTS } from "@intentic/resources";
import { resolveInputs } from "../resolve-inputs.js";
import { createStore, type OutputStore, PENDING } from "../store.js";
import type { EngineConfig, OrphanEntry, PrunedResource, PruneOutcome } from "../types.js";
import { makeContext, requireProvider } from "./reconcile.js";

// A read pass that seeds `store` with each node's live outputs (PENDING for any not-yet-created node),
// mirroring plan.ts's seeding. Skips ids already seeded, so it can layer the previous graph's removed
// nodes over the current graph's kept ones.
const seedOutputs = async (nodes: readonly ResourceNode[], config: EngineConfig, store: OutputStore): Promise<void> => {
    const env = config.env ?? process.env;
    const log = config.log ?? console.log;
    for (const node of nodes) {
        if (store.has(node.id)) {
            continue;
        }
        const type = node.type as ResourceType;
        const provider = requireProvider(config.providers, type, node.id);
        const ctx = makeContext(node.id, store, env, log);
        const inputs = resolveInputs(node.inputs, store, env, { lenient: true });
        const observed = await provider.read(inputs, ctx);
        store.set(node.id, node.id);
        if (observed === undefined) {
            for (const name of OUTPUTS[type]) {
                store.set(refKey(node.id, name), PENDING);
            }
            continue;
        }
        for (const [name, value] of Object.entries(observed.outputs)) {
            if (OUTPUTS[type].includes(name)) {
                store.set(refKey(node.id, name), value);
            }
        }
    }
};

const inOrder = (graph: DesiredStateGraph): ResourceNode[] =>
    linearize(graph)
        .map((id) => graph.resources[id])
        .filter((node): node is ResourceNode => node !== undefined);

// Converge by deletion: tear down every resource present in the last successfully-applied (`previous`) graph
// but absent from the new (`current`) one. Deletes run in REVERSE dependency order (dependents before their
// dependencies) using each removed node's PREVIOUS resolved inputs. A removed type whose provider has no
// `delete` is left in place and logged (converge-forward, like orphan reporting). Idempotent: a provider's
// `delete` may find the resource already gone.
//
// The store is seeded by reading the kept graph AND the removed nodes (still live at this point): a removed
// node's inputs may reference kept platform nodes (cloudflare.zoneId, komodo.internalUrl, ...) or OTHER
// removed nodes (deleting a whole stack — or everything, when `current` is empty). Reverse dependency order
// guarantees a delete's referenced dependencies are still alive when it runs.
export const prune = async (previous: DesiredStateGraph, current: DesiredStateGraph, config: EngineConfig): Promise<PruneOutcome> => {
    const env = config.env ?? process.env;
    const log = config.log ?? console.log;
    const emit = config.onEvent ?? (() => {});
    const kept = new Set(Object.keys(current.resources));
    const removed = new Set(Object.keys(previous.resources).filter((id) => !kept.has(id)));
    if (removed.size === 0) {
        return { deleted: [], skipped: [] };
    }

    const store = createStore();
    await seedOutputs([...inOrder(current), ...inOrder(previous)], config, store);

    const deleted: PrunedResource[] = [];
    const skipped: PrunedResource[] = [];
    for (const id of [...linearize(previous)].toReversed()) {
        if (!removed.has(id)) {
            continue;
        }
        const node = previous.resources[id];
        if (node === undefined) {
            continue;
        }
        const type = node.type as ResourceType;
        const provider = requireProvider(config.providers, type, id);
        // The protect convention: a node carrying a literal `protect: true` input is never pruned — the
        // author must flip it off (a reviewed config change) before removal deletes the data it guards.
        if (node.inputs["protect"] === true) {
            emit({ kind: "prune", state: "skipped", id, type, reason: "protected" });
            skipped.push({ id, type });
            continue;
        }
        if (provider.delete === undefined) {
            emit({ kind: "prune", state: "skipped", id, type, reason: "no-delete" });
            skipped.push({ id, type });
            continue;
        }
        const ctx = makeContext(id, store, env, log);
        const inputs = resolveInputs(node.inputs, store, env, { lenient: true });
        await provider.delete(inputs, ctx);
        emit({ kind: "prune", state: "deleted", id, type });
        deleted.push({ id, type });
    }
    return { deleted, skipped };
};

// The collection-oriented prune: tear down every discovered orphan (collectOrphans entries — live stamped
// resources absent from the desired graph) using each ListedResource's own inputs — no last-applied
// baseline needed. Takes the entries rather than re-scanning, so a caller can preview them (a --yes gate)
// and then delete exactly what it showed. An orphan whose provider has no `delete`, or one carrying the
// intentic.protect stamp, is left in place. Orphans have no dependency edges (they are outside every
// graph), so they delete in discovery order.
export const pruneOrphans = async (orphans: readonly OrphanEntry[], config: EngineConfig): Promise<PruneOutcome> => {
    const env = config.env ?? process.env;
    const log = config.log ?? console.log;
    const emit = config.onEvent ?? (() => {});
    const deleted: PrunedResource[] = [];
    const skipped: PrunedResource[] = [];
    for (const orphan of orphans) {
        const provider = requireProvider(config.providers, orphan.type, orphan.id);
        if (orphan.protected === true) {
            emit({ kind: "prune", state: "skipped", id: orphan.id, type: orphan.type, reason: "protected" });
            skipped.push({ id: orphan.id, type: orphan.type });
            continue;
        }
        if (provider.delete === undefined) {
            emit({ kind: "prune", state: "skipped", id: orphan.id, type: orphan.type, reason: "no-delete" });
            skipped.push({ id: orphan.id, type: orphan.type });
            continue;
        }
        const ctx = makeContext(orphan.id, createStore(), env, log);
        await provider.delete(orphan.inputs, ctx);
        emit({ kind: "prune", state: "deleted", id: orphan.id, type: orphan.type });
        deleted.push({ id: orphan.id, type: orphan.type });
    }
    return { deleted, skipped };
};
