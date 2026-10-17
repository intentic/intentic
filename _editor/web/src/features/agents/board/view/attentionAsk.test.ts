import "@intentic/testing/dom";
import type { WorkflowRun } from "@intentic/sandbox-contract/schemas/workflows";
import { effectScope, nextTick, ref } from "vue";
import { attentionAsk } from "../../../../models/fleet/board/attentionOutside";
import type { FleetAgent } from "../../../../models/fleet/useAgents-fleet";
import { useAttentionAsk } from "./attentionAsk";

// What the board does once the tile's press has widened the scope: put away what else hides cards, scroll to the
// Attention lane, mark the first row, and open it when it is the only one.

// SAFETY: the composable only hands these rows to the host's callbacks; it reads none of their fields.
const rowOf = <T>(row: Record<string, string>): T => row as T;
const agent = rowOf<FleetAgent>({ id: `a1` });
const run = rowOf<WorkflowRun>({ runId: `r1` });

const board = document.createElement(`div`);
board.innerHTML = `<section data-lane="attention"><div data-reveal data-fold-unit><div id="first-card"></div></div></section>`;
const scrollIntoView = jest.fn();
// The elements the ring was drawn on: `animate` is called on the row itself.
const marked: Element[] = [];
const animate = jest.fn(function (this: Element) {
    marked.push(this);
});
Element.prototype.scrollIntoView = scrollIntoView;
Element.prototype.animate = animate as unknown as Element["animate"];

const mount = (rows: { cards: FleetAgent[]; runs: WorkflowRun[]; wakes: number }, over: { filtering?: boolean; archive?: boolean } = {}) => {
    const host = {
        board: ref<HTMLElement | undefined>(board),
        filtering: ref(over.filtering === true),
        clearFilter: jest.fn(),
        inArchive: ref(over.archive === true),
        leaveArchive: jest.fn(),
        rows: () => rows,
        openCard: jest.fn(),
        openRun: jest.fn(),
    };
    effectScope().run(() => useAttentionAsk(host));
    return host;
};
const press = async (): Promise<void> => {
    attentionAsk.value += 1;
    await nextTick();
    await nextTick();
    await nextTick();
};

beforeEach(() => {
    scrollIntoView.mockClear();
    animate.mockClear();
    marked.length = 0;
});

it(`scrolls to the Attention lane and marks its first card, not the unit around it`, async () => {
    mount({ cards: [agent, rowOf<FleetAgent>({ id: `a2` })], runs: [], wakes: 0 });
    await press();

    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(marked.map((row) => row.id)).toEqual([`first-card`]);
});

it(`opens the card when it is the only thing that needs the reader`, async () => {
    const host = mount({ cards: [agent], runs: [], wakes: 0 });
    await press();

    expect(host.openCard).toHaveBeenCalledWith(agent);
});

it(`opens the run when that is the only thing`, async () => {
    const host = mount({ cards: [], runs: [run], wakes: 0 });
    await press();

    expect(host.openRun).toHaveBeenCalledWith(run);
});

it(`opens nothing when more than one thing needs the reader`, async () => {
    const host = mount({ cards: [agent], runs: [], wakes: 1 });
    await press();

    expect(host.openCard).not.toHaveBeenCalled();
    expect(host.openRun).not.toHaveBeenCalled();
});

it(`puts away a filter and the archive, which hide cards the count is of`, async () => {
    const host = mount({ cards: [], runs: [], wakes: 0 }, { filtering: true, archive: true });
    await press();

    expect(host.clearFilter).toHaveBeenCalledTimes(1);
    expect(host.leaveArchive).toHaveBeenCalledTimes(1);
});
