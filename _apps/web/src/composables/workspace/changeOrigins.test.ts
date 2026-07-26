import type { GitChange, RepoChanges } from "@intentic-app/api-contract";
import { describe, expect, test } from "vitest";
import { ORIGIN_HUES, originHue, originsOf, summarizeOrigins } from "./changeOrigins";

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
