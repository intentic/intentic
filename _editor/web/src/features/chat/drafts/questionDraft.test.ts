// The picks a question card keeps across a reload: found by the same requestId and no other, gone once the
// card is settled or swept, and limited to what the live card would still accept.
import "@intentic/testing/dom";
import { ATTACHMENTS_DIR } from "@intentic/sandbox-contract";
import { freshImport } from "@intentic/testing/bun";
import { answerStarted, clearQuestionDraft, type DraftQuestionShape, OTHER_LABEL, readQuestionDraft, writeQuestionDraft } from "./questionDraft";

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
    // The sweep runs once, at module load; re-evaluate the module rather than exporting a test-only hook.
    await freshImport<typeof import("./questionDraft")>("./questionDraft", import.meta.url);

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

// Dismiss asks first once an answer is under way: a pick, or words in a free-text row; an emptied row is no answer.
it("counts a pick or typed words as an answer started, and nothing else", () => {
    expect(answerStarted({ selections: {}, otherTexts: {} })).toBe(false);
    expect(answerStarted({ selections: { 0: [] }, otherTexts: { 1: `  ` } })).toBe(false);
    expect(answerStarted({ selections: { 1: [`Yes`] }, otherTexts: {} })).toBe(true);
    expect(answerStarted({ selections: {}, otherTexts: { 0: `the MIT one` } })).toBe(true);
});

// A screenshot uploaded for an Other answer is on disk already, so a reload brings it back with the words beside it.
it("keeps the files uploaded for a free-text row, and counts one as an answer started", () => {
    const otherFiles = { 0: [{ name: `shot.png`, path: `${ATTACHMENTS_DIR}/a/shot.png` }] };
    writeQuestionDraft(`req-a`, { selections: { 0: [OTHER_LABEL] }, otherTexts: {}, otherFiles });

    expect(readQuestionDraft(`req-a`, CARD)).toEqual({ selections: { 0: [OTHER_LABEL] }, otherTexts: {}, otherFiles });
    expect(answerStarted({ selections: {}, otherTexts: {}, otherFiles })).toBe(true);
    expect(answerStarted({ selections: {}, otherTexts: {}, otherFiles: { 0: [] } })).toBe(false);
});

// The record was cast, not read: a typed answer stored as a number came back as one, and the card's "has the reader
// started answering" check threw on it.
it("starts a card empty when its stored draft is not the shape this build writes", () => {
    localStorage.setItem(`intentic.questionDraft.req-a`, JSON.stringify({ selections: { 0: [`Postgres`] }, otherTexts: { 0: 42 }, savedAt: Date.now() }));

    const draft = readQuestionDraft(`req-a`, CARD);
    expect(draft).toEqual({ selections: {}, otherTexts: {} });
    expect(answerStarted(draft)).toBe(false);
});

