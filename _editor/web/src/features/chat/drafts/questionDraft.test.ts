// @vitest-environment jsdom
// The picks a question card keeps across a reload: found by the same requestId and no other, gone once the
// card is settled or swept, and limited to what the live card would still accept.
import { beforeEach, expect, it, vi } from "vitest";
import { clearQuestionDraft, type DraftQuestionShape, OTHER_LABEL, readQuestionDraft, writeQuestionDraft } from "./questionDraft";

beforeEach(() => {
    localStorage.clear();
});

// Three questions' worth of shape, enough for the indices the cases below write at.
const single = (...labels: string[]): DraftQuestionShape => ({ multiSelect: false, options: labels.map((label) => ({ label })) });
const multi = (...labels: string[]): DraftQuestionShape => ({ multiSelect: true, options: labels.map((label) => ({ label })) });
const CARD = [single(`Postgres`, `SQLite`), single(`Yes`, `No`), single(`Now`, `Later`)];

it("hands a card's picks back under its own requestId, and hands nothing to any other card", () => {
    writeQuestionDraft(`req-a`, { selections: { 0: [`Postgres`], 1: [`Yes`] }, otherTexts: { 2: `something else` } });

    expect(readQuestionDraft(`req-a`, CARD)).toEqual({ selections: { 0: [`Postgres`], 1: [`Yes`] }, otherTexts: { 2: `something else` } });
    expect(readQuestionDraft(`req-b`, CARD)).toEqual({ selections: {}, otherTexts: {} });
});

it("forgets a card once it is settled", () => {
    writeQuestionDraft(`req-a`, { selections: { 0: [`Postgres`] }, otherTexts: {} });
    clearQuestionDraft(`req-a`);

    expect(readQuestionDraft(`req-a`, CARD)).toEqual({ selections: {}, otherTexts: {} });
});

it("sweeps drafts older than a week, and keeps the rest", async () => {
    const stale = `intentic.questionDraft.req-old`;
    const fresh = `intentic.questionDraft.req-new`;
    const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;
    localStorage.setItem(stale, JSON.stringify({ selections: { 0: [`A`] }, otherTexts: {}, savedAt: eightDaysAgo }));
    localStorage.setItem(fresh, JSON.stringify({ selections: { 0: [`B`] }, otherTexts: {}, savedAt: Date.now() }));
    // The sweep runs once, at module load; re-run the module under a fresh registry rather than exporting a
    // test-only hook.
    vi.resetModules();
    await import(`./questionDraft`);

    expect(readQuestionDraft(`req-new`, [single(`B`)])).toEqual({ selections: { 0: [`B`] }, otherTexts: {} });
    expect(localStorage.getItem(stale)).toBeNull();
});

// A draft holding both a listed pick and a typed answer must not reopen the card in that state: the pick
// stands, the contradicting row does not, and the typed words survive.
it("drops a stored pick the live card would refuse, and keeps what was typed", () => {
    writeQuestionDraft(`req-a`, { selections: { 0: [`Postgres`, OTHER_LABEL] }, otherTexts: { 0: `Neither, use Redis` } });

    expect(readQuestionDraft(`req-a`, CARD)).toEqual({ selections: { 0: [`Postgres`] }, otherTexts: { 0: `Neither, use Redis` } });
});

it("keeps a multi-select question's several picks, Other among them", () => {
    writeQuestionDraft(`req-a`, { selections: { 0: [`Postgres`, `SQLite`, OTHER_LABEL] }, otherTexts: { 0: `and Redis` } });

    expect(readQuestionDraft(`req-a`, [multi(`Postgres`, `SQLite`)])).toEqual({
        selections: { 0: [`Postgres`, `SQLite`, OTHER_LABEL] },
        otherTexts: { 0: `and Redis` },
    });
});

it("forgets a pick whose option is no longer on the card", () => {
    writeQuestionDraft(`req-a`, { selections: { 0: [`MySQL`] }, otherTexts: {} });

    expect(readQuestionDraft(`req-a`, CARD)).toEqual({ selections: {}, otherTexts: {} });
});
