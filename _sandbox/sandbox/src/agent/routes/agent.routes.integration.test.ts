import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, test, vi } from "vitest";
import { SETTLES } from "@intentic/testing/vitest";

import { createApp } from "../../app.js";

import { type TranscriptRow, SandboxSettingsSchema } from "@intentic/sandbox-contract";
import { claudeStoreOf } from "../../sessions/session-store.js";
import { conversationExperimentArm } from "../run/turn/turn-plan.js";
import type { AgentWorktrees } from "../../agents/worktrees/worktrees.js";
import { clientFor, collect, errorCode } from "../../harness/route-client.testing.js";
import { codexConnectedProxy, services, withTranslator } from "../../harness/route-services.testing.js";
import { attachedRows, runAgentTurn } from "../../harness/route-turns.testing.js";
import { createRequest } from "../tools/agent-requests.js";

// Exercises the agent routes over the daemon's HTTP surface, as the browser does. Shared fakes and client live in
// route-services.testing.ts and its siblings.

// Real git only for what a land actually touches (checkout, branch, main tree); other worktree lifecycle members stay
// the harness's inert fakes.
const exec = promisify(execFile);
const sh = async (cwd: string, ...args: string[]): Promise<string> => (await exec("git", ["-C", cwd, ...args])).stdout.trim();
const commit = (cwd: string, message: string): Promise<string> => sh(cwd, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", message);
const tempDirs: string[] = [];
afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
        await rm(dir, { recursive: true, force: true });
    }
});

const realCheckout = async (id: string): Promise<{ work: string; worktree: string; worktrees: AgentWorktrees }> => {
    const root = await mkdtemp(join(tmpdir(), "intentic-turn-end-"));
    tempDirs.push(root);
    const work = join(root, "work");
    const worktree = join(root, "worktrees", id);
    await mkdir(work, { recursive: true });
    await sh(work, "init", "-q", "-b", "main");
    await writeFile(join(work, "app.ts"), "line one\n");
    await sh(work, "add", "-A");
    await commit(work, "baseline");
    await sh(work, "worktree", "add", "-q", "-b", `agent/${id}`, worktree, "HEAD");
    const repos = [{ repo: "root", base: await sh(work, "rev-parse", "HEAD") }];
    return {
        work,
        worktree,
        worktrees: {
            conversationDir: () => worktree,
            worktreeDir: () => worktree,
            mainDir: () => work,
            sessionStore: (entry) => claudeStoreOf(work, root, entry),
            exists: async () => true,
            attached: async () => true,
            snapshot: async () => repos,
            ensure: async () => ({ cwd: worktree, branch: `agent/${id}`, repos, fenced: false }),
            remove: async () => {},
            retire: async () => {},
            reapRepoCheckout: async () => {},
            prune: async () => {},
            withRepoLock: (_repo, task) => task(),
            repoBusy: () => false,
        },
    };
};

test("agent.run rejects an empty prompt", async () => {
    const client = clientFor(createApp(services()));
    expect(await errorCode(client.agent.run({ prompt: "" }))).toBe("BAD_REQUEST");
});

test("a second concurrent turn for the same conversation is refused with CONFLICT until the run settles", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const client = clientFor(
        createApp(
            services({
                async *agent() {
                    await gate;
                    yield { kind: "done" };
                },
            }),
        ),
    );
    const { run: first } = await client.agent.run({ prompt: "long task", conversationId: "conv1", isolated: true });
    expect(await errorCode(client.agent.run({ prompt: "again", conversationId: "conv1", isolated: true }))).toBe("CONFLICT");
    release?.();
    const frames = await collect(await client.agent.attach({ conversationId: "conv1" }));
    expect(frames[0]).toMatchObject({ kind: "attached", run: first });
    const { facts } = await runAgentTurn(client, { prompt: "after", conversationId: "conv1", isolated: true });
    expect(facts[0]).toMatchObject({ kind: "worktree" });
});

test("a chat turn without a conversationId is refused: the run registry has nothing to key it on", async () => {
    const client = clientFor(createApp(services()));
    expect(await errorCode(client.agent.run({ prompt: "hi" }))).toBe("BAD_REQUEST");
});

test("isolated requires conversationId at the contract gate", async () => {
    const client = clientFor(createApp(services()));
    expect(await errorCode(client.agent.run({ prompt: "hi", isolated: true }))).toBe("BAD_REQUEST");
});

test("a rate-limited turn is filed as a limit even when the provider's wording is not one this daemon knows", async () => {
    const filed: { kind: string; message: string }[] = [];
    const client = clientFor(
        createApp(
            services({
                async *agent() {
                    yield { kind: "error", code: "rate_limit", message: "429 RESOURCE_EXHAUSTED: no headroom left" };
                    yield { kind: "done" };
                },
                providerRefusals: {
                    read: async () => ({}),
                    record: async (_provider, refusal) => void filed.push({ kind: refusal.kind, message: refusal.message }),
                    clear: async () => {},
                    onChange: () => () => {},
                },
            }),
        ),
    );
    await runAgentTurn(client, { prompt: "keep going", conversationId: "conv-limit" });
    expect(filed).toEqual([{ kind: "limit", message: "429 RESOURCE_EXHAUSTED: no headroom left" }]);
});

test("a spent allowance on a native runtime carries the reset the translator already knew", async () => {
    const reopensAt = Math.floor(Date.now() / 1000) + 7_200;
    const client = clientFor(
        createApp(
            services({
                config: withTranslator,
                cliProxy: { ...codexConnectedProxy, turnLimit: async () => ({ spent: 1, withHeadroom: 0, reopensAt }) },
                // Exactly what codex-agent.ts emits: coded, with nothing else on it to read.
                async *codexAgent() {
                    yield { kind: "error", code: "rate_limit", message: "429 You've hit your usage limit." };
                    yield { kind: "done" };
                },
            }),
        ),
    );

    const { facts } = await runAgentTurn(client, { prompt: "carry on", conversationId: "conv-native-limit", agent: "codex" });

    expect(facts).toContainEqual(
        expect.objectContaining({
            kind: "error",
            code: "rate_limit",
            message: "429 You've hit your usage limit.",
            held: expect.objectContaining({ ran: false }),
            resetsAt: reopensAt,
        }),
    );
});

// The bug behind a picker full of green rings over a model that refuses on sight: the translator picks the credential
// itself and benches each one per MODEL, so a routed refusal is a fact about the model that no account ring can carry.
test("a routed spent allowance benches the model it refused, to the reset the frame resolved", async () => {
    const reopensAt = Math.floor(Date.now() / 1000) + 7_200;
    const filed: { provider: string; model: string; until: number }[] = [];
    const client = clientFor(
        createApp(
            services({
                config: withTranslator,
                cliProxy: { ...codexConnectedProxy, turnLimit: async () => ({ spent: 1, withHeadroom: 0, reopensAt }) },
                modelCooldowns: {
                    cooling: async () => new Map(),
                    record: async (provider, model, cooldown) => void filed.push({ provider, model, until: cooldown.until }),
                },
                async *codexAgent() {
                    yield { kind: "error", code: "rate_limit", message: "429 You've hit your usage limit." };
                    yield { kind: "done" };
                },
            }),
        ),
    );

    await runAgentTurn(client, { prompt: "carry on", conversationId: "conv-model-cooldown", agent: "codex", model: "gpt-5.6-sol" });

    // Epoch seconds on the frame, epoch ms in the store, since this one is read against Date.now().
    expect(filed).toEqual([{ provider: "codex", model: "gpt-5.6-sol", until: reopensAt * 1000 }]);
});

// A native provider's accounts are picked by the daemon, so one account's spent allowance says nothing about the
// sibling's. Benching the model there would take a runnable rung off every account at once.
test("a spent allowance on a natively-picked provider benches no model", async () => {
    const filed: string[] = [];
    const client = clientFor(
        createApp(
            services({
                modelCooldowns: { cooling: async () => new Map(), record: async (_p, model) => void filed.push(model) },
                async *agent() {
                    yield { kind: "error", code: "rate_limit", message: "Claude usage limit reached." };
                    yield { kind: "done" };
                },
            }),
        ),
    );

    await runAgentTurn(client, { prompt: "carry on", conversationId: "conv-native-no-cooldown", agent: "claude", model: "opus" });

    expect(filed).toEqual([]);
});

test("a spent allowance goes out bare when the pool reading names no reset", async () => {
    const client = clientFor(
        createApp(
            services({
                config: withTranslator,
                cliProxy: { ...codexConnectedProxy, turnLimit: async () => ({ spent: 30, withHeadroom: 1 }) },
                async *codexAgent() {
                    yield { kind: "error", code: "rate_limit", message: "429 You've hit your usage limit." };
                    yield { kind: "done" };
                },
            }),
        ),
    );

    const { facts } = await runAgentTurn(client, { prompt: "carry on", conversationId: "conv-cooldown", agent: "codex" });
    const limits = facts.filter((fact) => fact.kind === "error" && fact.code === "rate_limit");

    expect(limits).toHaveLength(1);
    // Absent, not present-and-undefined: the client branches on the field existing at all.
    expect(Object.keys(limits[0]!)).not.toContain("resetsAt");
});

test("a spent allowance holds the turn, and agent.resume runs that same turn again rather than a new message", async () => {
    const seen: { prompt: string; sessionId?: string }[] = [];
    let refuse = true;
    const client = clientFor(
        createApp(
            services({
                async *agent(request) {
                    seen.push({ prompt: request.prompt, ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }) });
                    yield { kind: "session", sessionId: "s-void" };
                    if (refuse) {
                        yield { kind: "error", code: "rate_limit", message: "Claude usage limit reached." };
                    } else {
                        yield { kind: "delta", text: "on it" };
                    }
                    yield { kind: "done" };
                },
            }),
        ),
    );

    const { facts: first } = await runAgentTurn(client, { prompt: "ship the parser", conversationId: "conv-held" });
    expect(first).toContainEqual(expect.objectContaining({ kind: "error", code: "rate_limit", held: expect.objectContaining({ ran: false }) }));

    refuse = false;
    const { run } = await client.agent.resume({ conversationId: "conv-held" });
    const frames = await collect(await client.agent.attach({ conversationId: "conv-held" }));
    expect(frames[0]).toMatchObject({ kind: "attached", run });

    expect(seen).toHaveLength(2);
    // The same request again, in full, behind a note saying why it's here and that nothing was done.
    expect(seen[1]!.prompt).toContain("ship the parser");
    expect(seen[1]!.prompt).toMatch(/no part of the request below/i);
    // Not onto s-void: that session's whole content is the message the provider refused to read.
    expect(seen[1]!.sessionId).toBeUndefined();
    expect(attachedRows(frames).map(({ role, text }) => ({ role, text }))).toContainEqual({ role: "assistant", text: "on it" });
});

// An uncoded death is a hung runtime or a crashed harness: nothing to repair, so the turn is held whole and the press
// is a re-run. Without the hold, the only way on is the word "Continue" typed into somebody's record.
test("a runtime that dies with no code holds the turn too, and the press re-runs it with no word added", async () => {
    const seen: { prompt: string; sessionId?: string }[] = [];
    let die = true;
    const client = clientFor(
        createApp(
            services({
                async *agent(request) {
                    seen.push({ prompt: request.prompt, ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }) });
                    yield { kind: "session", sessionId: "s-real" };
                    yield { kind: "delta", text: "looking" };
                    if (die) {
                        yield { kind: "error", message: "Google turn timed out waiting for OpenCode." };
                    } else {
                        yield { kind: "delta", text: "on it" };
                    }
                    yield { kind: "done" };
                },
            }),
        ),
    );

    const { facts: first } = await runAgentTurn(client, { prompt: "fix the pipeline", conversationId: "conv-stopped" });
    // `ran` is true: the provider answered before it hung, so the session still holds the work.
    expect(first).toContainEqual(expect.objectContaining({ kind: "error", held: expect.objectContaining({ ran: true }) }));

    die = false;
    await client.agent.resume({ conversationId: "conv-stopped" });
    await collect(await client.agent.attach({ conversationId: "conv-stopped" }));

    expect(seen).toHaveLength(2);
    expect(seen[1]!.prompt).toContain("fix the pipeline");
    expect(seen[1]!.prompt).toMatch(/stopped before it finished/i);
    expect(seen[1]!.prompt).not.toMatch(/^Continue$/im);
    // Onto the session that holds what the dead turn managed, rather than starting the work over.
    expect(seen[1]!.sessionId).toBe("s-real");
});

test("a coded failure is not held, since pressing would only meet the same block again", async () => {
    const client = clientFor(
        createApp(
            services({
                async *agent() {
                    yield { kind: "error", code: "context-window-too-small", message: "this model cannot hold the turn" };
                    yield { kind: "done" };
                },
            }),
        ),
    );

    const { facts } = await runAgentTurn(client, { prompt: "fix the pipeline", conversationId: "conv-coded" });
    expect(facts).toContainEqual(expect.objectContaining({ kind: "error", code: "context-window-too-small" }));
    expect(facts.find((fact) => fact.kind === "error")).not.toHaveProperty("held");
    expect(await errorCode(client.agent.resume({ conversationId: "conv-coded" }))).toBe("NOT_FOUND");
});

test("agent.resume answers NOT_FOUND when nothing is held for the conversation", async () => {
    const client = clientFor(
        createApp(
            services({
                async *agent() {
                    yield { kind: "done" };
                },
            }),
        ),
    );
    expect(await errorCode(client.agent.resume({ conversationId: "conv-unheld" }))).toBe("NOT_FOUND");
});

test("dismissing a question ends the turn where the dismissal lands, and settles the card as finished", async () => {
    let raised: ((id: string) => void) | undefined;
    const card = new Promise<string>((resolve) => (raised = resolve));
    const client = clientFor(
        createApp(
            services({
                async *agent(request) {
                    // Exactly what the `ask` tool does: the card names the conversation it parked.
                    const { id, wait } = createRequest("question", { kind: "question", requestId: "", cancelled: true }, request.conversationId);
                    yield { kind: "question", requestId: id, questions: [] };
                    raised?.(id);
                    const { resolved } = await wait(request.signal);
                    yield resolved;
                    yield { kind: "done" };
                },
            }),
        ),
    );
    await client.agent.run({ prompt: "ask me", conversationId: "conv1", isolated: true });
    const requestId = await card;
    const { agents: parked } = await client.agents.list();
    expect(parked[0]).toMatchObject({ status: "awaiting", attention: { question: true } });
    expect(await client.agent.reply({ kind: "question", requestId, cancelled: true })).toEqual({ ok: true });
    const { agents } = await client.agents.list();
    expect(agents[0]).toMatchObject({ id: "conv1", status: "idle", attention: { question: false } });
    expect(await errorCode(client.agent.reply({ kind: "question", requestId, cancelled: true }))).toBe("NOT_FOUND");
});

test("a dismissed question settles the turn's books on the branch, and lands nothing into the main tree", async () => {
    const { work, worktree, worktrees } = await realCheckout("conv1");
    let raised: ((id: string) => void) | undefined;
    const card = new Promise<string>((resolve) => (raised = resolve));
    const client = clientFor(
        createApp(
            services({
                agentWorktrees: worktrees,
                // A real before-state to pin; the one suite that reaches the turn-anchor store.
                turnCheckpoints: { record: async () => {}, of: async () => undefined, all: async () => new Map(), truncate: async () => {} },
                async *agent(request) {
                    await writeFile(join(worktree, "app.ts"), "line one\nthe agent's work\n");
                    const { id, wait } = createRequest("question", { kind: "question", requestId: "", cancelled: true }, request.conversationId);
                    yield { kind: "question", requestId: id, questions: [] };
                    raised?.(id);
                    const { resolved } = await wait(request.signal);
                    yield resolved;
                    yield { kind: "done" };
                },
            }),
        ),
    );
    await client.agent.run({ prompt: "rename Credits?", conversationId: "conv1", isolated: true });
    await client.agent.reply({ kind: "question", requestId: await card, cancelled: true });

    expect(await sh(work, "status", "--porcelain")).toBe("");
    expect(await sh(work, "show", "--name-only", "--format=%s", "agent/conv1")).toContain("app.ts");
    const { agents } = await client.agents.list();
    expect(agents[0]).toMatchObject({ id: "conv1", status: "idle", diff: { files: 1, insertions: 1, deletions: 0 } });
});

test("an isolated turn announces the state its message can be rewound to, and files it under that message", async () => {
    const { worktrees } = await realCheckout("conv-anchor");
    const filed: { index: number; kind: string }[] = [];
    const client = clientFor(
        createApp(
            services({
                agentWorktrees: worktrees,
                turnCheckpoints: {
                    record: async (_id: string, index: number, anchor: { kind: string }) => void filed.push({ index, kind: anchor.kind }),
                    of: async () => undefined,
                    all: async () => new Map(),
                    truncate: async () => {},
                },
                async *agent() {
                    yield { kind: "done" };
                },
            }),
        ),
    );

    const { rows } = await runAgentTurn(client, { prompt: "start it", conversationId: "conv-anchor", isolated: true });

    expect(rows[0]).toMatchObject({ role: "user", text: "start it", checkpointId: "worktree:0" });
    expect(filed).toEqual([{ index: 0, kind: "worktree" }]);
});

test("a steer taken mid-turn lands in the run's frames, and in the record, between what came before and the answer", async () => {
    let taken: (() => void) | undefined;
    const delivered = new Promise<void>((resolve) => (taken = resolve));
    let running: (() => void) | undefined;
    const started = new Promise<void>((resolve) => (running = resolve));
    const recorded: TranscriptRow[] = [];
    // Spreads the transcripts fake rather than replacing it; a shallow override missing members fails first.
    const { transcripts } = services({});
    const client = clientFor(
        createApp(
            services({
                transcripts: { ...transcripts, append: async (_agent, messages) => void recorded.push(...messages) },
                async *agent() {
                    yield { kind: "delta", text: "on it" };
                    // Yielding has handed that frame to the pump, so the steer below cannot land ahead of it.
                    running?.();
                    await delivered;
                    yield { kind: "delta", text: "will do" };
                    yield { kind: "done" };
                },
            }),
        ),
    );

    await client.agent.run({ prompt: "ship it", conversationId: "conv-steer", isolated: true });
    await started;
    expect(await client.agent.steer({ conversationId: "conv-steer", text: "and the tests" })).toEqual({ ok: true });
    taken?.();

    const [head] = await collect(await client.agent.attach({ conversationId: "conv-steer" }));
    expect(head?.kind === "attached" ? head.rows.map(({ role, text }) => ({ role, text })) : undefined).toEqual([
        { role: "user", text: "ship it" },
        { role: "assistant", text: "on it" },
        { role: "user", text: "and the tests" },
        { role: "assistant", text: "will do" },
    ]);
    await vi.waitFor(() => expect(recorded).not.toHaveLength(0), SETTLES);
    expect(recorded.filter((row) => row.role !== "notice").map(({ role, text }) => ({ role, text }))).toEqual([
        { role: "user", text: "ship it" },
        { role: "assistant", text: "on it" },
        { role: "user", text: "and the tests" },
        { role: "assistant", text: "will do" },
    ]);
});

test("a turn that fails before the provider bills anything still lands on the ledger, with its code and its sentence", async () => {
    const ledger: Record<string, unknown>[] = [];
    const client = clientFor(
        createApp(
            services({
                async *agent() {
                    yield { kind: "error", code: "claude-not-entitled", message: "Claude Code is not enabled for this organization" };
                    yield { kind: "done" };
                },
                usage: { record: async (turn) => void ledger.push(turn) },
            }),
        ),
    );
    await runAgentTurn(client, { prompt: "go", conversationId: "conv-failed" });

    await vi.waitFor(() => expect(ledger).toHaveLength(1), SETTLES);
    expect(ledger[0]).toMatchObject({
        outcome: "error",
        errorCode: "claude-not-entitled",
        errorMessage: "Claude Code is not enabled for this organization",
        turns: 0,
        costUsd: 0,
    });
    // Absent, not zero: a turn that died before any content has no search count to report.
    expect("searchCalls" in (ledger[0] ?? {})).toBe(false);
});

test("a turn that succeeds is recorded as such, with the experiment metrics it earned", async () => {
    const ledger: Record<string, unknown>[] = [];
    const client = clientFor(
        createApp(
            services({
                async *agent() {
                    yield { kind: "delta", text: "done" };
                    yield { kind: "usage", costUsd: 0.5, inputTokens: 10, outputTokens: 20 };
                    yield { kind: "done" };
                },
                usage: { record: async (turn) => void ledger.push(turn) },
            }),
        ),
    );
    await runAgentTurn(client, { prompt: "go", conversationId: "conv-ok" });

    await vi.waitFor(() => expect(ledger).toHaveLength(1), SETTLES);
    expect(ledger[0]).toMatchObject({ outcome: "ok", costUsd: 0.5, searchCalls: 0, openingSearches: 0 });
    // Nothing failed, so there is no code and no sentence to carry.
    expect("errorCode" in (ledger[0] ?? {})).toBe(false);
    expect("errorMessage" in (ledger[0] ?? {})).toBe(false);
});

// What cost the field-notes experiment every sample it had drawn: planning stamped an arm per turn and the append
// copied the stamps it knew by name, so a stamp added to planning alone was measured and then dropped on the floor.
test("an arm planning drew rides the ledger row without the append naming the field", async () => {
    const ledger: Record<string, unknown>[] = [];
    const client = clientFor(
        createApp(
            services({
                async *agent() {
                    yield { kind: "delta", text: "done" };
                    yield { kind: "usage", costUsd: 0.5, inputTokens: 10, outputTokens: 20 };
                    yield { kind: "done" };
                },
                usage: { record: async (turn) => void ledger.push(turn) },
                sandboxSettings: { get: async () => SandboxSettingsSchema.parse({ fieldNotes: true, fieldNotesHoldout: 0.5 }) },
            }),
        ),
    );
    await runAgentTurn(client, { prompt: "go", conversationId: "conv-notes" });

    await vi.waitFor(() => expect(ledger).toHaveLength(1), SETTLES);
    // The arm this id draws, from the same function planning draws it with: a transcribed `true` would also pass
    // against a row carrying the opposite arm.
    expect(ledger[0]).toMatchObject({ notesArm: conversationExperimentArm("field-notes", "conv-notes", 0.5), turnIndex: 0 });
});

// Whether the work was checked, folded off the generic frame stream, so a Codex or Cursor turn is judged the same way a
// Claude turn is.
const editFrame = (id: string, path: string) => ({
    kind: "tool_call" as const,
    id,
    name: "Edit",
    category: "edit" as const,
    status: "completed" as const,
    locations: [{ path }],
});
const checkFrame = (id: string, command: string) => ({
    kind: "tool_call" as const,
    id,
    name: "Bash",
    category: "execute" as const,
    status: "in_progress" as const,
    target: command,
});
const checkResult = (id: string, text: string) => ({
    kind: "tool_call_update" as const,
    id,
    status: "completed" as const,
    content: [{ type: "text" as const, text }],
});
// Read-only: its category keeps it out of the edit ledger, which the silent-ending tests below turn on.
const readFrame = (id: string, path: string) => ({
    kind: "tool_call" as const,
    id,
    name: "Read",
    category: "read" as const,
    status: "completed" as const,
    locations: [{ path }],
});

test("a turn that proved its edits is recorded as verified, naming the check that spoke", async () => {
    const ledger: Record<string, unknown>[] = [];
    const client = clientFor(
        createApp(
            services({
                async *agent() {
                    yield editFrame("1", "/work/src/parser.ts");
                    yield checkFrame("2", "pnpm test src/parser.test.ts");
                    yield checkResult("2", "2 passed\n--- [exit 0, 3s]");
                    yield { kind: "usage", costUsd: 0.2 };
                    yield { kind: "done" };
                },
                usage: { record: async (turn) => void ledger.push(turn) },
            }),
        ),
    );
    await runAgentTurn(client, { prompt: "fix the parser", conversationId: "conv-verified" });

    await vi.waitFor(() => expect(ledger).toHaveLength(1), SETTLES);
    // The command matters: 'verified' alone would read as the whole repo being green, not one file.
    expect(ledger[0]).toMatchObject({ outcome: "ok", verification: "verified", check: "pnpm test src/parser.test.ts", filesEdited: 1 });
});

test("a turn that stopped talking is recorded as such: unproven edits, its own checklist still open", async () => {
    const ledger: Record<string, unknown>[] = [];
    const client = clientFor(
        createApp(
            services({
                async *agent() {
                    yield {
                        kind: "todos",
                        items: [
                            { content: "read the parser", status: "completed" },
                            { content: "fix the parser", status: "in_progress" },
                            { content: "test it", status: "pending" },
                        ],
                    };
                    yield editFrame("1", "/work/src/parser.ts");
                    yield { kind: "compact", trigger: "auto", preTokens: 180_000, postTokens: 40_000 };
                    yield { kind: "context_usage", tokens: 148_000, contextWindow: 200_000 };
                    yield { kind: "usage", costUsd: 0.2 };
                    yield { kind: "done" };
                },
                usage: { record: async (turn) => void ledger.push(turn) },
            }),
        ),
    );
    const { facts } = await runAgentTurn(client, { prompt: "fix the parser", conversationId: "conv-quiet" });

    // Still a finished turn, not a failure: it left a diff and a standing to land.
    expect(facts.filter((fact) => fact.kind === "error")).toEqual([]);
    await vi.waitFor(() => expect(ledger).toHaveLength(1), SETTLES);
    expect(ledger[0]).toMatchObject({
        outcome: "ok",
        verification: "unproven",
        filesEdited: 1,
        checklistTotal: 3,
        checklistOpen: 2,
        compactions: 1,
        contextTokens: 148_000,
        contextWindow: 200_000,
    });
    // Nothing spoke, so there's no check to name; absent differs from 'checked and it broke'.
    expect("check" in (ledger[0] ?? {})).toBe(false);
});

test("a turn that ends with nothing to show for it is reported as a failure, not as a finished turn", async () => {
    const ledger: Record<string, unknown>[] = [];
    const client = clientFor(
        createApp(
            services({
                async *agent() {
                    yield readFrame("1", "/work/src/parser.ts");
                    yield readFrame("2", "/work/src/lexer.ts");
                    yield { kind: "usage", costUsd: 0.2 };
                    yield { kind: "done" };
                },
                usage: { record: async (turn) => void ledger.push(turn) },
            }),
        ),
    );
    const { facts } = await runAgentTurn(client, { prompt: "fix the parser", conversationId: "conv-silent" });

    // Must be the last fact before `done`: every reader of a failed turn watches that spot.
    expect(facts.at(-1)?.kind).toBe("error");
    const failure = facts.find((fact) => fact.kind === "error");
    expect(failure).toMatchObject({ message: expect.stringContaining("2 tool calls") });
    // Uncoded on purpose: it's what lets the chat offer a Continue press instead of a dead end.
    expect("code" in (failure ?? {})).toBe(false);

    await vi.waitFor(() => expect(ledger).toHaveLength(1), SETTLES);
    expect(ledger[0]).toMatchObject({ outcome: "error", errorMessage: expect.stringContaining("nothing to show for it"), filesEdited: 0, toolCalls: 2 });
});

// The preamble-and-stop shape: the model announces a step, calls nothing, and the SDK reports a clean success. Prose is
// structurally identical to a short answer, so the turn must not be accused; the ledger is where it stays visible.
test("a turn that only promises to act is left alone in chat but recorded as having called nothing", async () => {
    const ledger: Record<string, unknown>[] = [];
    const client = clientFor(
        createApp(
            services({
                async *agent() {
                    yield { kind: "delta", text: "I'll start by finding the topbar code." };
                    yield { kind: "usage", costUsd: 0.25 };
                    yield { kind: "done" };
                },
                usage: { record: async (turn) => void ledger.push(turn) },
            }),
        ),
    );
    const { facts } = await runAgentTurn(client, { prompt: "fix the topbar", conversationId: "conv-preamble" });

    expect(facts.filter((fact) => fact.kind === "error")).toEqual([]);
    await vi.waitFor(() => expect(ledger).toHaveLength(1), SETTLES);
    expect(ledger[0]).toMatchObject({ outcome: "ok", toolCalls: 0, filesEdited: 0 });
});

test("a turn that stops after thinking and nothing else is reported the same way, and lands on the board as an error", async () => {
    const client = clientFor(
        createApp(
            services({
                async *agent() {
                    yield { kind: "thinking", text: "working out where the button lives" };
                    yield { kind: "done" };
                },
            }),
        ),
    );
    const { facts } = await runAgentTurn(client, { prompt: "go", conversationId: "conv-thought" });

    expect(facts.find((fact) => fact.kind === "error")).toMatchObject({
        message:
            "The turn ended with nothing to show for it: the model started and then stopped, no reply and no change to a file. Nothing failed: the session is intact, so carrying on continues from where it stopped.",
    });
    const { agents } = await client.agents.list();
    // The whole point of the frame: `error` is what the board reads as the Attention lane.
    expect(agents.find((agent) => agent.id === "conv-thought")).toMatchObject({ status: "error" });
});

test("a turn the provider never answered records no verdict at all", async () => {
    const ledger: Record<string, unknown>[] = [];
    const client = clientFor(
        createApp(
            services({
                async *agent() {
                    yield { kind: "error", code: "claude-not-entitled", message: "not enabled" };
                    yield { kind: "done" };
                },
                usage: { record: async (turn) => void ledger.push(turn) },
            }),
        ),
    );
    await runAgentTurn(client, { prompt: "go", conversationId: "conv-refused" });

    await vi.waitFor(() => expect(ledger).toHaveLength(1), SETTLES);
    expect("verification" in (ledger[0] ?? {})).toBe(false);
    expect("compactions" in (ledger[0] ?? {})).toBe(false);
});

test("the ledger carries the requested model as well as the resolved one", async () => {
    const ledger: Record<string, unknown>[] = [];
    const client = clientFor(
        createApp(
            services({
                async *agent() {
                    yield { kind: "usage", costUsd: 0.1 };
                    yield { kind: "done" };
                },
                usage: { record: async (turn) => void ledger.push(turn) },
            }),
        ),
    );
    await runAgentTurn(client, { prompt: "go", conversationId: "conv-model", model: "opus-4-6-thinking" });

    await vi.waitFor(() => expect(ledger).toHaveLength(1), SETTLES);
    expect(ledger[0]).toMatchObject({ modelRequested: "opus-4-6-thinking" });
});

test("an empty model pick is recorded as no pick at all, not as an empty one", async () => {
    const ledger: Record<string, unknown>[] = [];
    const client = clientFor(
        createApp(
            services({
                async *agent() {
                    yield { kind: "usage", costUsd: 0.1 };
                    yield { kind: "done" };
                },
                usage: { record: async (turn) => void ledger.push(turn) },
            }),
        ),
    );
    // The wire allows it, and the Codex path reads it as the catalog default: not a pick.
    await runAgentTurn(client, { prompt: "go", conversationId: "conv-blank", model: "" });

    await vi.waitFor(() => expect(ledger).toHaveLength(1), SETTLES);
    expect("modelRequested" in (ledger[0] ?? {})).toBe(false);
});
