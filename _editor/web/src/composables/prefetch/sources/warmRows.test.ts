import type { GitChange, RepoChanges } from "@intentic-app/api-contract";
import { describe, expect, it } from "vitest";
import { warmRows, WARM_LIMIT } from "./warmRows";

/* The order the workspace review is read ahead in — the one rule of that source worth pinning, since everything
 * else about it (the keys, the reads) is shared with the panel by construction. Warming the rows in a DIFFERENT
 * order than the panel draws them would warm the rows the reader reaches last, which is the failure this
 * asserts against and which no type can catch. */

const change = (path: string): GitChange => ({ path, status: `modified`, additions: 1, deletions: 0 });

const repo = (name: string, sides: Partial<Pick<RepoChanges, "conflicted" | "staged" | "unstaged" | "error">> = {}): RepoChanges => ({
    repo: name,
    conflicted: [],
    staged: [],
    unstaged: [],
    ...sides,
});

describe(`warmRows`, () => {
    it(`reads ahead in the order the panel draws — conflicts, staged, unstaged, repo by repo`, () => {
        const rows = warmRows([
            repo(`root`, { staged: [change(`a.ts`)], unstaged: [change(`b.ts`)], conflicted: [change(`c.ts`)] }),
            repo(`intentic`, { unstaged: [change(`d.ts`)] }),
        ]);
        expect(rows).toEqual([
            { repo: `root`, path: `c.ts`, side: `conflicted` },
            { repo: `root`, path: `a.ts`, side: `staged` },
            { repo: `root`, path: `b.ts`, side: `unstaged` },
            { repo: `intentic`, path: `d.ts`, side: `unstaged` },
        ]);
    });

    it(`treats a path that is both staged and edited again as the two rows it is`, () => {
        // Two sides, two different diffs — warming one would leave the other cold behind a row that looks warm.
        const rows = warmRows([repo(`root`, { staged: [change(`a.ts`)], unstaged: [change(`a.ts`)] })]);
        expect(rows).toEqual([
            { repo: `root`, path: `a.ts`, side: `staged` },
            { repo: `root`, path: `a.ts`, side: `unstaged` },
        ]);
    });

    it(`skips a repo git could not scan, and stops at the limit`, () => {
        const many = Array.from({ length: 10 }, (_, index) => change(`file-${index}.ts`));
        const rows = warmRows([repo(`torn`, { error: `not a git repository` }), repo(`root`, { unstaged: many })], 5);
        expect(rows).toHaveLength(5);
        expect(rows.every((row) => row.repo === `root`)).toBe(true);
    });

    it(`bounds a mass rename rather than spending minutes of daemon time on it`, () => {
        const huge = Array.from({ length: WARM_LIMIT + 40 }, (_, index) => change(`file-${index}.ts`));
        expect(warmRows([repo(`root`, { unstaged: huge })])).toHaveLength(WARM_LIMIT);
    });
});
