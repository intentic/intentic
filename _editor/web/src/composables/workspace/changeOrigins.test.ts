import type { GitChange, RepoChanges } from "@intentic-app/api-contract";
import { describe, expect, test } from "vitest";
import { commitMessageOf, landedMessage, ORIGIN_HUES, originHue, originsOf, summarizeOrigins } from "./changeOrigins";

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
