import "@intentic/testing/dom";
import { stubGlobal, unstubAllGlobals } from "@intentic/testing/bun";
import { effectScope, nextTick, ref } from "vue";
import type { ChatMessage, ChatTurn } from "../../../transcript/transcript";
import { nextBudget, useRowBudget, windowTurns } from "../paneWindow";

// The rows of a chat drawn so far: its newest, then the rest a slice at a time at idle, and never fewer than were drawn.

const row = (id: number, role: ChatMessage["role"] = `assistant`): ChatMessage => ({ id, role, text: `row ${id}` });
const turn = (...messages: ChatMessage[]): ChatTurn => ({ id: messages[0]!.id, messages, folded: [] });

afterEach(() => {
    unstubAllGlobals();
});

describe(`windowTurns`, () => {
    const turns = [turn(row(1, `user`), row(2), row(3)), turn(row(4, `user`), row(5), row(6), row(7))];

    it(`draws every turn, the same objects, while the budget covers the chat`, () => {
        const drawn = windowTurns(turns, 7, 7);
        expect(drawn).toBe(turns);
    });

    // A turn cut by the budget keeps its prompt, so it still pins over the part of its answer on screen.
    it(`drops the turns above the budget and keeps the opening row of one it cuts`, () => {
        const drawn = windowTurns(turns, 7, 3);
        expect(drawn.map((shown) => shown.messages.map((message) => message.id))).toEqual([[4, 5, 6, 7]]);
        expect(drawn[0]).toBe(turns[1]);

        const cut = windowTurns(turns, 7, 2);
        expect(cut.map((shown) => shown.messages.map((message) => message.id))).toEqual([[4, 6, 7]]);
    });
});

describe(`nextBudget`, () => {
    it(`widens by what arrived, whether appended or prepended, and never narrows`, () => {
        expect(nextBudget(24, [row(1), row(2)], [row(1), row(2), row(3)])).toBe(25);
        expect(nextBudget(24, [row(3)], [row(1), row(2), row(3)])).toBe(26);
        expect(nextBudget(24, [row(1), row(2), row(3)], [row(1)])).toBe(24);
    });
});

describe(`useRowBudget`, () => {
    it(`opens on the newest rows and mounts the rest a slice per idle callback, starting over for another chat`, async () => {
        const idle: (() => void)[] = [];
        stubGlobal(`requestIdleCallback`, (callback: () => void) => idle.push(callback));
        const messages = ref<readonly ChatMessage[]>(Array.from({ length: 400 }, (_, index) => row(index + 1)));
        const conversationId = ref(`a`);
        const scope = effectScope();
        const budget = scope.run(() => useRowBudget({ messages, conversationId }))!;

        // A desktop pointer here (the setup's matchMedia answers no): its first paint and slice.
        expect(budget.value).toBe(160);
        idle.shift()?.();
        expect(budget.value).toBe(240);
        while (idle.length > 0) {
            idle.shift()?.();
        }
        expect(budget.value).toBe(400);

        conversationId.value = `b`;
        await nextTick();
        expect(budget.value).toBe(160);
        scope.stop();
    });
});
