import type { DesiredStateGraph, ResourceNode } from "@intentic/graph";
import { linearize, refKey } from "@intentic/graph";
import type { ResourceType } from "@intentic/resources";
import { OUTPUTS } from "@intentic/resources";
import { resolveInputs } from "../resolve-inputs.js";
import { createStore, type OutputStore, PENDING } from "../store.js";
import type { EngineConfig, OrphanEntry, PrunedResource, PruneOutcome } from "../types.js";
import { makeContext, requireProvider } from "./reconcile.js";

// A read pass that seeds `store` with each node's live outputs (PENDING for a not-yet-created node), mirroring
// plan.ts's seeding. Skips ids already seeded.
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

// Tears down resources in `previous` absent from `current`, in reverse dependency order, using each node's
// previous inputs. The store seeds from both graphs: a removed node may reference a kept node or another removed
// one.
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
        // The protect convention: a node carrying a literal `protect: true` input is never pruned.
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

// The collection-oriented prune: tear down every discovered orphan using each ListedResource's own inputs. Skips
// a `delete`-less or intentic.protect orphan; orphans have no dependency edges, so they delete in discovery
// order.
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
