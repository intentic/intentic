import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent } from "@intentic/sandbox-contract/events/agent-events";
import { unstubbed } from "@intentic/testing";
import type { Services } from "../../../composition.js";
import type { ConversationWorktree } from "../../../conversations/worktrees/worktrees.js";
import { testConfig } from "../../../env.config.testing.js";
import { collect } from "../../../harness/route-client.testing.js";
import { gitOut, realCheckout } from "../../../harness/route-fakes.testing.js";
import { recordingTurnStores, services } from "../../../harness/route-services.testing.js";
import { COMMAND_RUNS_FILE } from "../../../logs/log-files.js";
import type { CommandRunLine } from "../../../logs/command-runs-log.js";
import { logsRoot } from "../../../seams/logs-root.js";
import { streamAgent } from "../stream-agent.js";

// A runner turn settled on the parent: the parent's own path (streamAgent through the runner placement), with only the
// runner's end replaced by the frames a runner relays, so every record lands in the parent's stores as a local turn's.

// What the runner relays for the turn under test; the dispatch below hands it over as the relay would. `delivered` is
// what the runner's branch brings into the mirror, which the dispatch delivers before it relays the turn's `done`.
let relayed: readonly AgentEvent[] = [];
let delivered = new Map<string, string>();
jest.mock("../placement/runner-child-note.js", () => ({
    async *dispatchToRunner (_services: unknown, _input: unknown, _runner: unknown, worktree: ConversationWorktree): AsyncGenerator<AgentEvent> {
        for (const frame of relayed) {
            if (frame.kind === "done") {
                await deliver(worktree.cwd);
            }
            yield frame;
        }
    },
}));

// The runner's commit of what its turn left, landed in the mirror as advanceMirror leaves it.
const deliver = async (mirror: string): Promise<void> => {
    if (delivered.size === 0) {
        return;
    }
    for (const [path, text] of delivered) {
        await mkdir(join(mirror, path, ".."), { recursive: true });
        await writeFile(join(mirror, path), text);
    }
    await gitOut(mirror, "add", "-A");
    await gitOut(mirror, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "runner: what the turn left");
};

const tempDirs: string[] = [];
afterEach(async () => {
    relayed = [];
    delivered = new Map();
    for (const dir of tempDirs.splice(0)) {
        await rm(dir, { recursive: true, force: true });
    }
});

// The parent's services, every turn record caught, its history (where the command record goes) in a folder of its own.
const parent = async (id: string) => {
    const made = await realCheckout(id);
    const historyRoot = await mkdtemp(join(tmpdir(), "runner-settle-history-"));
    tempDirs.push(made.root, historyRoot);
    const recorded = recordingTurnStores();
    const s = services({
        ...recorded.overrides,
        config: { ...testConfig, historyRoot },
        git: { sync: async () => ({ status: "current" }) },
        agentWorktrees: made.worktrees,
        runners: unstubbed<Services["runners"]>("runners", { enrolled: async () => true }),
    });
    return { s, writes: recorded.writes, historyRoot };
};

// A runner's whole turn as it relays it: attributed to the account this sandbox lent, a command that failed, an edit
// proved by a check after it, a push, the allowance it read, and its bill.
const runnerTurn = (root: string): AgentEvent[] => [
    { kind: "session", sessionId: "s-remote", account: "lent" },
    { kind: "init", model: "claude-opus-4-1" },
    { kind: "plan", text: "edit, then test", requestId: "p-1" },
    { kind: "delta", text: "on it" },
    { kind: "tool_call", id: "x", name: "Bash", category: "execute", status: "in_progress", target: "cargo build" },
    { kind: "tool_call_update", id: "x", status: "failed", exitCode: 101, content: [{ type: "text", text: "error[E0425]: cannot find value `x`\n--- [exit 101, 1s]" }] },
    { kind: "tool_call", id: "e", name: "Edit", category: "edit", status: "completed", locations: [{ path: join(root, "app.ts") }] },
    { kind: "tool_call", id: "t", name: "Bash", category: "execute", status: "in_progress", target: "pnpm test" },
    { kind: "tool_call_update", id: "t", status: "completed", content: [{ type: "text", text: "--- [exit 0, 1s]" }] },
    { kind: "tool_call", id: "g", name: "Bash", category: "execute", status: "in_progress", target: "git push origin agent/feature" },
    { kind: "tool_call_update", id: "g", status: "completed", content: [{ type: "text", text: "--- [exit 0, 1s]" }] },
    { kind: "account_usage", account: "lent", windows: [{ kind: "five_hour", utilization: 0.4, resetsAt: 2_000_000, gates: "all" }] },
    { kind: "usage", account: "lent", costUsd: 0.25, inputTokens: 1_000, outputTokens: 200, numTurns: 3, durationMs: 4_000 },
    { kind: "done" },
];

test("a runner turn lands its ledger row, activity rows, command record, proof, reach and allowance re-read on the parent", async () => {
    const { s, writes, historyRoot } = await parent("runner-settled");
    relayed = runnerTurn(s.workspace.root);

    const frames = await collect(
        streamAgent(s, { prompt: "fix the parser", conversationId: "runner-settled", placement: { kind: "runner", id: "r-1" } }, undefined),
    );

    // The relay is passed on whole: settling it changes no frame.
    expect(frames.slice(-relayed.length)).toStrictEqual([...relayed]);
    expect(writes.usage).toHaveLength(1);
    expect(writes.usage[0]).toMatchObject({
        provider: "claude",
        account: "lent",
        model: "claude-opus-4-1",
        harness: "native",
        runtime: "claude-code",
        outcome: "ok",
        conversationId: "runner-settled",
        sessionId: "s-remote",
        turns: 3,
        inputTokens: 1_000,
        outputTokens: 200,
        costUsd: 0.25,
        durationMs: 4_000,
        verification: "verified",
        check: "pnpm test",
        filesEdited: 1,
    });
    const turnId = writes.usage[0]?.turnId;
    expect(turnId).toEqual(expect.any(String));
    // One turn's rows, joined by its id and stamped with the lent account.
    expect(writes.activity.map((row) => row.type)).toStrictEqual(["turn.started", "turn.plan", "turn.completed"]);
    expect(writes.activity.every((row) => row.turnId === turnId && row.account === "lent" && row.conversationId === "runner-settled")).toBe(true);
    // The allowance the runner read is filed under the lent account, and the turn's settle re-reads that account.
    expect(writes.headroomRecords).toMatchObject([{ provider: "claude", account: "lent", usage: { windows: [{ kind: "five_hour", utilization: 0.4 }] } }]);
    expect(writes.headroomRefreshes).toContainEqual({ scope: { providers: ["claude"], account: "lent" }, maxAgeMs: 10_000 });
    // The answer settles what the lent account was refused before it.
    expect(writes.refusalsCleared).toContainEqual(expect.objectContaining({ provider: "claude", account: "lent", model: "claude-opus-4-1" }));
    // Proof and reach on the parent's card.
    expect(s.agents.entry("runner-settled")?.proof).toMatchObject({ verification: "verified", check: "pnpm test" });
    expect(s.agents.entry("runner-settled")?.reach).toMatchObject({ published: [{ remote: "origin", branch: "agent/feature" }] });
    // The command record: the failure, then the turn's line.
    // SAFETY: every line of the record is one appendCommandRuns wrote, which writes only CommandRunLine values.
    const lines = (await readFile(join(logsRoot(historyRoot), COMMAND_RUNS_FILE), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as CommandRunLine);
    expect(lines).toMatchObject([
        { kind: "failure", conversationId: "runner-settled", turnId, program: "cargo build", exit: 101, runtime: "claude-code", model: "claude-opus-4-1" },
        { kind: "turn", conversationId: "runner-settled", turnId, failed: 1, ran: { "git push": 1, "pnpm test": 1 } },
    ]);
});

// The dispatch ran nothing there (offline, or the runner's sync failed and a child goes on here): no record of a turn,
// so the turn that does run here instead is the only one on the books.
test("a dispatch the runner never ran settles nothing on the parent", async () => {
    const { s, writes } = await parent("runner-never-ran");
    relayed = [{ kind: "error", message: "Preparing the runner's workspace failed: no disk. Nothing ran there." }, { kind: "done" }];

    await collect(streamAgent(s, { prompt: "go", conversationId: "runner-never-ran", placement: { kind: "runner", id: "r-1" } }, undefined));

    expect(writes.usage).toStrictEqual([]);
    expect(writes.activity).toStrictEqual([]);
    expect(writes.headroomRefreshes).toStrictEqual([]);
    expect(s.agents.entry("runner-never-ran")?.proof).toBeUndefined();
});

// The link dropped as the turn was sent: the relay's own frames say so (runner-relay.ts), and the runner ran nothing, so
// the parent files no turn, and the resend is the only one on the books.
test("a turn the link lost before the runner took it settles nothing on the parent", async () => {
    const { s, writes } = await parent("runner-link-lost");
    relayed = [
        { kind: "agent_status", key: "runner-link", text: "Reconnecting to the runner…" },
        { kind: "agent_notice", level: "warning", text: "The runner's link dropped." },
        { kind: "agent_status", key: "runner-link", text: null },
        { kind: "error", message: "The turn never reached the runner. Nothing ran there." },
        { kind: "done" },
    ];

    await collect(streamAgent(s, { prompt: "go", conversationId: "runner-link-lost", placement: { kind: "runner", id: "r-1" } }, undefined));

    expect(writes.usage).toStrictEqual([]);
    expect(writes.activity).toStrictEqual([]);
    expect(writes.headroomRefreshes).toStrictEqual([]);
    expect(s.agents.entry("runner-link-lost")?.proof).toBeUndefined();
});

// A failure's hold is decided where the runner's frame arrives (remote-failure.ts); the settle holds nothing and does
// not reset the stop ladder, while the ledger still files the failed turn.
test("a runner turn that failed is filed as an error, with the hold left to the relay", async () => {
    const { s, writes } = await parent("runner-failed");
    relayed = [
        { kind: "session", sessionId: "s-f", account: "lent" },
        { kind: "delta", text: "starting" },
        { kind: "error", code: "provider-outage", message: "the provider is down" },
        { kind: "done" },
    ];

    await collect(streamAgent(s, { prompt: "go", conversationId: "runner-failed", placement: { kind: "runner", id: "r-1" } }, undefined));

    expect(writes.usage).toMatchObject([{ outcome: "error", errorCode: "provider-outage", account: "lent", conversationId: "runner-failed" }]);
    expect(writes.activity.map((row) => row.type)).toStrictEqual(["turn.started", "turn.error", "turn.completed"]);
});

// A turn that edits only by shell: no edit call names the file, and the runner's delivered branch is what says it.
describe("a runner turn that edits only through the shell", () => {
    const shellTurn = (last: AgentEvent[]): AgentEvent[] => [
        { kind: "session", sessionId: "s-sh", account: "lent" },
        { kind: "delta", text: "rewriting it" },
        { kind: "tool_call", id: "s", name: "Bash", category: "execute", status: "in_progress", target: "sed -i s/one/two/ src/parse.ts" },
        { kind: "tool_call_update", id: "s", status: "completed", content: [{ type: "text", text: "--- [exit 0, 1s]" }] },
        ...last,
        { kind: "usage", account: "lent", costUsd: 0.1, inputTokens: 10, outputTokens: 5 },
        { kind: "done" },
    ];

    test("reads the delivered file as edited, proven by the check that ran last", async () => {
        const { s, writes } = await parent("runner-shell");
        delivered = new Map([["src/parse.ts", "two\n"]]);
        relayed = shellTurn([
            { kind: "tool_call", id: "t", name: "Bash", category: "execute", status: "in_progress", target: "pnpm test" },
            { kind: "tool_call_update", id: "t", status: "completed", content: [{ type: "text", text: "--- [exit 0, 1s]" }] },
        ]);

        await collect(streamAgent(s, { prompt: "rename it", conversationId: "runner-shell", placement: { kind: "runner", id: "r-1" } }, undefined));

        expect(writes.usage).toMatchObject([{ filesEdited: 1, verification: "verified", check: "pnpm test" }]);
        expect(s.agents.entry("runner-shell")?.proof).toMatchObject({ verification: "verified", check: "pnpm test" });
    });

    test("reads it unproven when no check ran after the command that could have written it", async () => {
        const { s, writes } = await parent("runner-shell-unproven");
        delivered = new Map([["src/parse.ts", "two\n"]]);
        relayed = shellTurn([]);

        await collect(
            streamAgent(s, { prompt: "rename it", conversationId: "runner-shell-unproven", placement: { kind: "runner", id: "r-1" } }, undefined),
        );

        expect(writes.usage).toMatchObject([{ filesEdited: 1, verification: "unproven" }]);
        expect(s.agents.entry("runner-shell-unproven")?.proof).toMatchObject({ verification: "unproven" });
    });

    // A runner that delivered nothing before the stream ended moves no head: the edit calls alone speak, as before.
    test("reads nothing edited when the runner delivered nothing", async () => {
        const { s, writes } = await parent("runner-shell-undelivered");
        relayed = shellTurn([]);

        await collect(
            streamAgent(s, { prompt: "rename it", conversationId: "runner-shell-undelivered", placement: { kind: "runner", id: "r-1" } }, undefined),
        );

        expect(writes.usage).toMatchObject([{ filesEdited: 0, verification: "no-code" }]);
        expect(s.agents.entry("runner-shell-undelivered")?.proof).toBeUndefined();
    });
});
