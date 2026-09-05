import type { TranscriptRow } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import { PersistedAgentSchema, type PersistedAgent } from "./agents-store.js";
import { fleetMessages, fleetRecall, fleetRoster, resolveHandle, type FleetRecallDeps } from "./fleet-recall.js";

/* HANDLE RESOLUTION is what this surface is for. The conversation that prompted it had `fair-sage-ey2r` in
 * hand — a worktree directory name — and burned thirty-five tool calls failing to turn it into anything,
 * because every surface that could have answered wanted a different spelling of the same conversation. So the
 * five spellings are pinned here, along with the ORDER between them, which is the part a later edit can break
 * without breaking anything that looks like a test: an exact identity must never lose to a fuzzy one. */

// Through the schema, not around it: a fixture built by hand drifts from the shape the registry actually
// stores the moment a field is added, and parse() is the same gate the store puts every loaded entry through.
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

// The seam the module actually uses, over a fixed roster. Only the registry half is exercised by resolution;
// the transcript and worktree halves answer for the capsule tests below.
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
    // A prefix nobody else shares, and words out of a title, both land on the one conversation that has them.
    expect(resolveHandle(deps, "clear-marsh")).toMatchObject({ entry: { id: "clear-marsh-8c46" } });
    expect(resolveHandle(deps, "npm publish")).toMatchObject({ entry: { id: "clear-marsh-8c46" } });
    // Case is not part of a title match: a handle is typed from memory.
    expect(resolveHandle(deps, "NPM PUBLISH")).toMatchObject({ entry: { id: "clear-marsh-8c46" } });
});

/* THE ORDER, and it is load-bearing rather than tidy: `fair-sage-ey2r` is BOTH an exact id and a prefix of
 * nothing else, but if the fuzzy passes ran first a roster holding `fair-sage-ey2r` and `fair-sage-ey2r-2`
 * would make the shorter id unreachable by its own name — the conversation would answer "ambiguous" to the
 * one spelling that is unambiguous by construction. */
test("an exact identity wins over a prefix that also matches it", () => {
    const deps = depsOver([...ROSTER, agentOf({ id: "fair-sage-ey2r-2", title: "a later branch", updatedAt: 400 })]);
    expect(resolveHandle(deps, "fair-sage-ey2r")).toMatchObject({ kind: "found", entry: { id: "fair-sage-ey2r" } });
});

test("a handle several conversations answer to is named, never picked", () => {
    const resolved = resolveHandle(depsOver(ROSTER), "fair-sage");
    expect(resolved.kind).toBe("ambiguous");
    // Newest first, so a truncated list keeps what the caller most likely meant.
    expect(resolved.kind === "ambiguous" ? resolved.candidates.map((entry) => entry.id) : []).toEqual(["fair-sage-ey2r", "fair-sage-other"]);
});

test("a handle nothing answers to is unknown, and so is an empty one", () => {
    expect(resolveHandle(depsOver(ROSTER), "nothing-like-this").kind).toBe("unknown");
    expect(resolveHandle(depsOver(ROSTER), "   ").kind).toBe("unknown");
});

// The roster is a page of the fleet, newest activity first, and the archive is off it by default for the
// board's own reason: a workspace with a thousand retired conversations must still answer "what is happening".
test("the roster is newest first, live only, and takes a limit", () => {
    const deps = depsOver([...ROSTER, agentOf({ id: "retired-one", title: "long done", updatedAt: 500, archivedAt: 500 })]);
    expect(fleetRoster(deps).map((row) => row.id)).toEqual(["fair-sage-ey2r", "fair-sage-other", "clear-marsh-8c46"]);
    expect(fleetRoster(deps, { all: true }).map((row) => row.id)[0]).toBe("retired-one");
    expect(fleetRoster(deps, { limit: 1 }).map((row) => row.id)).toEqual(["fair-sage-ey2r"]);
    // A repo filter narrows to the conversations whose composition spans it, which is how a monorepo asks
    // "who else is in here".
    const spanning = depsOver([agentOf({ id: "in-ext", repos: [{ repo: "extensions/pipelines", base: "b".repeat(40) }] }), ...ROSTER]);
    expect(fleetRoster(spanning, { repo: "extensions/pipelines" }).map((row) => row.id)).toEqual(["in-ext"]);
});

const row = (role: TranscriptRow["role"], text: string): TranscriptRow => ({ role, text });

/* THE DIGEST is the whole economy of `agents show`: it is what makes one call cheaper than the hunt it
 * replaces. So what it keeps is pinned — the opening prompts (the task), the last thing the agent said (where
 * it got to), the last notice (how it ended when it ended badly) — and so is the clamping, because an
 * unclamped prompt is a screenful and the point was to spend less than a screenful. */
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
    const recall = await fleetRecall(deps, ROSTER[0] as PersistedAgent, "/history", { diff: false });
    expect(recall.digest.messages).toBe(7);
    // Whitespace collapsed, three prompts at most, and the fourth is behind --transcript rather than in here.
    expect(recall.digest.asked).toEqual(["fix the autoopen bug", "second ask", "third ask"]);
    expect(recall.digest.lastSaid?.endsWith("…")).toBe(true);
    expect(recall.digest.lastSaid?.length).toBe(240);
    expect(recall.digest.lastNotice).toBe("Claude usage limit reached.");
    // The pointers the hunt was assembling by hand: where the branch is checked out, and where the record is.
    expect(recall.worktree).toBe("/history/worktrees/fair-sage-ey2r");
    expect(recall.record).toBe("/history/transcripts/fair-sage-ey2r.jsonl");
    // `diff: false` is the registry-only answer: the landed fact is free, the git counts are not asked for.
    expect(recall.repoStates).toEqual([{ repo: "root", base: "a".repeat(40), landed: false }]);
});

test("a conversation with no record digests to nothing rather than failing", async () => {
    const recall = await fleetRecall(depsOver(ROSTER), ROSTER[2] as PersistedAgent, "/history", { diff: false });
    expect(recall.digest).toEqual({ messages: 0, asked: [] });
});

/* THE RECORD ITSELF answers the LAST turns by default, not the first: a conversation is looked up for where
 * it got to far more often than for how it opened, and the opening is already in the digest above it. */
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
    // The index rides along, so a caller reading a tail knows where in the record it sits.
    expect(grepped.messages.map((message) => message.at)).toEqual([0, 2]);
});
