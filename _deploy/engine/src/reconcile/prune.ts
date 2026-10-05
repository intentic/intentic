import type { DesiredStateGraph, ResourceNode } from "@intentic/graph";
import { linearize, refKey } from "@intentic/graph";
import type { ResourceType } from "@intentic/resources";
import { OUTPUTS } from "@intentic/resources";
import { errorMessage } from "@intentic/base/errors";
import { resolveInputs } from "../resolve-inputs.js";
import { createStore, type OutputStore, PENDING } from "../store.js";
import type { EngineConfig, OrphanEntry, PrunedResource, PruneOutcome, SkippedResource } from "../types.js";
import { checkSignal, makeContext, requireProvider, type RunScope, runScope } from "./reconcile.js";

const seedPending = (node: ResourceNode, store: OutputStore): void => {
    for (const name of OUTPUTS[node.type as ResourceType]) {
        store.set(refKey(node.id, name), PENDING);
    }
};

// A read pass that seeds `store` with each node's live outputs (PENDING for a not-yet-created node), mirroring
// plan.ts's seeding. Skips ids already seeded. A removed node may reference secrets the current graph no longer
// needs: they resolve to MISSING_SECRET, and a read that fails on one seeds PENDING instead of failing the prune.
const seedOutputs = async (nodes: readonly ResourceNode[], config: EngineConfig, scope: RunScope, store: OutputStore): Promise<void> => {
    for (const node of nodes) {
        if (store.has(node.id)) {
            continue;
        }
        const type = node.type as ResourceType;
        const provider = requireProvider(config.providers, type, node.id);
        const ctx = makeContext(node.id, store, scope);
        const missing = new Set<string>();
        const inputs = resolveInputs(node.inputs, store, scope.env, { lenient: true, missingSecrets: missing });
        let observed;
        try {
            observed = await provider.read(inputs, ctx);
        } catch (error) {
            if (missing.size === 0) {
                throw error;
            }
            scope.log(`prune: could not read ${node.id} without ${[...missing].join(", ")}, treating its outputs as unknown: ${errorMessage(error)}`);
            observed = undefined;
        }
        store.set(node.id, node.id);
        if (observed === undefined) {
            seedPending(node, store);
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

// Prune removed resources in reverse dependency order using their previous inputs. Deletion needs only what
// identifies a resource and reaches its platform, so a secret only its creation used (a user's own password, gone from
// the env with the node) does not stop it: it resolves to MISSING_SECRET, and only if the delete then fails is the
// node left in place as "missing-secret", for the caller to keep pending until the secret is back.
export const prune = async (previous: DesiredStateGraph, current: DesiredStateGraph, config: EngineConfig): Promise<PruneOutcome> => {
    const scope = runScope(config);
    const emit = config.onEvent ?? (() => {});
    const kept = new Set(Object.keys(current.resources));
    const removed = new Set(Object.keys(previous.resources).filter((id) => !kept.has(id)));
    if (removed.size === 0) {
        return { deleted: [], skipped: [] };
    }

    const store = createStore();
    await seedOutputs([...inOrder(current), ...inOrder(previous)], config, scope, store);

    const deleted: PrunedResource[] = [];
    const skipped: SkippedResource[] = [];
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
            skipped.push({ id, type, reason: "protected" });
            continue;
        }
        if (provider.delete === undefined) {
            emit({ kind: "prune", state: "skipped", id, type, reason: "no-delete" });
            skipped.push({ id, type, reason: "no-delete" });
            continue;
        }
        checkSignal(config);
        const ctx = makeContext(id, store, scope);
        const missing = new Set<string>();
        const inputs = resolveInputs(node.inputs, store, scope.env, { lenient: true, missingSecrets: missing });
        try {
            await provider.delete(inputs, ctx);
        } catch (error) {
            if (missing.size === 0) {
                throw error;
            }
            const keys = [...missing].toSorted();
            scope.log(`prune: could not delete ${id} without ${keys.join(", ")} (set it to retry): ${errorMessage(error)}`);
            emit({ kind: "prune", state: "skipped", id, type, reason: "missing-secret" });
            skipped.push({ id, type, reason: "missing-secret", missing: keys });
            continue;
        }
        emit({ kind: "prune", state: "deleted", id, type });
        deleted.push({ id, type });
    }
    return { deleted, skipped };
};

// The collection-oriented prune: tear down every discovered orphan using each ListedResource's own inputs. Skips
// a `delete`-less or intentic.protect orphan; orphans have no dependency edges, so they delete in discovery
// order.
export const pruneOrphans = async (orphans: readonly OrphanEntry[], config: EngineConfig): Promise<PruneOutcome> => {
    const scope = runScope(config);
    const emit = config.onEvent ?? (() => {});
    const deleted: PrunedResource[] = [];
    const skipped: SkippedResource[] = [];
    for (const orphan of orphans) {
        const provider = requireProvider(config.providers, orphan.type, orphan.id);
        if (orphan.protected === true) {
            emit({ kind: "prune", state: "skipped", id: orphan.id, type: orphan.type, reason: "protected" });
            skipped.push({ id: orphan.id, type: orphan.type, reason: "protected" });
            continue;
        }
        if (provider.delete === undefined) {
            emit({ kind: "prune", state: "skipped", id: orphan.id, type: orphan.type, reason: "no-delete" });
            skipped.push({ id: orphan.id, type: orphan.type, reason: "no-delete" });
            continue;
        }
        checkSignal(config);
        const ctx = makeContext(orphan.id, createStore(), scope);
        await provider.delete(orphan.inputs, ctx);
        emit({ kind: "prune", state: "deleted", id: orphan.id, type: orphan.type });
        deleted.push({ id: orphan.id, type: orphan.type });
    }
    return { deleted, skipped };
};
