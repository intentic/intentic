import { STATE_DIR } from "@intentic/constants";
import type { TranscriptTool } from "@intentic/sandbox-contract";
import { REVEAL_DELAY_MS } from "@intentic/ui/loading-reveal";
import { nextTick, ref } from "vue";
import type { ChatMessage } from "../../transcript/transcript";
import { usePaneTranscript } from "./paneTranscript";

// Pins what a pane draws of its transcript beyond the rows: which bubble is live, when the working line stands in for
// one, and which turn's pictures get a strip.

const SHOT: TranscriptTool = {
    id: `t1`,
    name: `browser_screenshot`,
    category: `other`,
    status: `completed`,
    content: [{ type: `image`, path: `${STATE_DIR}/shots/home.png` }],
};
// Two turns: the first took a picture, the second is still being answered.
const ROWS: readonly ChatMessage[] = [
    { id: 1, role: `user`, text: `make it blue` },
    { id: 2, role: `assistant`, text: `done`, tools: [SHOT] },
    { id: 3, role: `user`, text: `and the header` },
    { id: 4, role: `assistant`, text: `on it` },
];

const paneOf = (rows: readonly ChatMessage[] = ROWS) => {
    const state = {
        messages: ref<readonly ChatMessage[]>(rows),
        streaming: ref(false),
        awaitingDecision: ref(false),
        showToolCalls: ref(false),
        loading: ref(false),
        conversationId: ref(`c1`),
    };
    return { state, pane: usePaneTranscript(state) };
};

describe(`the live turn`, () => {
    it(`streams into the last turn's answer only while a turn is live`, () => {
        const { state, pane } = paneOf();
        expect(pane.isStreaming(ROWS[3]!)).toBe(false);

        state.streaming.value = true;
        expect(pane.isStreaming(ROWS[3]!)).toBe(true);
        expect(pane.isStreaming(ROWS[1]!)).toBe(false);
    });

    it(`draws the working line before the turn has written anything, and never over a parked card`, () => {
        const { state, pane } = paneOf(ROWS.slice(0, 3));
        state.streaming.value = true;
        expect(pane.showTurnStatus.value).toBe(true);

        state.awaitingDecision.value = true;
        expect(pane.showTurnStatus.value).toBe(false);

        state.awaitingDecision.value = false;
        state.messages.value = ROWS;
        expect(pane.showTurnStatus.value).toBe(false);
    });
});

describe(`a turn's pictures`, () => {
    it(`strip a settled turn that took one, while runs are folded`, () => {
        const { state, pane } = paneOf();
        const [first, second] = pane.turns.value;

        expect(pane.stripOf(first!)).toEqual([{ key: `t1\n.intentic/shots/home.png`, path: `${STATE_DIR}/shots/home.png`, toolId: `t1`, turnId: 1 }]);
        expect(pane.stripOf(second!)).toBeUndefined();

        // Unfolded runs draw every picture on their cards already.
        state.showToolCalls.value = true;
        expect(pane.stripOf(first!)).toBeUndefined();
    });

    it(`wait for the turn to stop writing, unless it is parked on the reader`, () => {
        const { state, pane } = paneOf(ROWS.slice(0, 2));
        state.streaming.value = true;
        expect(pane.stripOf(pane.turns.value[0]!)).toBeUndefined();

        state.awaitingDecision.value = true;
        expect(pane.stripOf(pane.turns.value[0]!)?.map((shot) => shot.path)).toEqual([`${STATE_DIR}/shots/home.png`]);
    });
});

describe(`the column's marks`, () => {
    it(`cuts a fork below each turn at the rows above the line`, () => {
        const { pane } = paneOf();

        expect([...pane.forkCuts.value]).toEqual([
            [1, 2],
            [3, 4],
        ]);
    });
});

describe(`a transcript on its way`, () => {
    afterEach(() => {
        jest.useRealTimers();
    });

    it(`stands its skeleton in only past the reveal delay, and drops it the moment another chat is on screen`, async () => {
        jest.useFakeTimers();
        const { state, pane } = paneOf([]);

        state.loading.value = true;
        await nextTick();
        jest.advanceTimersByTime(REVEAL_DELAY_MS - 1);
        expect(pane.skeleton.value).toBe(false);
        jest.advanceTimersByTime(1);
        expect(pane.skeleton.value).toBe(true);

        state.conversationId.value = `c2`;
        await nextTick();
        expect(pane.skeleton.value).toBe(false);
    });
});
