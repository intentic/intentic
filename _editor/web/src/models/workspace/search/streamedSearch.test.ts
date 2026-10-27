import type {
    WorkspaceSearchFrame,
    WorkspaceSearchGroup,
    WorkspaceSearchResult,
} from "@intentic/sandbox-contract/schemas/workspace/workspace-search";
import { SandboxHttpError } from "../../../client/sandbox/sandboxHttpError";
import { firstTextPages, type SearchCalls, streamingPages } from "./streamedSearch";

// A text search's first page, streamed: what shows while it runs, what replaces it, and the plain search standing in
// where there is no stream to ask.

const groupOf = (path: string): WorkspaceSearchGroup => ({ path, score: 1, hits: [{ line: 1, text: "needle", spans: [], tags: [] }] });
const resultOf = (paths: readonly string[]): WorkspaceSearchResult => ({
    mode: `find`,
    total: paths.length,
    files: paths.length,
    shown: paths.length,
    groups: paths.map(groupOf),
    freshness: { state: `fresh` },
    truncated: false,
});
const INPUT = { query: `needle`, mode: `find` } as const;

async function* framesOf(frames: readonly WorkspaceSearchFrame[]): AsyncGenerator<WorkspaceSearchFrame> {
    for (const frame of frames) {
        yield frame;
    }
}

const callsWith = (stream: SearchCalls[`stream`], asked: string[]): SearchCalls => ({
    stream,
    search: async (input) => {
        asked.push(`search ${input.after ?? `first`}`);
        return resultOf([`plain.ts`]);
    },
});

test("the files found are handed over as they arrive, and the stream's own page is the answer", async () => {
    const asked: string[] = [];
    const first = firstTextPages(
        callsWith(
            async () =>
                framesOf([
                    { kind: `groups`, groups: [groupOf(`b.ts`)] },
                    { kind: `groups`, groups: [groupOf(`a.ts`)] },
                    { kind: `done`, result: resultOf([`a.ts`, `b.ts`]) },
                ]),
            asked,
        ),
    );
    const seen: string[][] = [];
    const page = await first(INPUT, undefined, (groups) => seen.push(groups.map((group) => group.path)));
    expect(seen).toEqual([[`b.ts`], [`a.ts`]]);
    expect(page.groups.map((group) => group.path)).toEqual([`a.ts`, `b.ts`]);
    expect(asked).toEqual([]);
});

test("no stream route (a folder on this computer, an older sandbox) answers plainly, and is not asked again", async () => {
    const asked: string[] = [];
    let streams = 0;
    const first = firstTextPages(
        callsWith(async () => {
            streams += 1;
            throw new SandboxHttpError(404, `not found`);
        }, asked),
    );
    expect((await first(INPUT, undefined, () => {})).groups.map((group) => group.path)).toEqual([`plain.ts`]);
    await first(INPUT, undefined, () => {});
    expect(streams).toBe(1);
    expect(asked).toEqual([`search first`, `search first`]);
});

test("any other refusal is the search's own error", async () => {
    const first = firstTextPages(
        callsWith(async () => {
            throw new SandboxHttpError(400, `bad pattern`);
        }, []),
    );
    await expect(first(INPUT, undefined, () => {})).rejects.toThrow(`bad pattern`);
});

test("what a search has found so far is shown for that search only, and gives way to its page", async () => {
    let release = (): void => {};
    const held = new Promise<void>((resolve) => {
        release = resolve;
    });
    const pages = streamingPages(
        async (_input, _signal, onGroups) => {
            onGroups([groupOf(`b.ts`)]);
            onGroups([groupOf(`a.ts`)]);
            await held;
            return resultOf([`a.ts`, `b.ts`]);
        },
        async () => resultOf([`later.ts`]),
    );
    const answer = pages.pageOf(INPUT, undefined, new AbortController().signal);
    expect(pages.foundFor(INPUT)?.map((group) => group.path)).toEqual([`b.ts`, `a.ts`]);
    expect(pages.foundFor({ ...INPUT, query: `other` })).toBeUndefined();
    release();
    await answer;
    expect(pages.foundFor(INPUT)).toBeUndefined();
    // A later page, and any other kind of search, is one plain answer.
    expect((await pages.pageOf(INPUT, `x.2`, new AbortController().signal)).groups.map((group) => group.path)).toEqual([`later.ts`]);
    expect((await pages.pageOf({ ...INPUT, mode: `q` }, undefined, new AbortController().signal)).groups.map((group) => group.path)).toEqual([
        `later.ts`,
    ]);
});
