import { effectScope, type EffectScope, nextTick, ref, shallowRef } from "vue";
import { NO_ATTENTION } from "../../../fleet/agentStatus";
import type { FleetAgent } from "../../../fleet/useAgents-fleet";
import type { ViewEvent } from "../boardView";
import { useFoundCard } from "../foundCard";

// Pins what the board does with a card a query names by its id: it is the one card picked only when it is the only one
// named, it is scrolled to on every query that names it, the archive's matches unfold for a filed one instead, and
// Enter opens it and says so.

const card = (id: string, over: Partial<FleetAgent> = {}): FleetAgent => ({
    id,
    title: `agent ${id}`,
    status: `landed`,
    provider: `claude`,
    harness: `native`,
    updatedAt: 1_000,
    attention: NO_ATTENTION,
    open: false,
    unread: false,
    unsent: false,
    ...over,
});

const running: EffectScope[] = [];
afterEach(() => {
    for (const effects of running.splice(0)) {
        effects.stop();
    }
});

// A board whose filter names a card by its id typed whole, recording what it scrolled to, moved and opened.
const boardOf = (drawn: FleetAgent[], archived: FleetAgent[] = []) => {
    const needle = ref(``);
    const paneOrder = shallowRef<readonly FleetAgent[]>(drawn);
    const archivedHits = shallowRef<readonly FleetAgent[]>(archived);
    const beyondVisible = ref(archived.length > 0);
    const revealed: string[] = [];
    const moves: ViewEvent[] = [];
    const opened: string[] = [];
    const effects = effectScope();
    running.push(effects);
    const found = effects.run(() =>
        useFoundCard({
            filter: { needle, exact: (agent) => agent.id === needle.value },
            lanes: { paneOrder, archivedHits, beyondVisible },
            move: (event) => moves.push(event),
            reveal: async (id) => {
                revealed.push(id);
            },
            open: (agent) => opened.push(agent.id),
        }),
    )!;
    const type = async (text: string): Promise<void> => {
        needle.value = text;
        await nextTick();
    };
    return { found, type, revealed, moves, opened, paneOrder };
};

describe(`the card a query names by its id`, () => {
    it(`is scrolled to on every query that names it, and opened by Enter, which says it did`, async () => {
        const board = boardOf([card(`crisp-basin-z86j`), card(`swift-otter-k9m2`)]);
        await board.type(`crisp-basin-z86`);
        expect([board.found.found.value?.id, board.found.openFound()]).toEqual([undefined, false]);
        await board.type(`crisp-basin-z86j`);
        expect(board.found.found.value?.id).toBe(`crisp-basin-z86j`);
        expect(board.found.openFound()).toBe(true);
        expect([board.revealed, board.opened]).toEqual([[`crisp-basin-z86j`], [`crisp-basin-z86j`]]);
    });

    it(`is none when two cards share the id, since two sandboxes can mint the same one`, async () => {
        const board = boardOf([card(`crisp-basin-z86j`), card(`crisp-basin-z86j`, { sandboxId: `sbx-2` })]);
        await board.type(`crisp-basin-z86j`);
        expect([board.found.found.value, board.found.openFound(), board.revealed]).toEqual([undefined, false, []]);
    });

    it(`unfolds the archive's matches for a filed card instead of scrolling to a row not yet drawn`, async () => {
        const board = boardOf([card(`swift-otter-k9m2`)], [card(`crisp-basin-z86j`, { archivedAt: 5 })]);
        await board.type(`crisp-basin-z86j`);
        expect([board.found.found.value?.id, board.moves, board.revealed]).toEqual([`crisp-basin-z86j`, [{ kind: `unfold` }], []]);
    });
});
