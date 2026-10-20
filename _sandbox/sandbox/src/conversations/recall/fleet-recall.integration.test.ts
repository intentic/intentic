import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HISTORY_ROOT } from "@intentic/constants";
import type { TranscriptRow } from "@intentic/sandbox-contract/events/transcript";
import type { SessionOwner } from "@intentic/sandbox-contract/schemas/agents";
import { createLogger } from "../../logger.js";
import { conversationEntry } from "../registry/agents-store.testing.js";
import { endingStatus, PersistedAgentSchema, type PersistedAgent, type RepoRecord } from "../registry/agents-store.js";
import { statePath } from "../../state-paths.js";
import { type FleetHandleDeps, resolveFleetHandle } from "./fleet-handles.js";
import { fleetRecall, fleetRoster, resolveHandle, type FleetRecallDeps } from "./fleet-recall.js";
import { fleetMessageDetail, fleetMessages, fleetRows } from "./fleet-transcript.js";

// Pins the five spellings a handle can resolve through (id, branch, session id, prefix, title) and their order: an
// exact identity always wins over a fuzzy match.

// A worktree conversation on `agent/<id>`, named by what these tests read of it. Built through the schema, not by hand,
// so a fixture cannot drift from what the store actually persists.
const agentOf = (fields: {
    readonly id: string;
    readonly title?: string;
    readonly sessionId?: string;
    readonly updatedAt?: number;
    readonly archivedAt?: number;
    readonly repos?: readonly RepoRecord[];
    readonly owner?: SessionOwner;
    readonly startedBy?: string;
}): PersistedAgent =>
    PersistedAgentSchema.parse({
        ...conversationEntry({ id: fields.id, createdAt: 1, updatedAt: fields.updatedAt ?? 2 }),
        placement: { kind: "worktree", branch: `agent/${fields.id}`, repos: fields.repos ?? [{ repo: "root", base: "a".repeat(40) }] },
        identity: fields.startedBy === undefined ? {} : { startedBy: fields.startedBy },
        social: {
            reactions: [],
            ...(fields.title === undefined ? {} : { title: { text: fields.title, source: "derived" } }),
            ...(fields.owner === undefined ? {} : { owner: fields.owner }),
        },
        ...(fields.sessionId === undefined ? {} : { sessionId: fields.sessionId }),
        ...(fields.archivedAt === undefined ? {} : { archivedAt: fields.archivedAt }),
    });

// Fixture over a fixed roster; only the registry half matters for resolution, the rest serves the digest tests below.
const depsOver = (entries: readonly PersistedAgent[], messages: Record<string, TranscriptRow[]> = {}): FleetRecallDeps =>
    ({
        agents: {
            ids: () => entries.map((entry) => entry.id),
            entry: (id: string) => entries.find((entry) => entry.id === id),
            get: (id: string) => {
                const found = entries.find((entry) => entry.id === id);
                return found === undefined ? undefined : { status: endingStatus(found.ending) };
            },
        },
        conversations: {
            running: () => false,
            sessionIdOf: (id: string) => entries.find((entry) => entry.id === id)?.sessionId,
            state: () => undefined,
        },
        agentWorktrees: { conversationDir: (id: string) => `/history/worktrees/${id}` },
        transcripts: { rows: async (agent: { id: string }) => messages[agent.id] ?? [] },
        saidIndex: { search: async () => new Map(), indexing: () => false },
    }) as unknown as FleetRecallDeps;

const FAIR = agentOf({ id: "fair-sage-ey2r", title: "Last-commit pipeline autoopen", sessionId: "b3366e2e-1c2d-4e5f-8a9b-0c1d2e3f4a5b", updatedAt: 300 });
const ROSTER = [
    FAIR,
    agentOf({ id: "fair-sage-other", title: "Pipeline autoopen follow-up", updatedAt: 200 }),
    agentOf({ id: "clear-marsh-8c46", title: "npm publish workflow", updatedAt: 100 }),
];

test("every spelling of a conversation resolves to it: id, branch, session id, prefix, title", () => {
    const deps = depsOver(ROSTER);
    for (const handle of ["fair-sage-ey2r", "agent/fair-sage-ey2r", "b3366e2e-1c2d-4e5f-8a9b-0c1d2e3f4a5b", "clear-marsh"]) {
        const resolved = resolveHandle(deps, handle);
        expect(resolved.kind, handle).toBe("found");
    }
    expect(resolveHandle(deps, "fair-sage-ey2r")).toMatchObject({ entry: { id: "fair-sage-ey2r" } });
    expect(resolveHandle(deps, "agent/fair-sage-ey2r")).toMatchObject({ entry: { id: "fair-sage-ey2r" } });
    expect(resolveHandle(deps, "b3366e2e-1c2d-4e5f-8a9b-0c1d2e3f4a5b")).toMatchObject({ entry: { id: "fair-sage-ey2r" } });
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
    const recall = await fleetRecall(deps, FAIR, HISTORY_ROOT, { diff: false });
    expect(recall.digest.messages).toBe(7);
    // Whitespace collapsed; at most three prompts, the fourth is available only via --transcript.
    expect(recall.digest.asked).toEqual(["fix the autoopen bug", "second ask", "third ask"]);
    expect(recall.digest.lastSaid?.endsWith("…")).toBe(true);
    expect(recall.digest.lastSaid?.length).toBe(240);
    expect(recall.digest.lastNotice).toBe("Claude usage limit reached.");
    expect(recall.worktree).toBe(`${HISTORY_ROOT}/worktrees/fair-sage-ey2r`);
    expect(recall.record).toBe(`${HISTORY_ROOT}/conversations/fair-sage-ey2r/transcript.jsonl.zst`);
    // `diff: false` skips the git counts; only the registry's landed fact is used.
    expect(recall.repoStates).toEqual([{ repo: "root", base: "a".repeat(40), landed: false }]);
});

test("a conversation with no record digests to nothing rather than failing", async () => {
    const recall = await fleetRecall(depsOver(ROSTER), ROSTER[2] as PersistedAgent, HISTORY_ROOT, { diff: false });
    expect(recall.digest).toEqual({ messages: 0, asked: [] });
});

test("the transcript answers the last messages, and grep narrows before the limit does", async () => {
    const deps = depsOver(ROSTER, {
        "fair-sage-ey2r": [
            row("user", "one autoopen"),
            row("assistant", "two"),
            row("user", "three autoopen"),
            row("assistant", "four"),
            row("user", "five"),
        ],
    });
    const tail = await fleetMessages(deps, FAIR, { last: 2 });
    expect(tail.total).toBe(5);
    expect(tail.messages.map((message) => message.text)).toEqual(["four", "five"]);
    const grepped = await fleetMessages(deps, FAIR, { grep: "autoopen" });
    expect(grepped.total).toBe(2);
    expect(grepped.messages.map((message) => message.text)).toEqual(["one autoopen", "three autoopen"]);
    // `at` is the message's absolute index in the full record.
    expect(grepped.messages.map((message) => message.at)).toEqual([0, 2]);
});

test("the roster carries owner and starter, and --owner narrows by any part of the address", () => {
    const deps = depsOver([
        agentOf({ id: "owned-1", owner: { email: "ania@example.com", name: "Ania", since: 5 }, startedBy: "ania@example.com", updatedAt: 300 }),
        agentOf({ id: "owned-2", owner: { email: "bob@example.com", since: 6 }, startedBy: "agent:owned-1", updatedAt: 200 }),
        agentOf({ id: "unowned", startedBy: "token:nightly", updatedAt: 100 }),
    ]);
    const all = fleetRoster(deps);
    expect(all.map((agent) => [agent.id, agent.owner?.email, agent.startedBy])).toEqual([
        ["owned-1", "ania@example.com", "ania@example.com"],
        ["owned-2", "bob@example.com", "agent:owned-1"],
        ["unowned", undefined, "token:nightly"],
    ]);
    expect(fleetRoster(deps, { owner: "ANIA" }).map((agent) => agent.id)).toEqual(["owned-1"]);
    expect(fleetRoster(deps, { owner: "example.com" }).map((agent) => agent.id)).toEqual(["owned-1", "owned-2"]);
    expect(fleetRoster(deps, { owner: "nobody" })).toEqual([]);
});

// How logs, the history list and terminal names shorten a session: its first eight hex digits, and `agent-<those>` with
// the pane's suffix (terminals/agent-b3366e2e-%551.log). Agents met all three and were told nothing answered to them.
test("a session id's first eight hex digits, or a terminal named for it, resolve to its conversation", () => {
    const deps = depsOver(ROSTER);
    for (const handle of ["b3366e2e", "b3366e2e-1c2d", "agent-b3366e2e", "agent-b3366e2e-%551", "agent-b3366e2e-%551.log"]) {
        expect(resolveHandle(deps, handle), handle).toMatchObject({ kind: "found", entry: { id: "fair-sage-ey2r" } });
    }
    expect(resolveHandle(deps, "c4477f3f").kind).toBe("unknown");
});

// A deps whose board summary says what the test needs: the live part of a conversation lives there, not on the entry.
// SAFETY: like depsOver's, a summary holding only the fields recall reads; a read past them fails the test that made it.
const withSummary = (deps: FleetRecallDeps, summary: Record<string, unknown>, running = false): FleetRecallDeps =>
    ({
        ...deps,
        agents: { ...deps.agents, get: (id: string) => ({ ...deps.agents.get(id), attention: {}, ...summary }) },
        conversations: { ...deps.conversations, running: () => running },
    }) as unknown as FleetRecallDeps;

test("spend reads the running turn too, and says when nothing was recorded rather than printing a zero", async () => {
    const ran = PersistedAgentSchema.parse({ ...FAIR, totals: { costUsd: 0, inputTokens: 0, outputTokens: 0, turns: 3, toolUses: 40, subagents: 0 } });
    const recall = async (deps: FleetRecallDeps) => fleetRecall(deps, ran, HISTORY_ROOT, { diff: false });
    expect(await recall(depsOver([ran]))).toMatchObject({ usage: "unrecorded", costUsd: 0, toolUses: 40 });
    // The board's summary adds the turn in flight, which the entry only gets at its settle.
    expect(await recall(withSummary(depsOver([ran]), { costUsd: 1.5, inputTokens: 900, outputTokens: 80, toolUses: 52 }))).toMatchObject({
        usage: "recorded",
        costUsd: 1.5,
        inputTokens: 900,
        toolUses: 52,
    });
    expect(await recall(withSummary(depsOver([ran]), { inputTokens: 900 }))).toMatchObject({ usage: "unpriced" });
    // Nothing run, nothing spent: an honest zero.
    expect(await fleetRecall(depsOver(ROSTER), FAIR, HISTORY_ROOT, { diff: false })).toMatchObject({ usage: "recorded" });
});

test("a live conversation answers what holds it now; one at rest has no now at all", async () => {
    expect((await fleetRecall(depsOver(ROSTER), FAIR, HISTORY_ROOT, { diff: false })).now).toBeUndefined();
    const held = withSummary(depsOver(ROSTER), {
        status: "idle",
        awaitingWake: true,
        watches: [{ id: "w1", note: "CI run 316", intervalSeconds: 60, deadlineAt: 9_000 }],
        jobs: [
            { id: "j1", label: "dev server", session: "s", startedAt: 100, watch: "w1", inputWait: { since: 200, program: "npm" } },
            { id: "j0", label: "old build", session: "s", startedAt: 50, endedAt: 60, exitCode: 0 },
        ],
        limitHeld: true,
        next: { kind: "rerun", at: 7_000_000 },
        limitResetsAt: 7_000,
    });
    expect((await fleetRecall(held, FAIR, HISTORY_ROOT, { diff: false })).now).toEqual({
        awaitingWake: true,
        watches: [{ id: "w1", note: "CI run 316", deadlineAt: 9_000 }],
        jobs: [{ id: "j1", label: "dev server", startedAt: 100, watch: "w1", promptSince: 200 }],
        limit: { held: true, scheduled: true, resetsAt: 7_000 },
    });
    const working = withSummary(
        depsOver(ROSTER),
        { status: "interrupted", startedAt: 1_000, run: "run-9", activity: { tool: "Bash", target: "pnpm test" }, attention: { question: true } },
        true,
    );
    expect((await fleetRecall(working, FAIR, HISTORY_ROOT, { diff: false })).now).toEqual({
        turn: { startedAt: 1_000, run: "run-9", doing: "Bash pnpm test", waitingOn: ["question"] },
    });
});

test("the last notice is dated by the turn it came in, and says how much came after it", async () => {
    const deps = depsOver(ROSTER, {
        "fair-sage-ey2r": [
            { role: "user", text: "first", sentAt: 1_000 },
            { role: "notice", text: "Claude usage limit reached." },
            { role: "user", text: "again", sentAt: 5_000 },
            { role: "assistant", text: "done" },
        ],
    });
    const recall = await fleetRecall(deps, FAIR, HISTORY_ROOT, { diff: false });
    expect(recall.digest).toMatchObject({ lastNotice: "Claude usage limit reached.", lastNoticeSentAt: 1_000, sinceLastNotice: 2 });
});

const ANSWER: TranscriptRow = { role: "assistant", text: "The socket refuses connections." };
const RAN: TranscriptRow[] = [
    { role: "user", text: "why does the daemon die", sentAt: 10 },
    {
        role: "assistant",
        text: "",
        run: "run-1",
        tools: [
            {
                id: "t1",
                name: "Bash",
                category: "execute",
                status: "failed",
                target: "curl --unix-socket /run/front.sock http://x/",
                exitCode: 7,
                startedAt: 1_000,
                endedAt: 3_500,
                content: [{ type: "text", text: "curl: (7) Couldn't connect" }],
            },
            { id: "t2", name: "mcp__omen__manage_sandbox", category: "other", status: "completed", input: '{"op":"restart"}' },
        ],
    },
    ANSWER,
];

test("the line view carries each message's tool calls, and grep reads what they ran", async () => {
    const deps = depsOver(ROSTER, { "fair-sage-ey2r": RAN });
    const whole = await fleetMessages(deps, FAIR);
    // A message that only ran tools is a line too, where it used to be dropped for having no text.
    expect(whole.messages.map((message) => message.at)).toEqual([0, 1, 2]);
    expect(whole.messages[1]?.tools).toEqual(["Bash curl --unix-socket /run/front.sock http://x/", 'mcp__omen__manage_sandbox {"op":"restart"}']);
    const grepped = await fleetMessages(deps, FAIR, { grep: "FRONT.SOCK" });
    expect(grepped.messages.map((message) => message.at)).toEqual([1]);
    // As stored, every field kept and each row numbered by its place in the record.
    const raw = await fleetRows(deps, FAIR, { last: 1 });
    expect(raw).toEqual({ total: 3, rows: [{ ...ANSWER, at: 2 }] });
});

test("one message answers whole: its calls' targets, inputs, exit codes, durations and the head of their output", async () => {
    const deps = depsOver(ROSTER, { "fair-sage-ey2r": RAN });
    const detail = await fleetMessageDetail(deps, FAIR, 1);
    expect(detail).toMatchObject({ at: 1, role: "assistant", run: "run-1", text: "" });
    expect(detail?.calls).toEqual([
        {
            name: "Bash",
            status: "failed",
            target: "curl --unix-socket /run/front.sock http://x/",
            exitCode: 7,
            ms: 2_500,
            output: "curl: (7) Couldn't connect",
            outputChars: 26,
        },
        { name: "mcp__omen__manage_sandbox", status: "completed", input: '{"op":"restart"}' },
    ]);
    expect(await fleetMessageDetail(deps, FAIR, 3)).toBeUndefined();
});

// What only a record outside the registry can answer: a session the conversation has since retired (the activity log
// keeps every turn's), a turn of it, and an in-process subagent's id (the Claude runtime files each under the session
// that started it, and stamps the branch that session ran on).
// SAFETY: depsOver's registry plus the two seams the deeper lookups read, the activity log and the workspace root.
const deepDeps = (workspaceRoot: string, events: readonly Record<string, unknown>[] = []): FleetHandleDeps =>
    ({
        ...depsOver(ROSTER),
        activity: { list: async () => events },
        config: { workspaceRoot },
        logger: createLogger({ logLevel: "silent", logPretty: false, historyRoot: "" }),
    }) as unknown as FleetHandleDeps;

test("a retired session or a turn resolves through the activity log, saying how", async () => {
    const deps = deepDeps("/nowhere", [
        { id: "e1", at: 1, direction: "system", type: "turn.completed", sessionId: "f5804681-0000-4000-8000-000000000000", turnId: "05a08e05-1111-4111-8111-111111111111", conversationId: "clear-marsh-8c46" },
    ]);
    expect(await resolveFleetHandle(deps, "f5804681")).toMatchObject({ kind: "found", entry: { id: "clear-marsh-8c46" }, via: expect.stringContaining("activity log") });
    expect(await resolveFleetHandle(deps, "05a08e05-1111-4111-8111-111111111111")).toMatchObject({ kind: "found", entry: { id: "clear-marsh-8c46" } });
    // What the registry answers is never second-guessed by the log.
    expect(await resolveFleetHandle(deps, "fair-sage-ey2r")).toEqual(resolveHandle(deps, "fair-sage-ey2r"));
    expect((await resolveFleetHandle(deps, "a0a0a0a0")).kind).toBe("unknown");
});

test("an in-process subagent's id resolves to the conversation whose session started it", async () => {
    const root = mkdtempSync(join(tmpdir(), "fleet-handles-"));
    try {
        const project = join(statePath(root, ".intentic/records/sessions/claude/"), "projects", "-work");
        const session = "51a0ba4c-6555-4c23-9903-dccfd27e9fc3";
        mkdirSync(join(project, session, "subagents"), { recursive: true });
        writeFileSync(
            join(project, session, "subagents", "agent-a8afce09da420285a.meta.json"),
            JSON.stringify({ agentType: "Explore", description: "Map the land queue", toolUseId: "call_1" }),
        );
        // A session the conversation no longer runs in, found by the branch every entry of its file carries.
        writeFileSync(join(project, `${session}.jsonl`), `${JSON.stringify({ type: "user", gitBranch: "agent/clear-marsh-8c46", sessionId: session })}\n`);
        const resolved = await resolveFleetHandle(deepDeps(root), "a8afce09da420285a");
        expect(resolved).toMatchObject({ kind: "found", entry: { id: "clear-marsh-8c46" } });
        expect(resolved.kind === "found" ? resolved.via : "").toContain("in-process subagent (Explore: Map the land queue)");
        expect((await resolveFleetHandle(deepDeps(root), "a0000000000000000")).kind).toBe("unknown");
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
