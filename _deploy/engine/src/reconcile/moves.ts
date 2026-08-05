import type { DesiredStateGraph, Move, ResourceNode } from "@intentic/graph";
import type { ResourceType } from "@intentic/resources";
import { resolveInputs } from "../resolve-inputs.js";
import { createStore } from "../store.js";
import type { EngineConfig } from "../types.js";
import { makeContext, requireProvider } from "./reconcile.js";

// Consume the graph's `moved` renames BEFORE reconcile: for each {from,to}, re-stamp the live resource from the
// old id to the new one so the subsequent reconcile sees it as already-owned-and-current (a noop) instead of
// orphaning the old id and creating the new one from scratch — which for a stateful resource destroys data.
// Returns the moves that were actually applied in place (a type without `restamp` is logged and skipped, so its
// rename degrades to prune-old + create-new). Inputs are resolved leniently: the new node's refs to other
// nodes' not-yet-produced outputs are absent, but restamp needs only the resource's own coordinates (its SSH
// block), which resolve from secrets/literals.
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
            throw new Error(`moved: source "${move.from}" still exists in the desired state — a rename must remove the old id`);
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
            log(`moved: ${type} cannot rename in place — "${move.from}" → "${move.to}" will be recreated (its data is NOT preserved)`);
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

// Rewrite a previous (last-applied) graph so each applied move's `from` id becomes its `to` id. Used to fix the
// PRUNE baseline after a rename: prune deletes ids present in the previous graph but absent from the new one, so
// without this it would delete the resource we just re-stamped. Renames the resource key, its `id` field, and
// any `dependsOn` edges that pointed at a moved id. Only applied moves are passed in — a rename that fell back
// to recreate keeps its old id in the baseline so prune correctly tears the old resource down.
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
