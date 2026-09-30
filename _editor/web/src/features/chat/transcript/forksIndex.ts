import type { FleetAgent } from "../../agents/fleet/useAgents-fleet";

// Every fork taken from a conversation, by the cut it was taken at, built once per roster: each turn of an open chat
// asks for its own cut's forks (ChatForkCut), and filtering the whole fleet per turn on every roster frame made a long
// chat's buttons cost the fleet's size times the chat's. A roster is replaced whole on each frame, never mutated, so its
// identity is what the index is kept by.
type Index = ReadonlyMap<string, ReadonlyMap<number, readonly FleetAgent[]>>;
const indexes = new WeakMap<readonly FleetAgent[], Index>();

// The same empty answer every time, so a turn nobody forked from keeps the value it had and redraws nothing.
const NONE: readonly FleetAgent[] = [];

const indexOf = (fleet: readonly FleetAgent[]): Index => {
    const known = indexes.get(fleet);
    if (known !== undefined) {
        return known;
    }
    const index = new Map<string, Map<number, FleetAgent[]>>();
    for (const agent of fleet) {
        const from = agent.forkedFrom;
        if (from === undefined) {
            continue;
        }
        const cuts = index.get(from.conversationId) ?? new Map<number, FleetAgent[]>();
        index.set(from.conversationId, cuts);
        cuts.set(from.index, [...(cuts.get(from.index) ?? []), agent]);
    }
    indexes.set(fleet, index);
    return index;
};

export const forksAt = (fleet: readonly FleetAgent[], conversationId: string, cut: number): readonly FleetAgent[] =>
    indexOf(fleet).get(conversationId)?.get(cut) ?? NONE;
