import type { DesiredStateGraph, Move, ResourceNode } from "@intentic/graph";
import type { ResourceType } from "@intentic/resources";
import { resolveInputs } from "../resolve-inputs.js";
import { createStore } from "../store.js";
import type { EngineConfig } from "../types.js";
import { makeContext, requireProvider } from "./reconcile.js";

// Consume the graph's `moved` renames before reconcile: re-stamp each live resource from its old id to the new
// one so reconcile sees it as already-owned-and-current instead of orphaning it and recreating from scratch.
// Returns the moves actually applied (a type without `restamp` is logged and skipped). Inputs are resolved
// leniently since a renamed node's refs to not-yet-produced outputs may be absent.
export const applyMoves = async (graph: DesiredStateGraph, config: EngineConfig): Promise<Move[]> => {
    const moves = graph.moved ?? [];
    if (moves.length === 0) {
        return [];
    }
    const env = config.env ?? process.env;
    const log = config.log ?? console.log;
    const store = createStore();
    const applied: Move[] = [];
    for (const move of moves) {
        if (move.from === move.to) {
            throw new Error(`moved: "from" and "to" are the same id "${move.from}"`);
        }
        if (graph.resources[move.from] !== undefined) {
            throw new Error(`moved: source "${move.from}" still exists in the desired state, a rename must remove the old id`);
        }
        const node = graph.resources[move.to];
        if (node === undefined) {
            throw new Error(
                `moved: target "${move.to}" is not in the desired state (rename the resource AND keep the moved entry pointing at the new id)`,
            );
        }
        const type = node.type as ResourceType;
        const provider = requireProvider(config.providers, type, move.to);
        if (provider.restamp === undefined) {
            log(`moved: ${type} cannot rename in place, "${move.from}" → "${move.to}" will be recreated (its data is NOT preserved)`);
            continue;
        }
        const ctx = makeContext(move.to, store, env, log);
        const inputs = resolveInputs(node.inputs, store, env, { lenient: true });
        await provider.restamp(move.from, inputs, ctx);
        log(`moved: re-stamped ${type} "${move.from}" → "${move.to}" in place`);
        applied.push(move);
    }
    return applied;
};

// Rewrite a previous (last-applied) graph so each applied move's `from` id becomes its `to` id, fixing the prune
// baseline after a rename. Renames the resource key, its `id` field, and any `dependsOn` edges pointing at a
// moved id.
export const rewriteGraphForMoves = (previous: DesiredStateGraph, moves: readonly Move[]): DesiredStateGraph => {
    if (moves.length === 0) {
        return previous;
    }
    const rename = new Map(moves.map((move) => [move.from, move.to]));
    const resources: Record<string, ResourceNode> = {};
    for (const [id, node] of Object.entries(previous.resources)) {
        const newId = rename.get(id) ?? id;
        resources[newId] = { ...node, id: newId, dependsOn: node.dependsOn.map((dep) => rename.get(dep) ?? dep) };
    }
    return { version: 1, resources };
};
