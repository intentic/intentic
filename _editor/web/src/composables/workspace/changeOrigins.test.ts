import type { GitChange, LandedMessageDraft, RepoChanges } from "@intentic-app/api-contract";
import { describe, expect, test } from "vitest";
import { chipMessageNotice, commitMessageOf, draftReport, landedMessage, ORIGIN_HUES, originHue, originsOf, summarizeOrigins } from "./changeOrigins";

const change = (path: string, status: GitChange[`status`] = `modified`): GitChange => ({ path, status });
const repo = (name: string, sides: Partial<Pick<RepoChanges, `conflicted` | `staged` | `unstaged` | `origins`>>): RepoChanges => ({
    repo: name,
    conflicted: [],
    staged: [],
    unstaged: [],
    ...sides,
});

describe(`summarizeOrigins`, () => {
    test(`counts files per agent and files nobody landed as yours`, () => {
        const repos = [
            repo(`root`, {
                unstaged: [change(`a.ts`), change(`b.ts`), change(`mine.ts`)],
                origins: { "a.ts": [`agent-1`], "b.ts": [`agent-1`] },
            }),
            repo(`intentic`, { unstaged: [change(`c.ts`)], origins: { "c.ts": [`agent-2`] } }),
        ];
        expect(summarizeOrigins(repos)).toEqual({
            agents: [
                { id: `agent-1`, files: 2 },
                { id: `agent-2`, files: 1 },
            ],
            yours: 1,
        });
    });

    test(`a half-staged file is one file, not two rows`, () => {
        const repos = [repo(`root`, { staged: [change(`a.ts`)], unstaged: [change(`a.ts`)], origins: { "a.ts": [`agent-1`] } })];
        expect(summarizeOrigins(repos)).toEqual({ agents: [{ id: `agent-1`, files: 1 }], yours: 0 });
    });

    test(`a file two agents landed counts for both`, () => {
        const repos = [repo(`root`, { unstaged: [change(`a.ts`)], origins: { "a.ts": [`agent-2`, `agent-1`] } })];
        expect(summarizeOrigins(repos)).toEqual({
            agents: [
                { id: `agent-1`, files: 1 },
                { id: `agent-2`, files: 1 },
            ],
            yours: 0,
        });
    });

    test(`a repo the daemon reported no origins for is entirely yours`, () => {
        expect(summarizeOrigins([repo(`root`, { unstaged: [change(`a.ts`), change(`b.ts`)] })])).toEqual({ agents: [], yours: 2 });
        expect(originsOf(repo(`root`, {}), `a.ts`)).toEqual([]);
    });
});

describe(`originHue`, () => {
    test(`is stable per id and always one of the palette's hues`, () => {
        expect(originHue(`agent-1`)).toBe(originHue(`agent-1`));
        for (const id of [``, `a`, `agent-1`, `9f3c-4d2e-8a71`, `x`.repeat(200)]) {
            expect(ORIGIN_HUES).toContain(originHue(id));
        }
    });
});

/* WHICH COPY OF THE SENTENCE WINS. The first test is the one that matters in practice: the message is written
 * seconds after the land, and only the card is pushed when it is — a review that still says nothing must not be
 * allowed to answer over a card that does. */
describe(`landedMessage`, () => {
    const message = { subject: `fix: cascading markers` };

    test(`takes the card's copy: it is the one the daemon pushes the moment the sentence exists`, () => {
        expect(landedMessage({ landedMessage: message }, undefined)).toEqual(message);
        expect(landedMessage({ landedMessage: message }, {})).toEqual(message);
    });

    test(`falls back to the review, which is all an archived agent's chip has left`, () => {
        expect(landedMessage(undefined, { landedMessage: message })).toEqual(message);
    });

    test(`nothing written for this landing (or nothing yet) is undefined, not a guess`, () => {
        expect(landedMessage(undefined, undefined)).toBeUndefined();
        expect(landedMessage({}, {})).toBeUndefined();
    });
});

describe(`commitMessageOf`, () => {
    test(`a bare subject is the whole message`, () => {
        expect(commitMessageOf({ subject: `fix: cascading markers` })).toBe(`fix: cascading markers`);
    });

    // git reads only the message's FINAL block as trailers, so both sentences share one paragraph — a blank
    // line between them would demote the release note to body text and the harvest would never see it.
    test(`both notes ride one trailer block under the subject`, () => {
        expect(commitMessageOf({ subject: `feat: rework tabs`, note: `Tabs remember their scroll.`, breaking: `The old tab API is gone.` })).toBe(
            `feat: rework tabs\n\nRelease-Note: Tabs remember their scroll.\nBreaking-Note: The old tab API is gone.`,
        );
    });

    test(`a note without a breaking sentence leaves no empty line behind it`, () => {
        expect(commitMessageOf({ subject: `feat: rework tabs`, note: `Tabs remember their scroll.` })).toBe(
            `feat: rework tabs\n\nRelease-Note: Tabs remember their scroll.`,
        );
    });

    test(`no message is no message: the box stays the user's to type in`, () => {
        expect(commitMessageOf(undefined)).toBeUndefined();
    });
});

// A draft mid-walk, as the roster carries one: opened at second 0, gemini asked at second 2. `NOW` is the
// reader's clock, ten seconds in — the elapsed the in-flight line ticks against.
const NOW = 12_000;
const running = (steps: LandedMessageDraft[`steps`] = [{ provider: `gemini`, model: `gemini-3-flash`, status: `asking`, at: 2_000 }]) => ({
    startedAt: 0,
    steps,
});

/* EVERY WAY THE CLICK CAN COME BACK WITH NOTHING, and the words for each. They all looked identical before —
 * the list narrowed and the box did not move — which is the report this answers: "it doesn't tell me why". */
describe(`chipMessageNotice`, () => {
    const state = {
        label: `Review panel · audit`,
        yours: false,
        message: undefined as string | undefined,
        draft: undefined as LandedMessageDraft | undefined,
        boxIsYours: false,
    };

    test(`says nothing when no chip is lit: nothing has been asked of the box`, () => {
        expect(chipMessageNotice({ ...state, label: undefined })).toBeUndefined();
    });

    test(`says nothing once the message is in the box, where it speaks for itself`, () => {
        expect(chipMessageNotice({ ...state, message: `fix: cascading markers` })).toBeUndefined();
    });

    /* THE BOX SAYS WHAT IS HAPPENING; THE REPORT UNDER IT SAYS HOW IT IS GOING. This line used to carry the
     * walk's newest step as well ("— Asking gemini-3-flash… 10s"), which printed the same words twice a
     * centimetre apart: here, and as the last row of the report list directly below. The row below keeps them —
     * it has the glyph, the aligned clock and the width — and this line keeps the one thing only it can say,
     * which is whose message the box is waiting for. */
    test(`names whose message is coming, and leaves the step-by-step to the report below`, () => {
        expect(chipMessageNotice({ ...state, draft: running() })).toBe(`Writing a message for Review panel · audit…`);
    });

    test(`says the same before any model has been reached: the report below has the phase`, () => {
        expect(chipMessageNotice({ ...state, draft: { startedAt: 0, steps: [] } })).toBe(`Writing a message for Review panel · audit…`);
    });

    test(`says a sentence is never coming when none was written`, () => {
        expect(chipMessageNotice(state)).toBe(`No message was written for Review panel · audit — name the commit yourself`);
    });

    // A draft that ENDED without writing is the same answer — the step list under the box carries the details.
    test(`a failed draft reads as the absence, not as a wait`, () => {
        expect(chipMessageNotice({ ...state, draft: { startedAt: 0, steps: [], outcome: `failed`, finishedAt: 9_000 } })).toBe(
            `No message was written for Review panel · audit — name the commit yourself`,
        );
    });

    /* The refusal that is ABOUT THE USER, and the only one with a remedy in their hands — a box they typed in is
     * never overwritten, so the chip's message waits outside it with nothing on screen to say so. That silence
     * is what made a working feature read as a broken one. */
    test(`explains itself when the box is the user's, and says what to do about it`, () => {
        expect(chipMessageNotice({ ...state, message: `fix: cascading markers`, boxIsYours: true })).toBe(
            `Keeping your message — clear the box to use Review panel · audit's`,
        );
    });

    test(`says the same while that session's sentence is still being written`, () => {
        expect(chipMessageNotice({ ...state, draft: running(), boxIsYours: true })).toBe(
            `Keeping your message — clear the box to use Review panel · audit's`,
        );
    });

    // A box the user owns over a session nothing was written for: the absence is the more fundamental answer,
    // and offering to clear the box for a message that does not exist would be a lie.
    test(`falls back to the absence when neither the box nor the session has anything to file`, () => {
        expect(chipMessageNotice({ ...state, boxIsYours: true })).toBe(`No message was written for Review panel · audit — name the commit yourself`);
    });

    test(`the "you" row has no landed sentence by definition, and says so`, () => {
        expect(chipMessageNotice({ ...state, label: `you`, yours: true })).toBe(`Your own changes — name this commit yourself`);
    });
});

/* THE FULL REPORT, row by row — the walk's own record in the user's terms, split into the columns the panel
 * lays out. What each status earns is pinned here because these rows ARE the feature: the difference between a
 * minute-long mystery and a minute-long wait you can watch move. */
describe(`draftReport`, () => {
    test(`no draft is no report: the one-line notice covers that case`, () => {
        expect(draftReport(undefined, NOW)).toEqual([]);
    });

    test(`an open draft with no steps is the diff being read`, () => {
        expect(draftReport({ startedAt: 0, steps: [] }, NOW)).toEqual([
            { key: `reading`, status: `reading`, detail: `Reading the landed diff…`, title: `Reading the landed diff…` },
        ]);
    });

    test(`tells the whole walk: the skip with its remembered reason, the refusal in its own words, the answer`, () => {
        const rows = draftReport(
            {
                startedAt: 0,
                steps: [
                    { provider: `gemini`, model: `gemini-3-flash`, status: `skipped`, reason: `usage limit reached` },
                    { provider: `codex`, model: `gpt-5.6`, status: `refused`, at: 1_000, ms: 58_000, reason: `no capacity` },
                    { provider: `claude`, model: `claude-haiku`, status: `answered`, at: 59_000, ms: 7_000 },
                ],
                outcome: `written`,
                finishedAt: 66_000,
            },
            NOW,
        );
        expect(rows.map((row) => [row.status, row.model, row.detail, row.elapsed])).toEqual([
            [`skipped`, `gemini-3-flash`, `usage limit reached`, undefined],
            [`refused`, `gpt-5.6`, `no capacity`, `58s`],
            [`answered`, `claude-haiku`, `wrote the message`, `7s`],
        ]);
    });

    /* THE TOOLTIP IS THE ROW UNABRIDGED — the full model id, the verb spelled out and the vendor's whole
     * sentence. Everything the columns shorten is one hover away, which is what makes shortening them safe. */
    test(`each row keeps its unabridged sentence for the tooltip`, () => {
        const rows = draftReport(
            {
                startedAt: 0,
                steps: [
                    { provider: `gemini`, model: `gemini-3-flash`, status: `skipped`, reason: `usage limit reached` },
                    {
                        provider: `claude`,
                        model: `claude-haiku-4-5-20251001`,
                        status: `refused`,
                        at: 0,
                        ms: 6_000,
                        reason: `Claude usage limit reached — the allowance is exhausted. Try again once it resets.`,
                    },
                ],
                outcome: `failed`,
                finishedAt: 6_000,
            },
            NOW,
        );
        expect(rows.map((row) => row.title)).toEqual([
            `Skipped gemini-3-flash — it refused a moment ago: usage limit reached`,
            `claude-haiku-4-5-20251001 refused after 6s — Claude usage limit reached — the allowance is exhausted. Try again once it resets.`,
        ]);
    });

    /* THE TWO COMPRESSIONS THAT BOUGHT THE ROW ITS WIDTH BACK. A vendor's refusal is a headline followed by the
     * same advice on every rung, and a release stamp is nine characters the reader has no use for — between
     * them they were most of a sidebar-wide line, which is why the fact itself never fit on one. */
    test(`drops the release stamp from the model and the boilerplate from the refusal`, () => {
        const rows = draftReport(
            {
                startedAt: 0,
                steps: [
                    {
                        provider: `gemini`,
                        model: `gemini-3.5-flash-extra-low`,
                        status: `refused`,
                        at: 0,
                        ms: 19_000,
                        reason: `Google usage limit reached — the allowance is exhausted. Try again once it resets.`,
                    },
                    { provider: `claude`, model: `claude-haiku-4-5-20251001`, status: `asking`, at: 19_000 },
                ],
            },
            21_000,
        );
        expect(rows.map((row) => [row.model, row.detail, row.elapsed])).toEqual([
            [`gemini-3.5-flash-extra-low`, `Google usage limit reached`, `19s`],
            [`claude-haiku-4-5`, `asking…`, `2s`],
        ]);
    });

    // No em-dash to cut at, so the first sentence is the headline and the advice behind it goes to the tooltip.
    test(`cuts a reason at its first sentence when there is no dash to cut at`, () => {
        const rows = draftReport(
            {
                startedAt: 0,
                steps: [
                    { provider: `codex`, model: `gpt-5.6`, status: `refused`, at: 0, ms: 1_000, reason: `No capacity right now. Try again shortly.` },
                ],
            },
            NOW,
        );
        expect(rows[0]?.detail).toBe(`No capacity right now`);
    });

    // The in-flight row ticks against the reader's clock — 62 seconds into a silent model, the report says so.
    test(`an in-flight ask shows its elapsed, minutes and all`, () => {
        const rows = draftReport(running([{ provider: `gemini`, model: `gemini-3-flash`, status: `asking`, at: 2_000 }]), 64_000);
        expect(rows.map((row) => [row.status, row.model, row.elapsed])).toEqual([[`asking`, `gemini-3-flash`, `1m 2s`]]);
    });

    // The chain ran dry before any rung refused in words the steps carry — the report's own one-liner closes it.
    test(`a failure the steps don't explain gets the report's own reason as its last row`, () => {
        expect(draftReport({ startedAt: 0, steps: [], outcome: `failed`, reason: `No AI account is connected`, finishedAt: 4_000 }, NOW)).toEqual([
            {
                key: `failed`,
                status: `failed`,
                detail: `No message was written — No AI account is connected`,
                title: `No message was written — No AI account is connected`,
            },
        ]);
    });

    // A chain spent to the bottom already told each refusal in its own row — repeating the joined reasons
    // under it would say less, not more.
    test(`a failure the steps already explain adds nothing under them`, () => {
        const rows = draftReport(
            {
                startedAt: 0,
                steps: [{ provider: `codex`, model: `gpt-5.6`, status: `refused`, at: 0, ms: 3_000, reason: `usage limit reached` }],
                outcome: `failed`,
                reason: `usage limit reached`,
                finishedAt: 3_000,
            },
            NOW,
        );
        expect(rows.map((row) => row.status)).toEqual([`refused`]);
    });
});
