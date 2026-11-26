import { agentWordsRow, childReportPrompt } from "@intentic/sandbox-contract/events/agent-words";
import { childNewsRow, movedHereWords } from "@intentic/sandbox-contract/events/child-news";
import { noticeLayoutOf, type NoticeLayoutContext } from "./noticeLayout";
import { type ChatMessage, turnsOf } from "./transcript";

// Where each notice is drawn: a card for what arrived, a strip for the failure a turn ended on, a line for a wait still
// running, and everything else on the turn's receipt. Asked again on every frame of a streamed turn, so a receipt that
// did not change must come back as the same object.

const context = (over: Partial<NoticeLayoutContext> = {}): NoticeLayoutContext => ({
    incidentFolded: new Set(),
    liveTurn: undefined,
    pending: () => false,
    ...over,
});
const prompt = (id: number): ChatMessage => ({ id, role: `user`, text: `Port the parser to the new grammar.` });
const answer = (id: number, durationMs?: number): ChatMessage =>
    durationMs === undefined ? { id, role: `assistant`, text: `done` } : { id, role: `assistant`, text: `done`, usage: { durationMs } };
const switched = (id: number): ChatMessage => ({
    id,
    role: `notice`,
    text: `Switched to Claude Max`,
    noticeCode: { code: `switched`, params: { segment: `account`, provider: `claude`, account: `Max`, fresh: false } },
});
const limit = (id: number): ChatMessage => ({
    id,
    role: `notice`,
    text: `Claude usage limit reached.`,
    noticeCode: { code: `failed`, params: { message: `Claude usage limit reached.`, error: `rate_limit` } },
});
const landed = (id: number): ChatMessage => ({ id, role: `notice`, text: `Landed in your workspace.`, noticeCode: { code: `landed` } });
const report = (id: number, title: string, failed = false): ChatMessage => ({
    id,
    ...agentWordsRow(childReportPrompt({ child: `sub-${id}`, title, failed, report: `Done.`, verification: undefined }))!,
});
const news = (id: number, title: string): ChatMessage => ({
    id,
    ...childNewsRow(movedHereWords({ child: `sub-${id}`, title }, `omen`, `Preparing the runner's workspace failed.`))!,
});
const watching = (id: number): ChatMessage => ({
    id,
    role: `notice`,
    text: `Watching for CI, checked every 5m.`,
    noticeCode: { code: `watching`, params: { note: `CI`, every: `5m` } },
    noticeWait: `watch`,
    noticeAction: `watchStop`,
});

const layout = (rows: ChatMessage[], over: Partial<NoticeLayoutContext> = {}) => noticeLayoutOf(turnsOf(rows), context(over));

describe(`noticeLayoutOf`, () => {
    it(`puts what happened to the turn's machinery on its receipt, with the land and how long it ran`, () => {
        const answered = layout([prompt(1), switched(2), answer(3, 4_000), landed(4), answer(5, 8_000)]);
        expect([...answered.folded]).toEqual([2, 4]);
        expect(answered.tiers.size).toBe(0);
        expect(answered.receipts.get(1)).toMatchObject({ problems: 0, warnings: 0, durationMs: 12_000, stopped: false });
        expect(answered.receipts.get(1)?.land?.id).toBe(4);
        expect(answered.receipts.get(1)?.rows.map((row) => row.id)).toEqual([2, 4]);
    });

    it(`draws the failure a turn ended on as a strip, and one something got past as history on the receipt`, () => {
        expect(layout([prompt(1), answer(2), limit(3)]).tiers.get(3)).toBe(`strip`);
        const gotPast = layout([prompt(1), limit(2), switched(3), answer(4)]);
        expect(gotPast.tiers.has(2)).toBe(false);
        expect(gotPast.receipts.get(1)).toMatchObject({ problems: 1 });
        // Quiet rows after it do not take the ending from it.
        expect(layout([prompt(1), limit(2), switched(3)]).tiers.get(2)).toBe(`strip`);
    });

    it(`says nothing ended a turn that is still being written`, () => {
        expect(layout([prompt(1), limit(2)], { liveTurn: 1 }).tiers.has(2)).toBe(false);
    });

    it(`keeps a running wait in the column, and its row on the receipt once it settles in an earlier turn`, () => {
        expect(layout([prompt(1), watching(2)], { pending: (row) => row.id === 2 }).tiers.get(2)).toBe(`inline`);
        // Its press may still matter in the latest turn; an earlier turn's is history.
        expect(layout([prompt(1), watching(2)]).tiers.get(2)).toBe(`inline`);
        expect(layout([prompt(1), watching(2), prompt(3), answer(4)]).folded.has(2)).toBe(true);
    });

    it(`draws reports as cards, sharing one when they arrive back to back`, () => {
        const fleet = layout([prompt(1), report(2, `Slice A`), switched(3), report(4, `Slice B`, true), answer(5), report(6, `Slice C`)]);
        expect(fleet.tiers.get(2)).toBe(`arrival`);
        expect(fleet.groups.get(2)?.rows.map((row) => row.id)).toEqual([2, 4]);
        expect(fleet.folded.has(4)).toBe(true);
        // The agent spoke between them: a card of its own.
        expect(fleet.groups.has(6)).toBe(false);
        expect(fleet.folded.has(6)).toBe(false);
    });

    // 2026-11-26: four of these, one cause, drew as four of the owner's own bubbles.
    it(`draws news about subagents on its own, one block for news back to back, never in a report's card`, () => {
        const told = layout([prompt(1), news(2, `#8 Lighter pnpm dev`), news(3, `#2 Targeted reclaim`), report(4, `Slice A`), answer(5), news(6, `#1 WSL card`)]);
        expect(told.tiers.get(2)).toBe(`news`);
        expect(told.groups.get(2)?.rows.map((row) => row.id)).toEqual([2, 3]);
        expect(told.folded.has(3)).toBe(true);
        // A report right after news is a card of its own, and the agent spoke before the last.
        expect(told.tiers.get(4)).toBe(`arrival`);
        expect(told.folded.has(4)).toBe(false);
        expect(told.groups.has(6)).toBe(false);
        expect(told.receipts.get(1)).toBeUndefined();
    });

    it(`leaves rows other components draw where they stand, and skips rows an incident folded`, () => {
        const job: ChatMessage = { id: 2, role: `notice`, text: `Background job: tests`, backgroundJob: { id: `j`, label: `tests`, command: `pnpm test`, startedAt: 0 } };
        const rows = [prompt(1), job, switched(3), limit(4), answer(5)];
        const answered = layout(rows, { incidentFolded: new Set([4]) });
        expect(answered.folded.has(2)).toBe(false);
        expect(answered.receipts.get(1)?.rows.map((row) => row.id)).toEqual([3]);
    });

    it(`hands back the same receipt while its turn did not change`, () => {
        const rows = [prompt(1), switched(2), answer(3), prompt(4), switched(5)];
        const first = layout(rows);
        const next = noticeLayoutOf(turnsOf([...rows, answer(6)]), context(), first);
        expect(next.receipts.get(1)).toBe(first.receipts.get(1));
        expect(noticeLayoutOf(turnsOf([prompt(1), answer(2)]), context(), noticeLayoutOf([], context()))).toEqual(noticeLayoutOf([], context()));
    });
});
