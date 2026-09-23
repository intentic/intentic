import "@intentic/testing/dom";
import { unstubbed } from "@intentic/testing";
import { type EffectScope, effectScope, nextTick, ref } from "vue";
import type { TerminalSession } from "../terminalSession";
import { useTerminalFind } from "./useTerminalFind";

// Pins the find bar over the active session: it opens only on a session, runs incrementally as typed and walks on
// Enter, clears its highlights for an empty query, follows the active tab by moving the highlights, reports the
// addon's own count (many past its ceiling), and on closing clears them and hands the keyboard back.

type Search = TerminalSession[`search`];
type ResultsListener = Parameters<Search[`onDidChangeResults`]>[0];

const scopes: EffectScope[] = [];

const sessionNamed = () => {
    let listener: ResultsListener | undefined;
    const results = { dispose: jest.fn() };
    const search = {
        findNext: jest.fn((_query: string, _options?: { incremental?: boolean }) => true),
        findPrevious: jest.fn((_query: string, _options?: { incremental?: boolean }) => true),
        clearDecorations: jest.fn(),
        onDidChangeResults: jest.fn((next: ResultsListener) => {
            listener = next;
            return results;
        }),
    };
    const term = { focus: jest.fn() };
    const session = { search: unstubbed<Search>(`search`, search), term: unstubbed<TerminalSession[`term`]>(`term`, term) };
    return { session, search, term, results, report: (index: number, count: number) => listener?.({ resultIndex: index, resultCount: count }) };
};

const stage = () => {
    const a = sessionNamed();
    const b = sessionNamed();
    const activeName = ref<string | undefined>(`a`);
    const sessions: Record<string, ReturnType<typeof sessionNamed>> = { a, b };
    const scope = effectScope();
    scopes.push(scope);
    const find = scope.run(() => useTerminalFind({ activeName, sessionOf: (name) => sessions[name]?.session }))!;
    return { a, b, activeName, find };
};

afterEach(() => {
    for (const scope of scopes.splice(0)) {
        scope.stop();
    }
});

describe(`the find bar`, () => {
    it(`opens only over a session`, () => {
        const { activeName, find } = stage();
        activeName.value = undefined;
        find.openFind();
        expect(find.finding.value).toBe(false);
        activeName.value = `a`;
        find.openFind();
        expect(find.finding.value).toBe(true);
    });

    it(`searches as typed, walks on Enter both ways, and counts what the addon found`, () => {
        const { a, find } = stage();
        find.findQuery.value = `error`;
        find.runFind(true);
        expect(a.search.findNext.mock.calls[0]?.[1]?.incremental).toBe(true);
        a.report(2, 7);
        expect(find.findLabel.value).toBe(`3 of 7`);
        find.findNext();
        find.findPrevious();
        expect([a.search.findNext.mock.calls[1]?.[1]?.incremental, a.search.findPrevious.mock.calls.length]).toEqual([false, 1]);
        a.report(0, -1);
        expect(find.findLabel.value).toBe(`1 of many`);
        a.report(0, 0);
        expect(find.findLabel.value).toBe(`No results`);
    });

    it(`clears the highlights for an empty query rather than searching for nothing`, () => {
        const { a, find } = stage();
        find.runFind(true);
        expect(a.search.findNext).not.toHaveBeenCalled();
        expect(a.search.clearDecorations).toHaveBeenCalledTimes(1);
        expect(find.findLabel.value).toBe(``);
    });

    it(`moves the highlights to the tab that gained focus`, async () => {
        const { a, b, activeName, find } = stage();
        find.findQuery.value = `error`;
        find.openFind();
        activeName.value = `b`;
        await nextTick();
        expect(a.results.dispose).toHaveBeenCalledTimes(1);
        expect(b.search.findNext.mock.calls.map(([query]) => query)).toEqual([`error`]);
    });

    it(`clears the highlights and hands the keyboard back on closing`, () => {
        const { a, find } = stage();
        find.findQuery.value = `error`;
        find.openFind();
        find.closeFind();
        expect(find.finding.value).toBe(false);
        expect([a.results.dispose.mock.calls.length, a.term.focus.mock.calls.length]).toEqual([1, 1]);
        expect(a.search.clearDecorations).toHaveBeenCalledTimes(1);
    });
});
