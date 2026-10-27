import { ref, shallowRef } from "vue";
import { type FleetLane, NO_ATTENTION } from "../../../../../models/agent-status/agentStatus-lanes";
import type { ActivePhase } from "../../../../../models/fleet/board/activePhase";
import type { FleetAgent } from "../../../../../models/fleet/useAgents-fleet";
import { readFolds, useLaneGroups } from "../laneGroups";

// Pins how the Active lane is drawn once it holds more than one kind of conversation: a head per group, a fold the
// reader keeps, never a fold under a query, the ringed card kept in sight under a fold, and a Shift+click range that
// walks only what is drawn.

const card = (id: string, over: Partial<FleetAgent> = {}): FleetAgent => ({
    id,
    title: `agent ${id}`,
    status: `running`,
    startedAt: 1,
    provider: `claude`,
    harness: `native`,
    updatedAt: 1,
    attention: NO_ATTENTION,
    open: false,
    unread: false,
    unsent: false,
    ...over,
});
const booked = (id: string, at: number): FleetAgent => card(id, { status: `idle`, next: { kind: `send`, at, count: 1 } });
const draft = (id: string): FleetAgent => card(id, { status: `draft`, updatedAt: 0 });

const boardOf = (lanes: Partial<Record<FleetLane, FleetAgent[]>>, folded: ActivePhase[] = []) => {
    const filtering = ref(false);
    const selected = ref<string | undefined>(undefined);
    const folds = shallowRef<ReadonlySet<ActivePhase>>(new Set(folded));
    const groups = useLaneGroups({ cardsFor: (lane) => lanes[lane] ?? [], filtering, selected, folds, trayFor: () => undefined });
    return { ...groups, filtering, selected };
};
const ids = (agents: readonly FleetAgent[]): string[] => agents.map((agent) => agent.id);

describe(`the Active lane's groups`, () => {
    it(`heads each kind once the lane holds more than one, drawing all but work in flight as rows`, () => {
        const { groupsFor } = boardOf({ active: [card(`r`), booked(`b`, 9), draft(`d`)] });
        expect(groupsFor(`active`).map((group) => [group.key, group.headed, group.rows, ids(group.shown)])).toEqual([
            [`working`, true, false, [`r`]],
            [`next`, true, true, [`b`]],
            [`draft`, true, true, [`d`]],
        ]);
    });

    it(`draws a lane of one kind, and every other lane, as one run with no head`, () => {
        const { groupsFor } = boardOf({ active: [card(`r1`), card(`r2`)], finished: [card(`f`, { status: `landed` })] });
        expect(groupsFor(`active`).map((group) => [group.key, group.headed, group.foldable])).toEqual([[`working`, false, false]]);
        expect(groupsFor(`finished`).map((group) => [group.key, group.headed, ids(group.shown)])).toEqual([[`lane`, false, [`f`]]]);
    });

    it(`folds a group to its head, which counts it and names when its first card goes`, () => {
        const { groupsFor } = boardOf({ active: [card(`r`), booked(`late`, 900), booked(`soon`, 300)] }, [`next`]);
        const next = groupsFor(`active`)[1];
        expect([next?.folded, ids(next?.shown ?? []), next?.cards.length, next?.goesAt]).toEqual([true, [], 2, 300]);
    });

    it(`keeps the card wearing the ring in sight under its fold`, () => {
        const { groupsFor, selected } = boardOf({ active: [card(`r`), booked(`a`, 9), booked(`b`, 10)] }, [`next`]);
        selected.value = `b`;
        expect(ids(groupsFor(`active`)[1]?.shown ?? [])).toEqual([`b`]);
    });

    it(`never folds under a query, whose matches must all be on screen`, () => {
        const { groupsFor, filtering } = boardOf({ active: [card(`r`), booked(`b`, 9)] }, [`next`]);
        filtering.value = true;
        expect(groupsFor(`active`).map((group) => [group.foldable, group.folded, ids(group.shown)])).toEqual([
            [false, false, [`r`]],
            [false, false, [`b`]],
        ]);
    });

    it(`walks a Shift+click range through what is drawn, not through a folded group`, () => {
        const { paneOrder } = boardOf({ attention: [card(`x`, { status: `awaiting` })], active: [card(`r`), booked(`b`, 9), draft(`d`)] }, [`next`]);
        expect(ids(paneOrder.value)).toEqual([`x`, `r`, `d`]);
    });

    it(`reads a stored fold back, dropping a name that is not a group's`, () => {
        expect([...readFolds(`next,bogus,draft`)]).toEqual([`next`, `draft`]);
        expect([...readFolds(undefined)]).toEqual([]);
    });
});
