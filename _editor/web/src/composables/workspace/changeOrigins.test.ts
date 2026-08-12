import type { GitChange, RepoChanges } from "@intentic-app/api-contract";
import { describe, expect, test } from "vitest";
import { chipMessageNotice, commitMessageOf, landedMessage, ORIGIN_HUES, originHue, originsOf, summarizeOrigins } from "./changeOrigins";

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

    test(`takes the card's copy — it is the one the daemon pushes the moment the sentence exists`, () => {
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

    test(`no message is no message — the box stays the user's to type in`, () => {
        expect(commitMessageOf(undefined)).toBeUndefined();
    });
});

/* EVERY WAY THE CLICK CAN COME BACK WITH NOTHING, and the words for each. They all looked identical before —
 * the list narrowed and the box did not move — which is the report this answers: "it doesn't tell me why". */
describe(`chipMessageNotice`, () => {
    const state = {
        label: `Review panel · audit`,
        yours: false,
        message: undefined as string | undefined,
        drafting: false,
        boxIsYours: false,
    };

    test(`says nothing when no chip is lit — nothing has been asked of the box`, () => {
        expect(chipMessageNotice({ ...state, label: undefined })).toBeUndefined();
    });

    test(`says nothing once the message is in the box, where it speaks for itself`, () => {
        expect(chipMessageNotice({ ...state, message: `fix: cascading markers` })).toBeUndefined();
    });

    test(`names the wait while the sentence is being written`, () => {
        expect(chipMessageNotice({ ...state, drafting: true })).toBe(`Writing a message for Review panel · audit…`);
    });

    test(`says a sentence is never coming when none was written`, () => {
        expect(chipMessageNotice(state)).toBe(`No message was written for Review panel · audit — name the commit yourself`);
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
        expect(chipMessageNotice({ ...state, drafting: true, boxIsYours: true })).toBe(
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
