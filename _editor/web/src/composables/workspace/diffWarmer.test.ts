import type { GitChange, RepoChanges } from "@intentic-app/api-contract";
import { describe, expect, it } from "vitest";
import { warmDiffs, warmRows, type WarmRow } from "./diffWarmer";

const change = (path: string): GitChange => ({ path, status: `modified`, additions: 1, deletions: 0 });

const repo = (name: string, sides: Partial<Pick<RepoChanges, "conflicted" | "staged" | "unstaged" | "error">> = {}): RepoChanges => ({
    repo: name,
    conflicted: [],
    staged: [],
    unstaged: [],
    ...sides,
});

// Every step is released by hand, so the walk's pacing is asserted rather than waited out.
const stepwise = (): { idle: () => Promise<void>; step: () => Promise<void> } => {
    let release: (() => void) | undefined;
    return {
        idle: () =>
            new Promise<void>((resolve) => {
                release = resolve;
            }),
        // A macrotask, so every microtask the released step queues (the read, its settle handler) has run by the
        // time the assertion after it does.
        step: async () => {
            release?.();
            release = undefined;
            await new Promise((resolve) => setTimeout(resolve, 0));
        },
    };
};

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

    it(`carries a path that is staged AND edited again as both of its rows`, () => {
        const rows = warmRows([repo(`root`, { staged: [change(`a.ts`)], unstaged: [change(`a.ts`)] })]);
        expect(rows.map((row) => row.side)).toEqual([`staged`, `unstaged`]);
    });

    it(`skips a repo git could not scan and caps how far it reads`, () => {
        const many = Array.from({ length: 40 }, (_, index) => change(`file-${index}.ts`));
        const rows = warmRows([repo(`torn`, { error: `not a git repository` }), repo(`root`, { unstaged: many })], 5);
        expect(rows).toHaveLength(5);
        expect(rows.every((row) => row.repo === `root`)).toBe(true);
    });
});

describe(`warmDiffs`, () => {
    const rows: readonly WarmRow[] = [
        { repo: `root`, path: `a.ts`, side: `unstaged` },
        { repo: `root`, path: `b.ts`, side: `unstaged` },
        { repo: `root`, path: `c.ts`, side: `unstaged` },
    ];

    it(`reads one row at a time, each behind an idle beat`, async () => {
        const { idle, step } = stepwise();
        const read: WarmRow[] = [];
        void warmDiffs(rows, async (row) => void read.push(row), { stopped: () => false, idle });

        await Promise.resolve();
        expect(read).toEqual([]); // waiting for the browser, not reading

        await step();
        expect(read).toHaveLength(1);
        await step();
        expect(read).toHaveLength(2);
    });

    it(`abandons the walk the moment the list moves under it`, async () => {
        const { idle, step } = stepwise();
        const read: WarmRow[] = [];
        let current = true;
        const walk = warmDiffs(rows, async (row) => void read.push(row), { stopped: () => !current, idle });

        await step();
        expect(read).toHaveLength(1);
        current = false;
        await step();

        expect(await walk).toHaveLength(1);
        expect(read).toHaveLength(1);
    });

    it(`carries on past a row that failed, and leaves it uncounted`, async () => {
        const { idle, step } = stepwise();
        const walk = warmDiffs(rows, (row) => (row.path === `a.ts` ? Promise.reject(new Error(`daemon said no`)) : Promise.resolve()), {
            stopped: () => false,
            idle,
        });

        await step();
        await step();
        await step();

        expect((await walk).map((row) => row.path)).toEqual([`b.ts`, `c.ts`]);
    });
});
