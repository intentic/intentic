import { WORKSPACE_ROOT } from "@intentic/constants";
import type { WorkspaceSearchFrame, WorkspaceSearchGroup } from "@intentic/sandbox-contract/schemas/workspace/workspace-search";
import { streamText, type TextAnswer, type TextQuery, type TextSearch } from "./text-search.js";

// How a text search streams, against a search that finds files on a clock of its own: what is sent ahead of the answer,
// how much of it, and that leaving the stream stops the search.

const QUERY: TextQuery = {
    root: WORKSPACE_ROOT,
    query: "needle",
    literal: true,
    word: false,
    caseSensitive: false,
    ignored: false,
    paths: undefined,
    globs: [],
    notGlobs: [],
    page: { hits: 1_000, files: 2 },
    after: undefined,
};

const groupOf = (path: string): WorkspaceSearchGroup => ({
    path,
    score: 1,
    hits: [{ line: 1, text: "needle", spans: [{ start: 0, end: 6 }], tags: [{ kind: "text" }] }],
});

const ANSWER: TextAnswer = {
    result: {
        mode: "find",
        total: 3,
        files: 3,
        shown: 2,
        groups: [groupOf("a"), groupOf("b")],
        freshness: { state: "fresh", ageMs: 0 },
        truncated: true,
        cursor: "x.2",
    },
    timing: { kept: false, scanMs: 5, firstMs: 1, ceiling: false },
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// Finds `paths` one at a time, `gapMs` apart, then answers; records whether it was told to stop.
const slowSearch = (paths: readonly string[], gapMs: number) => {
    const seen = { aborted: false };
    const search: TextSearch = {
        find: async (_query, signal, onGroup) => {
            for (const path of paths) {
                await sleep(gapMs);
                if (signal?.aborted === true) {
                    seen.aborted = true;
                    throw new Error("stopped");
                }
                onGroup?.(groupOf(path));
            }
            return ANSWER;
        },
    };
    return { search, seen };
};

test("files found are sent ahead of the answer, at most a page of them, and the answer comes last", async () => {
    const { search } = slowSearch(["c", "a", "b"], 60);
    const frames: WorkspaceSearchFrame[] = [];
    let answered: TextAnswer | undefined;
    for await (const frame of streamText(search, QUERY, undefined, (answer) => (answered = answer))) {
        frames.push(frame);
    }
    const provisional = frames.flatMap((frame) => (frame.kind === "groups" ? frame.groups.map((group) => group.path) : []));
    expect(provisional).toEqual(["c", "a"]);
    expect(frames.at(-1)).toEqual({ kind: "done", result: ANSWER.result });
    expect(answered).toBe(ANSWER);
});

test("a search that answers before its first batch is due sends its answer alone", async () => {
    const { search } = slowSearch(["a", "b"], 0);
    const frames: WorkspaceSearchFrame[] = [];
    for await (const frame of streamText(search, QUERY, undefined, () => {})) {
        frames.push(frame);
    }
    expect(frames).toEqual([{ kind: "done", result: ANSWER.result }]);
});

test("leaving the stream stops the search behind it", async () => {
    const { search, seen } = slowSearch(["a", "b", "c", "d"], 60);
    for await (const frame of streamText(search, { ...QUERY, page: { hits: 1_000, files: 10 } }, undefined, () => {})) {
        expect(frame.kind).toBe("groups");
        break;
    }
    await sleep(150);
    expect(seen.aborted).toBe(true);
});

test("a search that fails ends the stream with its error", async () => {
    const search: TextSearch = {
        find: async () => {
            throw new Error("ripgrep: something broke");
        },
    };
    const sent: WorkspaceSearchFrame[] = [];
    const frames = (async () => {
        for await (const frame of streamText(search, QUERY, undefined, () => {})) {
            sent.push(frame);
        }
    })();
    await expect(frames).rejects.toThrow("ripgrep: something broke");
    expect(sent).toEqual([]);
});
