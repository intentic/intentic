import "@intentic/testing/dom";
import { stubGlobal, unstubAllGlobals } from "@intentic/testing/bun";
import { effectScope, nextTick, ref } from "vue";
import type { ChatMessage, ChatTurn } from "../../../transcript/transcript";
import { nextBudget, useRowBudget, windowTurns } from "../paneWindow";

// The rows of a chat drawn: its newest, then more a slice at a time at idle up to a window, the rest as the reader climbs.

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
    const sizes = { first: 4, slice: 2, most: 6 };
    const rows = (from: number, to: number): ChatMessage[] => Array.from({ length: to - from + 1 }, (_, index) => row(from + index));

    // The bug this replaced: an open's rows land on an empty list, and "widen by what arrived" drew every one of them.
    it(`starts at the first paint when a chat's rows arrive, however many`, () => {
        expect(nextBudget(4, [], rows(1, 400), sizes, true)).toBe(4);
    });

    it(`widens by rows appended while the reader is away from the newest, and never narrows`, () => {
        expect(nextBudget(5, rows(1, 5), rows(1, 8), sizes, false)).toBe(8);
        expect(nextBudget(5, rows(1, 5), rows(1, 3), sizes, false)).toBe(5);
    });

    it(`grows to the window and then slides while the reader is at the newest`, () => {
        expect(nextBudget(4, rows(1, 5), rows(1, 6), sizes, true)).toBe(5);
        expect(nextBudget(6, rows(1, 9), rows(1, 12), sizes, true)).toBe(6);
        // A window already wider (the reader climbed, then came back) is left to the trim, not cut mid-arrival.
        expect(nextBudget(9, rows(1, 9), rows(1, 10), sizes, true)).toBe(9);
    });

    it(`draws a slice of a page put above, not the whole page`, () => {
        const standing = rows(401, 410);
        expect(nextBudget(6, standing, [...rows(1, 400), ...standing], sizes, false)).toBe(8);
    });
});

describe(`useRowBudget`, () => {
    const idle: (() => void)[] = [];
    const drain = (): void => {
        while (idle.length > 0) {
            idle.shift()?.();
        }
    };
    beforeEach(() => {
        idle.length = 0;
        stubGlobal(`requestIdleCallback`, (callback: () => void) => idle.push(callback));
    });
    const many = (count: number, from = 1): ChatMessage[] => Array.from({ length: count }, (_, index) => row(from + index));

    it(`opens on the newest rows and mounts more a slice per idle callback up to the window, starting over for another chat`, async () => {
        const messages = ref<readonly ChatMessage[]>(many(400));
        const conversationId = ref(`a`);
        const scope = effectScope();
        const budget = scope.run(() => useRowBudget({ messages, conversationId, parked: ref(true), edge: ref() }))!;

        // A desktop pointer here (the setup's matchMedia answers no): its first paint and slice, then the window.
        expect(budget.value).toBe(160);
        idle.shift()?.();
        expect(budget.value).toBe(240);
        drain();
        expect(budget.value).toBe(320);

        conversationId.value = `b`;
        await nextTick();
        expect(budget.value).toBe(160);
        scope.stop();
    });

    it(`opens on the newest rows when they arrive after the pane does`, async () => {
        const messages = ref<readonly ChatMessage[]>([]);
        const scope = effectScope();
        const budget = scope.run(() => useRowBudget({ messages, conversationId: ref(`a`), parked: ref(true), edge: ref() }))!;
        messages.value = many(4000);
        await nextTick();
        expect(budget.value).toBe(160);
        scope.stop();
    });

    it(`draws the rows above the window as the reader climbs to its edge, and takes them down once they are back at the newest`, async () => {
        const reports: ((entries: { isIntersecting: boolean }[]) => void)[] = [];
        stubGlobal(
            `IntersectionObserver`,
            class {
                constructor(report: (entries: { isIntersecting: boolean }[]) => void) {
                    reports.push(report);
                }
                observe(): void {}
                disconnect(): void {}
            },
        );
        const scroller = document.createElement(`div`);
        scroller.className = `chat-scroller`;
        const edge = document.createElement(`div`);
        scroller.append(edge);
        const messages = ref<readonly ChatMessage[]>(many(1000));
        const parked = ref(true);
        const scope = effectScope();
        const budget = scope.run(() => useRowBudget({ messages, conversationId: ref(`a`), parked, edge: ref(edge) }))!;
        await nextTick();
        drain();
        expect(budget.value).toBe(320);

        parked.value = false;
        await nextTick();
        reports.at(-1)?.([{ isIntersecting: true }]);
        idle.shift()?.();
        expect(budget.value).toBe(400);
        idle.shift()?.();
        expect(budget.value).toBe(480);
        // Far enough from the top again: the climb stops where it is.
        reports.at(-1)?.([{ isIntersecting: false }]);
        drain();
        expect(budget.value).toBe(480);

        parked.value = true;
        await nextTick();
        drain();
        expect(budget.value).toBe(320);
        scope.stop();
    });
});
