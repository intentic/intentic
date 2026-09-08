import { HISTORY_ROOT } from "@intentic/constants";
import type { TranscriptRow } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import { PersistedAgentSchema, type PersistedAgent } from "../registry/agents-store.js";
import { fleetMessages, fleetRecall, fleetRoster, resolveHandle, type FleetRecallDeps } from "./fleet-recall.js";

// Pins the five spellings a handle can resolve through (id, branch, session id, prefix, title) and their order: an
// exact identity always wins over a fuzzy match.

// Built through the schema, not by hand, so a fixture cannot drift from what the store actually persists.
const agentOf = (fields: Partial<PersistedAgent> & Pick<PersistedAgent, "id">): PersistedAgent =>
    PersistedAgentSchema.parse({
        provider: "claude",
        harness: "native",
        repos: [{ repo: "root", base: "a".repeat(40) }],
        status: "idle",
        costUsd: 0,
        inputTokens: 0,
        outputTokens: 0,
        createdAt: 1,
        updatedAt: 2,
        ...fields,
    });

// Fixture over a fixed roster; only the registry half matters for resolution, the rest serves the digest tests below.
const depsOver = (entries: readonly PersistedAgent[], messages: Record<string, TranscriptRow[]> = {}): FleetRecallDeps =>
    ({
        agents: {
            ids: () => entries.map((entry) => entry.id),
            entry: (id: string) => entries.find((entry) => entry.id === id),
            get: (id: string) => {
                const found = entries.find((entry) => entry.id === id);
                return found === undefined ? undefined : { status: found.status };
            },
            running: () => false,
            sessionIdOf: (id: string) => entries.find((entry) => entry.id === id)?.sessionId,
        },
        agentWorktrees: { conversationDir: (id: string) => `/history/worktrees/${id}` },
        transcripts: { read: async (agent: { id: string }) => messages[agent.id] ?? [] },
        saidIndex: { search: async () => new Map(), indexing: () => false },
    }) as unknown as FleetRecallDeps;

const ROSTER = [
    agentOf({ id: "fair-sage-ey2r", branch: "agent/fair-sage-ey2r", title: "Last-commit pipeline autoopen", sessionId: "b3366e2e", updatedAt: 300 }),
    agentOf({ id: "fair-sage-other", branch: "agent/fair-sage-other", title: "Pipeline autoopen follow-up", updatedAt: 200 }),
    agentOf({ id: "clear-marsh-8c46", branch: "agent/clear-marsh-8c46", title: "npm publish workflow", updatedAt: 100 }),
];

test("every spelling of a conversation resolves to it: id, branch, session id, prefix, title", () => {
    const deps = depsOver(ROSTER);
    for (const handle of ["fair-sage-ey2r", "agent/fair-sage-ey2r", "b3366e2e", "clear-marsh"]) {
        const resolved = resolveHandle(deps, handle);
        expect(resolved.kind, handle).toBe("found");
    }
    expect(resolveHandle(deps, "fair-sage-ey2r")).toMatchObject({ entry: { id: "fair-sage-ey2r" } });
    expect(resolveHandle(deps, "agent/fair-sage-ey2r")).toMatchObject({ entry: { id: "fair-sage-ey2r" } });
    expect(resolveHandle(deps, "b3366e2e")).toMatchObject({ entry: { id: "fair-sage-ey2r" } });
    expect(resolveHandle(deps, "clear-marsh")).toMatchObject({ entry: { id: "clear-marsh-8c46" } });
    expect(resolveHandle(deps, "npm publish")).toMatchObject({ entry: { id: "clear-marsh-8c46" } });
    // Case-insensitive: a handle is typed from memory.
    expect(resolveHandle(deps, "NPM PUBLISH")).toMatchObject({ entry: { id: "clear-marsh-8c46" } });
});

// Fixture adds `fair-sage-ey2r-2`, a prefix match for the same id, to make ordering matter.
test("an exact identity wins over a prefix that also matches it", () => {
    const deps = depsOver([...ROSTER, agentOf({ id: "fair-sage-ey2r-2", title: "a later branch", updatedAt: 400 })]);
    expect(resolveHandle(deps, "fair-sage-ey2r")).toMatchObject({ kind: "found", entry: { id: "fair-sage-ey2r" } });
});

test("a handle several conversations answer to is named, never picked", () => {
    const resolved = resolveHandle(depsOver(ROSTER), "fair-sage");
    expect(resolved.kind).toBe("ambiguous");
    // Candidates come back newest first.
    expect(resolved.kind === "ambiguous" ? resolved.candidates.map((entry) => entry.id) : []).toEqual(["fair-sage-ey2r", "fair-sage-other"]);
});

test("a handle nothing answers to is unknown, and so is an empty one", () => {
    expect(resolveHandle(depsOver(ROSTER), "nothing-like-this").kind).toBe("unknown");
    expect(resolveHandle(depsOver(ROSTER), "   ").kind).toBe("unknown");
});

test("the roster is newest first, live only, and takes a limit", () => {
    const deps = depsOver([...ROSTER, agentOf({ id: "retired-one", title: "long done", updatedAt: 500, archivedAt: 500 })]);
    expect(fleetRoster(deps).map((row) => row.id)).toEqual(["fair-sage-ey2r", "fair-sage-other", "clear-marsh-8c46"]);
    expect(fleetRoster(deps, { all: true }).map((row) => row.id)[0]).toBe("retired-one");
    expect(fleetRoster(deps, { limit: 1 }).map((row) => row.id)).toEqual(["fair-sage-ey2r"]);
    // Repo filter narrows to conversations whose composition includes it.
    const spanning = depsOver([agentOf({ id: "in-ext", repos: [{ repo: "extensions/pipelines", base: "b".repeat(40) }] }), ...ROSTER]);
    expect(fleetRoster(spanning, { repo: "extensions/pipelines" }).map((row) => row.id)).toEqual(["in-ext"]);
});

const row = (role: TranscriptRow["role"], text: string): TranscriptRow => ({ role, text });

test("the digest keeps the opening prompts, the last word and the last notice, each clamped", async () => {
    const long = "x".repeat(400);
    const deps = depsOver(ROSTER, {
        "fair-sage-ey2r": [
            row("user", "fix the   autoopen\n\n bug"),
            row("assistant", "first answer"),
            row("user", "second ask"),
            row("assistant", long),
            row("user", "third ask"),
            row("user", "fourth ask"),
            row("notice", "Claude usage limit reached."),
        ],
    });
    const recall = await fleetRecall(deps, ROSTER[0] as PersistedAgent, HISTORY_ROOT, { diff: false });
    expect(recall.digest.messages).toBe(7);
    // Whitespace collapsed; at most three prompts, the fourth is available only via --transcript.
    expect(recall.digest.asked).toEqual(["fix the autoopen bug", "second ask", "third ask"]);
    expect(recall.digest.lastSaid?.endsWith("…")).toBe(true);
    expect(recall.digest.lastSaid?.length).toBe(240);
    expect(recall.digest.lastNotice).toBe("Claude usage limit reached.");
    expect(recall.worktree).toBe(`${HISTORY_ROOT}/worktrees/fair-sage-ey2r`);
    expect(recall.record).toBe(`${HISTORY_ROOT}/transcripts/fair-sage-ey2r.jsonl`);
    // `diff: false` skips the git counts; only the registry's landed fact is used.
    expect(recall.repoStates).toEqual([{ repo: "root", base: "a".repeat(40), landed: false }]);
});

test("a conversation with no record digests to nothing rather than failing", async () => {
    const recall = await fleetRecall(depsOver(ROSTER), ROSTER[2] as PersistedAgent, HISTORY_ROOT, { diff: false });
    expect(recall.digest).toEqual({ messages: 0, asked: [] });
});

test("the transcript answers the last messages, and grep narrows before the limit does", async () => {
    const deps = depsOver(ROSTER, {
        "fair-sage-ey2r": [row("user", "one autoopen"), row("assistant", "two"), row("user", "three autoopen"), row("assistant", "four"), row("user", "five")],
    });
    const tail = await fleetMessages(deps, ROSTER[0] as PersistedAgent, { last: 2 });
    expect(tail.total).toBe(5);
    expect(tail.messages.map((message) => message.text)).toEqual(["four", "five"]);
    const grepped = await fleetMessages(deps, ROSTER[0] as PersistedAgent, { grep: "autoopen" });
    expect(grepped.total).toBe(2);
    expect(grepped.messages.map((message) => message.text)).toEqual(["one autoopen", "three autoopen"]);
    // `at` is the message's absolute index in the full record.
    expect(grepped.messages.map((message) => message.at)).toEqual([0, 2]);
});
