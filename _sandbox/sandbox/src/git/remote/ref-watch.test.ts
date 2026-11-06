import { BATCH_MS, conversationOfRef, createRepoBatcher, type RefMove } from "./ref-watch.js";

// The batching rule on owned fake timers; .integration.test.ts covers real git/inotify timing, which is too flaky to
// assert batch counts against.

const batchesOf = (): { batches: string[][]; owners: (readonly string[] | undefined)[]; add: (repo: string, conversation?: string) => void; move: (...moves: RefMove[]) => void } => {
    const batches: string[][] = [];
    const owners: (readonly string[] | undefined)[] = [];
    const batcher = createRepoBatcher((repos, conversations) => {
        batches.push(repos);
        owners.push(conversations);
    });
    return { batches, owners, add: (repo, conversation) => batcher.add({ repo, conversation }), move: batcher.add };
};

afterEach(() => {
    jest.useRealTimers();
});

test("a burst of moves inside one window is announced as a single batch", () => {
    jest.useFakeTimers();
    const { batches, add } = batchesOf();
    add("root");
    add("other");
    jest.advanceTimersByTime(BATCH_MS - 1);
    expect(batches).toHaveLength(0);
    jest.advanceTimersByTime(1);
    expect(batches).toEqual([["other", "root"]]);
});

test("the window opens on the first move and is not reset by later ones", () => {
    jest.useFakeTimers();
    const { batches, add } = batchesOf();
    add("root");
    jest.advanceTimersByTime(BATCH_MS - 10);
    add("root");
    jest.advanceTimersByTime(10);
    expect(batches).toEqual([["root"]]);
});

test("one commit's several writes name the repo once", () => {
    jest.useFakeTimers();
    const { batches, add } = batchesOf();
    // A single commit writes both the loose ref and the reflog, so a duplicate add is the common case.
    add("root");
    add("root");
    jest.advanceTimersByTime(BATCH_MS);
    expect(batches).toEqual([["root"]]);
});

test("the next move after a flush opens a fresh window", () => {
    jest.useFakeTimers();
    const { batches, add } = batchesOf();
    add("root");
    jest.advanceTimersByTime(BATCH_MS);
    add("other");
    jest.advanceTimersByTime(BATCH_MS);
    expect(batches).toEqual([["root"], ["other"]]);
});

test("a quiet window announces nothing at all", () => {
    jest.useFakeTimers();
    const { batches } = batchesOf();
    jest.advanceTimersByTime(BATCH_MS * 4);
    expect(batches).toHaveLength(0);
});

// Every agent's commit writes its own branch in the shared git dir. Said as only its own, a move leaves every other
// conversation's review alone; said as just "root moved", one commit re-read every review on every board.
test("a window of only conversations' own refs names those conversations", () => {
    jest.useFakeTimers();
    const { batches, owners, move } = batchesOf();
    move({ repo: "root", conversation: "c1" }, { repo: "web", conversation: "c2" }, { repo: "root", conversation: "c1" });
    jest.advanceTimersByTime(BATCH_MS);
    expect(batches).toEqual([["root", "web"]]);
    expect(owners).toEqual([["c1", "c2"]]);
});

test("anything else moving in the same window names no conversation at all", () => {
    jest.useFakeTimers();
    const { owners, add } = batchesOf();
    add("root", "c1");
    add("root");
    jest.advanceTimersByTime(BATCH_MS);
    expect(owners).toEqual([undefined]);
});

describe("whose own ref a write moved", () => {
    test.each([
        ["refs/heads/agent/c1", "c1"],
        ["refs/heads/agent/c1.lock", "c1"],
        ["refs/agent/c1", "c1"],
        ["refs/remotes/origin/agent/c1", "c1"],
        ["refs/intentic/carried/c1", "c1"],
        ["refs/intentic/dropped/c1", "c1"],
        ["refs/runner-incoming/c1", "c1"],
        ["refs/runner-delivered/c1", "c1"],
    ])("%s is %s's", (ref, owner) => {
        expect(conversationOfRef(ref)).toBe(owner);
    });

    // The main line, a named branch, the directory that holds agents' branches, and a ref nested under an agent's name
    // are nobody's own: each may move what every review measures against.
    test.each(["HEAD", "logs/HEAD", "packed-refs", "packed-refs.lock", "rebase-merge/done", "refs/heads/main", "refs/heads/agent", "refs/heads/agent/c1/sub", "refs/tags/v1", "refs/remotes/origin/main", "refs/stash"])(
        "%s is nobody's",
        (ref) => {
            expect(conversationOfRef(ref)).toBeUndefined();
        },
    );
});
