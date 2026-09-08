import { expect, test, vi } from "vitest";
import { createLogger } from "../logger.js";
import { testConfig } from "../testing.js";
import { backfillSearchIndex, type BackfillSource } from "./search-backfill.js";
import { IN_MEMORY, openSearchIndex } from "./search-index.js";
import type { SpokenLine } from "./transcript-search.js";

const logger = createLogger(testConfig);

const source = (key: string, version: string | undefined, text: string, read?: () => Promise<readonly SpokenLine[]>): BackfillSource => ({
    key,
    version: async () => version,
    lines: read ?? (async () => [{ text, speaker: "user" as const }]),
});

test("indexes what is behind, and skips what is already current", async () => {
    const index = openSearchIndex(IN_MEMORY);
    const first = await backfillSearchIndex(
        index,
        { kind: "conversation", prune: false, sources: [source("c1", "1", "the login redirect"), source("c2", "1", "the changelog")] },
        logger,
    );
    expect(first).toMatchObject({ indexed: 2, skipped: 0, failed: 0 });
    expect(index.search("login", "conversation", false).has("c1")).toBe(true);

    const second = await backfillSearchIndex(
        index,
        {
            kind: "conversation",
            prune: false,
            sources: [
                source("c1", "1", "the login redirect", async () => expect.fail("a current source must not be read")),
                source("c2", "1", "the changelog", async () => expect.fail("a current source must not be read")),
            ],
        },
        logger,
    );
    expect(second).toMatchObject({ indexed: 0, skipped: 2 });
});

test("a moved version re-reads the source and replaces its lines", async () => {
    const index = openSearchIndex(IN_MEMORY);
    await backfillSearchIndex(index, { kind: "conversation", prune: false, sources: [source("c1", "10", "first words")] }, logger);
    await backfillSearchIndex(index, { kind: "conversation", prune: false, sources: [source("c1", "20", "replaced words")] }, logger);

    expect(index.search("replaced words", "conversation", false).has("c1")).toBe(true);
    expect(index.search("first words", "conversation", false).has("c1")).toBe(false);
});

// Pins an empty source as version "none" so it counts as seen and is not re-read every pass.
test("a source with nothing stored is recorded as seen", async () => {
    const index = openSearchIndex(IN_MEMORY);
    await backfillSearchIndex(index, { kind: "conversation", prune: false, sources: [source("c1", undefined, "")] }, logger);
    expect(index.versions("conversation").get("c1")).toBe("none");

    const again = await backfillSearchIndex(index, { kind: "conversation", prune: false, sources: [source("c1", undefined, "")] }, logger);
    expect(again).toMatchObject({ indexed: 0, skipped: 1 });
});

test("a source that throws is skipped and the pass continues", async () => {
    const index = openSearchIndex(IN_MEMORY);
    const outcome = await backfillSearchIndex(
        index,
        {
            kind: "conversation",
            prune: false,
            sources: [
                source("bad", "1", "", async () => {
                    throw new Error("record unreadable");
                }),
                source("good", "1", "still indexed"),
            ],
        },
        logger,
    );

    expect(outcome).toMatchObject({ indexed: 1, failed: 1 });
    expect(index.search("still indexed", "conversation", false).has("good")).toBe(true);
    expect(index.versions("conversation").has("bad")).toBe(false);
});

// Sessions prune because the history list is a window (an out-of-window session's rows are dead weight); conversations
// never do, since a missing one might just be a mid-sweep reload gap, not a deletion.
test("pruning drops unlisted sources for sessions and never for conversations", async () => {
    const index = openSearchIndex(IN_MEMORY);
    await backfillSearchIndex(
        index,
        { kind: "session", prune: true, sources: [source("s1", "1", "old chat"), source("s2", "1", "new chat")] },
        logger,
    );
    const pruned = await backfillSearchIndex(index, { kind: "session", prune: true, sources: [source("s2", "1", "new chat")] }, logger);

    expect(pruned).toMatchObject({ forgotten: 1 });
    expect(index.search("old chat", "session", false).size).toBe(0);
    expect(index.search("new chat", "session", false).has("s2")).toBe(true);

    await backfillSearchIndex(
        index,
        { kind: "conversation", prune: false, sources: [source("c1", "1", "kept"), source("c2", "1", "also kept")] },
        logger,
    );
    const held = await backfillSearchIndex(index, { kind: "conversation", prune: false, sources: [source("c1", "1", "kept")] }, logger);
    expect(held).toMatchObject({ forgotten: 0 });
    expect(index.search("also kept", "conversation", false).has("c2")).toBe(true);
});

// Detached from any single boot, so it must honor abort rather than hold shutdown open mid-sweep.
test("an aborted pass stops where it is", async () => {
    const index = openSearchIndex(IN_MEMORY);
    const controller = new AbortController();
    const read = vi.fn(async () => {
        controller.abort();
        return [{ text: "only the first", speaker: "user" as const }];
    });

    const outcome = await backfillSearchIndex(
        index,
        { kind: "conversation", prune: false, sources: [source("c1", "1", "", read), source("c2", "1", "never reached")] },
        logger,
        controller.signal,
    );

    expect(outcome.indexed).toBe(1);
    expect(index.search("never reached", "conversation", false).size).toBe(0);
});
