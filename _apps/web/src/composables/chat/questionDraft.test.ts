// @vitest-environment jsdom
//
// The picks a question card keeps across a reload. What matters here is that a draft is found again by the
// SAME requestId and by no other (two cards must never read each other's picks), that a settled card's draft
// goes away, and that a card abandoned long enough to be swept doesn't come back from the dead.
import { beforeEach, expect, it, vi } from "vitest";
import { clearQuestionDraft, readQuestionDraft, writeQuestionDraft } from "./questionDraft";

beforeEach(() => {
    localStorage.clear();
});

it("hands a card's picks back under its own requestId, and hands nothing to any other card", () => {
    writeQuestionDraft(`req-a`, { selections: { 0: [`Postgres`], 1: [`Yes`] }, otherTexts: { 2: `something else` } });

    expect(readQuestionDraft(`req-a`)).toEqual({ selections: { 0: [`Postgres`], 1: [`Yes`] }, otherTexts: { 2: `something else` } });
    expect(readQuestionDraft(`req-b`)).toEqual({ selections: {}, otherTexts: {} });
});

it("forgets a card once it is settled", () => {
    writeQuestionDraft(`req-a`, { selections: { 0: [`Postgres`] }, otherTexts: {} });
    clearQuestionDraft(`req-a`);

    expect(readQuestionDraft(`req-a`)).toEqual({ selections: {}, otherTexts: {} });
});

it("sweeps drafts older than a week, and keeps the rest", async () => {
    const stale = `intentic.questionDraft.req-old`;
    const fresh = `intentic.questionDraft.req-new`;
    const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;
    localStorage.setItem(stale, JSON.stringify({ selections: { 0: [`A`] }, otherTexts: {}, savedAt: eightDaysAgo }));
    localStorage.setItem(fresh, JSON.stringify({ selections: { 0: [`B`] }, otherTexts: {}, savedAt: Date.now() }));
    // The sweep runs once, at module load — so re-run the module under a fresh registry rather than exporting a
    // hook that exists only for this test.
    vi.resetModules();
    await import(`./questionDraft`);

    expect(localStorage.getItem(stale)).toBeNull();
    expect(readQuestionDraft(`req-new`)).toEqual({ selections: { 0: [`B`] }, otherTexts: {} });
});
