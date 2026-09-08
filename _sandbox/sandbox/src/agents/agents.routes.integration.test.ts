import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { expect, test, vi } from "vitest";
import { SETTLES } from "@intentic/testing/vitest";

import type { TranscriptRow } from "@intentic/sandbox-contract";

import { createApp } from "../app.js";

import type { Services } from "../composition.js";

import { extensionProcessKey } from "../extensions/extension-processes.js";

import { windowOf } from "../sessions/transcript-record.js";

import { clientFor, collect, errorCode } from "../harness/route-client.testing.js";
import { fakeHistory, fakeServiceProcesses } from "../harness/route-fakes.testing.js";
import { codexConnectedProxy, services, withTranslator } from "../harness/route-services.testing.js";
import { runAgentTurn } from "../harness/route-turns.testing.js";

// Agents routes tests, driven over the daemon's HTTP surface as the browser drives it. Fakes and client are shared from
// route-services.testing.ts and its siblings.

test("an isolated turn runs in the conversation worktree, leads with the worktree frame, skips the main-tree snapshots, and registers the agent", async () => {
    let seen: { cwd?: string } | undefined;
    let snapshots = 0;
    const client = clientFor(
        createApp(
            services({
                async *agent(request) {
                    seen = request;
                    yield { kind: "session", sessionId: "sess-iso" };
                    yield { kind: "usage", costUsd: 0.5, inputTokens: 10, outputTokens: 5 };
                    yield { kind: "done" };
                },
                history: fakeHistory({
                    snapshot: async () => {
                        snapshots++;
                        return undefined;
                    },
                }),
            }),
        ),
    );
    const { facts } = await runAgentTurn(client, { prompt: "fix it", conversationId: "conv1", isolated: true });
    // `unenforced: true`: the sandbox can't build the namespace; the redirect still works and the operator is told.
    expect(facts[0]).toEqual({ kind: "worktree", branch: "agent/conv1", base: "aaaaaaa", unenforced: true });
    expect(seen?.cwd).toBe("/history/worktrees/conv1");
    expect(snapshots).toBe(0);
    const { agents } = await client.agents.list();
    expect(agents).toHaveLength(1);
    expect(agents[0]).toMatchObject({ id: "conv1", status: "idle", branch: "agent/conv1", costUsd: 0.5, sessionId: "sess-iso" });
    // `absorbed` is always present, even at 0, so a client can tell no changes from no data (AgentChangesSchema).
    expect(await client.agents.diff({ id: "conv1" })).toMatchObject({ absorbed: 0 });
});

test("a workspace turn follows the same registry lifecycle without inventing a branch", async () => {
    let cwd: string | undefined;
    const snapshots: string[] = [];
    const spend: Parameters<Services["usage"]["record"]>[0][] = [];
    const client = clientFor(
        createApp(
            services({
                async *agent(request) {
                    cwd = request.cwd;
                    yield { kind: "session", sessionId: "sess-workspace" };
                    yield { kind: "usage", costUsd: 0.25, inputTokens: 8, outputTokens: 3 };
                    yield { kind: "done" };
                },
                history: fakeHistory({
                    snapshot: async (trigger) => {
                        snapshots.push(trigger);
                        return undefined;
                    },
                }),
                usage: { record: async (entry) => void spend.push(entry) },
            }),
        ),
    );

    const { facts } = await runAgentTurn(client, { prompt: "fix tests in intentic", conversationId: "workspace-conv" });
    expect(facts.some((fact) => fact.kind === "worktree")).toBe(false);
    expect(cwd).toBe("/work");
    expect(snapshots).toEqual(["user", "turn"]);
    expect((await client.agents.list()).agents).toMatchObject([{ id: "workspace-conv", status: "idle", sessionId: "sess-workspace", costUsd: 0.25 }]);
    expect((await client.agents.list()).agents[0]).not.toHaveProperty("branch");
    await vi.waitFor(() => expect(spend).toMatchObject([{ conversationId: "workspace-conv" }]), SETTLES);
    // Branch-only actions (diff, autoLand, land, discard) reject a workspace conversation explicitly, not silently.
    expect(await errorCode(client.agents.diff({ id: "workspace-conv" }))).toBe("BAD_REQUEST");
    expect(await errorCode(client.agents.autoLand({ id: "workspace-conv", autoLand: false }))).toBe("BAD_REQUEST");
    expect(await errorCode(client.agents.land({ id: "workspace-conv" }))).toBe("BAD_REQUEST");
    expect(await errorCode(client.agents.discard({ id: "workspace-conv" }))).toBe("BAD_REQUEST");
});

test("a thrown workspace turn settles its surfaced card as an error", async () => {
    const client = clientFor(
        createApp(
            services({
                // Rejects before yielding any frame, as if the adapter died outright (an outage, a missing binary).
                async *agent() {
                    yield await Promise.reject(new Error("adapter crashed"));
                },
            }),
        ),
    );

    // Every turn emits a repo-sync note and a tier verdict first; filtered out here to isolate the error frame.
    const { facts } = await runAgentTurn(client, { prompt: "do it", conversationId: "workspace-error" });
    expect(facts.filter((fact) => fact.kind !== "tier")).toEqual([{ kind: "error", message: "adapter crashed" }]);
    // `failure` carries the message for a turn that produced nothing else, so a card need not read the transcript.
    expect((await client.agents.list()).agents[0]).toMatchObject({ id: "workspace-error", status: "error", failure: "adapter crashed" });
    expect((await client.agents.list()).agents[0]).not.toHaveProperty("branch");
});

test("an existing conversation keeps its registered placement when a later client sends stale isolation", async () => {
    const cwds: string[] = [];
    const client = clientFor(
        createApp(
            services({
                async *agent(request) {
                    cwds.push(request.cwd);
                    yield { kind: "done" };
                },
            }),
        ),
    );

    await runAgentTurn(client, { prompt: "first", conversationId: "placed" });
    const { facts: second } = await runAgentTurn(client, { prompt: "second", conversationId: "placed", isolated: true });
    expect(second.some((fact) => fact.kind === "worktree")).toBe(false);
    expect(cwds).toEqual(["/work", "/work"]);
    expect((await client.agents.list()).agents[0]).not.toHaveProperty("branch");
});

test("an isolated turn that dies on a provider gate still releases the conversation mutex", async () => {
    // No stored account and no env fallback: the gate errors before the adapter ever runs.
    const client = clientFor(
        createApp(
            services({
                claudeStore: { read: async () => undefined, write: async () => {}, clear: async () => {}, list: async () => [] },
            }),
        ),
    );
    const { facts: first } = await runAgentTurn(client, { prompt: "hi", conversationId: "conv1", isolated: true });
    expect(first.some((fact) => fact.kind === "error" && fact.message.includes("No Claude account"))).toBe(true);
    // A gate failure must not leave the agent stuck running; a retry hits the same gate, not agent-busy.
    const { facts: second } = await runAgentTurn(client, { prompt: "hi", conversationId: "conv1", isolated: true });
    expect(second.some((fact) => fact.kind === "error" && fact.code === "agent-busy")).toBe(false);
    const { agents } = await client.agents.list();
    expect(agents[0]?.status).not.toBe("running");
});

test("a turn's title seeds a fresh entry and agents.rename overwrites it", async () => {
    const client = clientFor(
        createApp(
            services({
                async *agent() {
                    yield { kind: "done" };
                },
            }),
        ),
    );
    // A user-chosen title wins over the prompt-derived one on a draft's first turn.
    await runAgentTurn(client, { prompt: "fix the login bug", title: "My agent", conversationId: "conv1", isolated: true });
    expect((await client.agents.list()).agents[0]?.title).toBe("My agent");
    const renamed = await client.agents.rename({ id: "conv1", title: "  Login fix  " });
    expect(renamed.title).toBe("Login fix");
    expect((await client.agents.list()).agents[0]?.title).toBe("Login fix");
    expect(await errorCode(client.agents.rename({ id: "nope", title: "x" }))).toBe("NOT_FOUND");
});

// Title is the sanitized first prompt, so a title hit and a prompt hit are one rule; search also covers the archive,
// not just the live roster.
test("agents.search matches titles and later lines, across the archive", async () => {
    // An isolated turn's namespace maps its worktree to /work, so session reads are scoped to the workspace root.
    const scopedTo: string[] = [];
    const app = createApp(
        services({
            async *agent(request) {
                yield { kind: "session", sessionId: request.prompt.includes("login") ? "sess-1" : "sess-2" };
                yield { kind: "done" };
            },
            sessions: {
                list: async () => [],
                read: async (dir, id) => {
                    scopedTo.push(dir);
                    return id === "sess-1"
                        ? [
                              { role: "user" as const, text: "restored words" },
                              { role: "assistant" as const, text: "landAgent lives in laneDrop.ts" },
                          ]
                        : [];
                },
                readTail: async () => [],
                search: async () => [],
                exists: async () => true,
            },
        }),
    );
    const client = clientFor(app);
    await runAgentTurn(client, { prompt: "fix the login bug", conversationId: "conv1", isolated: true });
    await runAgentTurn(client, { prompt: "tidy the readme", conversationId: "conv2", isolated: true });

    // `toEqual`, not `toMatchObject`: `ending`'s absence is asserted, since this turn finished without a hold.
    expect(await client.agents.transcript({ id: "conv1" })).toEqual({
        sessionId: "sess-1",
        provider: "claude",
        harness: "native",
        account: "default",
        messages: [
            { role: "user", text: "restored words" },
            { role: "assistant", text: "landAgent lives in laneDrop.ts" },
        ],
        // from: 0, more: false because a two-row conversation fits entirely inside the page window.
        from: 0,
        more: false,
    });
    // Every read must scope to the workspace root; an isolated turn's worktree maps to /work here.
    expect([...new Set(scopedTo)]).toEqual(["/work"]);
    // Unknown id must answer exactly 404: the browser reads that status as no such card (`replayStoredSession`).
    await expect(client.agents.transcript({ id: "nope" })).rejects.toThrow();
    expect((await app.request("/agents/nope/transcript")).status).toBe(404);

    // Later words are absent from the title and the transcript fake; only the routed-prompt index carries them.
    await runAgentTurn(client, { prompt: "also tidy the changelog", conversationId: "conv2", isolated: true });

    // Queries under two characters are refused: shorter matches everything and the scan is pure cost.
    expect(await errorCode(client.agents.search({ query: "a" }))).toBe("BAD_REQUEST");

    // A title hit reports no snippet: the card already shows the match.
    expect(await client.agents.search({ query: "login" })).toEqual({ matches: [{ id: "conv1" }], scanned: 2, indexing: false });
    // Title is the first prompt, so this hit also needs no transcript.
    expect(await client.agents.search({ query: "readme" })).toEqual({ matches: [{ id: "conv2" }], scanned: 2, indexing: false });
    // A hit in a later line reports the snippet and which side of the chat said it.
    expect(await client.agents.search({ query: "changelog" })).toMatchObject({
        matches: [{ id: "conv2", snippet: { text: "also tidy the changelog", speaker: "user" } }],
    });
    // Agent replies are matchable too, read from the transcript since the routed-prompt index holds only user text.
    expect(await client.agents.search({ query: "lanedrop" })).toMatchObject({
        matches: [{ id: "conv1", snippet: { text: "landAgent lives in laneDrop.ts", speaker: "agent" } }],
    });

    // `caseSensitive` applies the query as typed, to the transcript and the title alike, as one rule.
    expect(await client.agents.search({ query: "landAgent", caseSensitive: "true" })).toMatchObject({
        matches: [{ id: "conv1", snippet: { text: "landAgent lives in laneDrop.ts", speaker: "agent" } }],
    });
    expect(await client.agents.search({ query: "landagent", caseSensitive: "true" })).toEqual({ matches: [], scanned: 2, indexing: false });
    expect(await client.agents.search({ query: "Login", caseSensitive: "true" })).toEqual({ matches: [], scanned: 2, indexing: false });

    // Archived agents drop off the roster but must still be found by search.
    await client.agents.archive({ ids: ["conv1"] });
    expect((await client.agents.list()).agents.map((agent) => agent.id)).toEqual(["conv2"]);
    expect(await client.agents.search({ query: "login" })).toEqual({ matches: [{ id: "conv1" }], scanned: 2, indexing: false });

    expect(await client.agents.search({ query: "nothing here" })).toEqual({ matches: [], scanned: 2, indexing: false });
});

// Reports the live `pendingLimit` hold, not the summary flag, since the two can diverge across a daemon restart; `ran:
// false` is ordinary, since a spent allowance refuses the turn's first request.
test("the transcript reports a spent allowance as a held ending, so a window that never saw it can offer the re-run", async () => {
    const client = clientFor(
        createApp(
            services({
                async *agent() {
                    yield { kind: "session", sessionId: "sess-spent" };
                    yield { kind: "error", code: "rate_limit", message: "Claude usage limit reached. Send again once it resets." };
                    yield { kind: "done" };
                },
            }),
        ),
    );

    await runAgentTurn(client, { prompt: "rewrite the reconcile engine", conversationId: "conv-spent" });

    const transcript = await client.agents.transcript({ id: "conv-spent" });
    // Costs ride beside `ran` when the daemon measured them (limit-way.ts).
    expect(transcript.ending).toEqual({ reason: "limit", held: expect.objectContaining({ ran: false }) });
    // Missing `resetsAt`/`scheduled` are meaningful; the client branches on key presence, not value.
    expect(Object.keys(transcript.ending!)).toEqual(["reason", "held"]);
});

// An uncoded error (crash, unresponsive agent, watchdog timeout) arms the continue press (turnFailures.ts, `code ===
// undefined`); a named failure with a known repair stays silent instead.
test("the transcript reports an uncoded error as stopped, so a window that never saw it can offer the press", async () => {
    const client = clientFor(
        createApp(
            services({
                async *agent() {
                    yield { kind: "session", sessionId: "sess-timeout" };
                    yield { kind: "error", message: "Google turn timed out waiting for OpenCode." };
                    yield { kind: "done" };
                },
            }),
        ),
    );

    await runAgentTurn(client, { prompt: "rewrite the reconcile engine", conversationId: "conv-timeout" });

    const transcript = await client.agents.transcript({ id: "conv-timeout" });
    expect(transcript.ending).toEqual({ reason: "stopped" });
});

test("agents.search reads the daemon transcript for a provider with no SDK prompt store", async () => {
    const codexSearchTranscript = (id: string) =>
        id === "codex-search"
            ? [
                  { role: "user" as const, text: "open the codex task" },
                  { role: "assistant" as const, text: "I mentioned an assistant-needle" },
                  { role: "user" as const, text: "find durable-transcript-needle" },
              ]
            : [];
    const app = createApp(
        services({
            config: withTranslator,
            cliProxy: codexConnectedProxy,
            async *codexAgent() {
                yield { kind: "done" };
            },
            // Native Codex has no Claude SDK session; the daemon transcript is the provider-neutral search source here.
            transcripts: {
                read: async (agent) => codexSearchTranscript(agent.id),
                fork: async () => {},
                append: async () => {},
                // Derived from the same record `read` returns, so the fake cannot disagree with itself.
                page: async (agent, window = {}) => windowOf(codexSearchTranscript(agent.id), window),
                count: async (agent) => codexSearchTranscript(agent.id).length,
                truncate: async (agent, keep) => Math.max(0, codexSearchTranscript(agent.id).length - keep),
            },
            sessions: {
                list: async () => [],
                read: async () => [],
                readTail: async () => [],
                search: async () => [],
                exists: async () => true,
            },
        }),
    );
    const client = clientFor(app);
    await runAgentTurn(client, { prompt: "open the codex task", title: "Codex task", agent: "codex", conversationId: "codex-search" });

    expect(await client.agents.search({ query: "durable-transcript-needle" })).toMatchObject({
        matches: [{ id: "codex-search", snippet: { text: "find durable-transcript-needle", speaker: "user" } }],
    });
    // Agent-authored lines are searchable too, and report themselves as the agent's.
    expect(await client.agents.search({ query: "assistant-needle" })).toMatchObject({
        matches: [{ id: "codex-search", snippet: { text: "I mentioned an assistant-needle", speaker: "agent" } }],
    });
});

// A land only reads the checkout: the guard asks whether anyone is mid-sentence, not whether a turn is alive. `landed:
// false` here means the guard passed; these fakes point main at a directory that doesn't exist.
test("a mid-write land is refused, and the same land with `force` goes through", async () => {
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
    await client.agent.run({ prompt: "a long edit", conversationId: "conv1", isolated: true });
    // Parked with nothing raised: still writing, the one state the guard refuses.
    expect(await errorCode(client.agents.land({ id: "conv1" }))).toBe("CONFLICT");
    // `force: true` is the user's override, the press behind the warning modal.
    expect(await client.agents.land({ id: "conv1", force: true })).toMatchObject({ landed: false });
    release?.();
    await collect(await client.agent.attach({ conversationId: "conv1" }));
});

test("a turn parked on a question lands without a force: it is waiting for the user, not writing", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const client = clientFor(
        createApp(
            services({
                async *agent() {
                    yield {
                        kind: "question",
                        requestId: "q1",
                        questions: [{ question: "which one?", header: "Pick", multiSelect: false, options: [] }],
                    };
                    await gate;
                    yield { kind: "done" };
                },
            }),
        ),
    );
    await client.agent.run({ prompt: "ask me something", conversationId: "conv1", isolated: true });
    // Waits for the park to reach the registry via the relay, using SETTLES to avoid a flaky wait wedging later tests.
    await vi.waitFor(async () => expect((await client.agents.list()).agents[0]?.status).toBe("awaiting"), SETTLES);
    // Landing without `force` succeeds, not refused, while parked on a question: only the user can resolve it.
    expect(await client.agents.land({ id: "conv1" })).toMatchObject({ landed: false });
    release?.();
    await collect(await client.agent.attach({ conversationId: "conv1" }));
});

// A forced land only reads; the turn still owns finishing itself (mutex release, ending write), so the card must keep
// reading as live until then.
test("a forced land leaves the running turn's bookkeeping to the turn", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const client = clientFor(
        createApp(
            services({
                async *agent() {
                    await gate;
                    yield { kind: "usage", costUsd: 0.25, inputTokens: 4, outputTokens: 2 };
                    yield { kind: "done" };
                },
            }),
        ),
    );
    await client.agent.run({ prompt: "a long edit", conversationId: "conv1", isolated: true });
    await client.agents.land({ id: "conv1", force: true });
    // Status stays running: the forced land recorded its own outcome without touching the turn.
    expect((await client.agents.list()).agents[0]?.status).toBe("running");
    release?.();
    await collect(await client.agent.attach({ conversationId: "conv1" }));
    // The turn still settles itself afterward: usage flushed, mutex released, status updated.
    const { agents } = await client.agents.list();
    expect(agents[0]).toMatchObject({ id: "conv1", costUsd: 0.25 });
    expect(agents[0]?.status).not.toBe("running");
});

test("archiving a named agent asks nothing of the rest of the fleet; clearing the lane still does", async () => {
    const daemon = services();
    const probe = vi.spyOn(daemon.agents, "refreshStandings");
    const client = clientFor(createApp(daemon));
    await runAgentTurn(client, { prompt: "fix it", conversationId: "conv1", isolated: true });
    await runAgentTurn(client, { prompt: "and this", conversationId: "conv2", isolated: true });
    // Listing the roster already probes standings on its own; clear here to isolate the archive's own call.
    probe.mockClear();

    await client.agents.archive({ ids: ["conv1"] });

    expect(probe).not.toHaveBeenCalled();
    expect((await client.agents.archived()).agents.map((agent) => agent.id)).toEqual(["conv1"]);

    probe.mockClear();
    await client.agents.archive({});

    expect(probe).toHaveBeenCalledTimes(1);
    expect((await client.agents.archived()).agents.map((agent) => agent.id)).toEqual(["conv2", "conv1"]);
});

test("archive answers with what it refused and why, and leaves those agents on the board", async () => {
    const daemon = services({
        agentWorktrees: {
            ...services().agentWorktrees,
            retire: async (id) => {
                if (id === "conv1") {
                    throw new Error("fatal: not a git repository: /work/vendor/.git/worktrees/vendor\n");
                }
            },
        },
    });
    const client = clientFor(createApp(daemon));
    await runAgentTurn(client, { prompt: "fix it", conversationId: "conv1", isolated: true });
    await runAgentTurn(client, { prompt: "and this", conversationId: "conv2", isolated: true });

    const answer = await client.agents.archive({ ids: ["conv1", "conv2"] });

    expect(answer.moved.map((agent) => agent.id)).toEqual(["conv2"]);
    // Reason is trimmed to one line, not git's full paragraph: this is what the board prints.
    expect(answer.failed).toEqual([{ id: "conv1", reason: "fatal: not a git repository: /work/vendor/.git/worktrees/vendor" }]);
    expect((await client.agents.list()).agents.map((agent) => agent.id)).toEqual(["conv1"]);
});

// The next turn reading the planted line as its own prior words is this feature's real contract; the transcript looking
// right alone is not.
test("agents.place appends the user's words as the agent's, retires the session, and the next turn reads them as its own", async () => {
    // In-memory record: `place` appends through the same door a settled turn does; both read back via `read`.
    const records = new Map<string, TranscriptRow[]>();
    const requests: { prompt: string; sessionId?: string }[] = [];
    const client = clientFor(
        createApp(
            services({
                async *agent(request) {
                    requests.push({ prompt: request.prompt, ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }) });
                    yield { kind: "session", sessionId: "sess-live" };
                    yield { kind: "done" };
                },
                transcripts: {
                    read: async (agent) => records.get(agent.id) ?? [],
                    fork: async () => {},
                    append: async (agent, messages) => void records.set(agent.id, [...(records.get(agent.id) ?? []), ...messages]),
                    // Uses production's own window rule, so this test cannot pass a shape the daemon later disagrees
                    // with.
                    page: async (agent, window = {}) => windowOf(records.get(agent.id) ?? [], window),
                    count: async (agent) => (records.get(agent.id) ?? []).length,
                    truncate: async () => 0,
                },
            }),
        ),
    );
    await runAgentTurn(client, { prompt: "map the login flow", conversationId: "conv1", isolated: true });
    expect((await client.agents.list()).agents[0]).toMatchObject({ id: "conv1", sessionId: "sess-live" });

    const placed = "I checked the tests and they pass.";
    expect(await client.agents.place({ id: "conv1", text: placed })).toEqual({ ok: true });

    // Newest row is the placed line, marked, exactly what the transcript route serves any reopening tab.
    expect((await client.agents.transcript({ id: "conv1" })).messages.at(-1)).toEqual({
        role: "assistant",
        text: placed,
        placed: true,
    });
    // Only the session pointer is gone; the record above is what the conversation reads back as.
    expect((await client.agents.list()).agents[0]).not.toHaveProperty("sessionId");

    await runAgentTurn(client, { prompt: "carry on", conversationId: "conv1", isolated: true });
    const next = requests.at(-1);
    expect(next?.sessionId).toBeUndefined();
    // Session resumes nothing, so the fresh call is seeded from the record: the planted line reaches the model as the
    // agent's own prior words, with the human-facing mark stripped out.
    expect(next?.prompt).toContain(`Assistant: ${placed}`);
    expect(next?.prompt).not.toContain("placed");

    // Unknown id has no transcript to place into.
    expect(await errorCode(client.agents.place({ id: "ghost", text: "boo" }))).toBe("NOT_FOUND");
});

// A channel conversation delivers the placed line through the provider's gateway before appending; a failed delivery
// refuses the place. Tests run against real extension manifests, matching production.

// Shared in-memory record and one-frame turn for the channel-place tests; `ports` seeds the fake supervisor so a test
// controls whether the discord gateway is running.
const channelPlaceHarness = (ports: Record<string, number>, activity?: unknown[]) => {
    const records = new Map<string, TranscriptRow[]>();
    const client = clientFor(
        createApp(
            services({
                async *agent() {
                    yield { kind: "session", sessionId: "sess-live" };
                    yield { kind: "done" };
                },
                transcripts: {
                    read: async (agent) => records.get(agent.id) ?? [],
                    fork: async () => {},
                    append: async (agent, messages) => void records.set(agent.id, [...(records.get(agent.id) ?? []), ...messages]),
                    // Uses production's own window rule, so this test cannot pass a shape the daemon later disagrees
                    // with.
                    page: async (agent, window = {}) => windowOf(records.get(agent.id) ?? [], window),
                    count: async (agent) => (records.get(agent.id) ?? []).length,
                    truncate: async () => 0,
                },
                serviceProcesses: fakeServiceProcesses(ports),
                ...(activity !== undefined
                    ? { activity: { append: async (event: unknown) => void activity.push(event), list: async () => [] } }
                    : {}),
            }),
        ),
    );
    return { client, records };
};

// Local stand-in for a gateway's loopback: records every /deliver body and answers as configured.
const fakeGateway = async (answer: { status: number; body: string }): Promise<{ port: number; deliveries: unknown[]; close: () => void }> => {
    const deliveries: unknown[] = [];
    const server = createServer((req, res) => {
        let raw = "";
        req.on("data", (chunk: Buffer) => (raw += chunk.toString()));
        req.on("end", () => {
            if (req.method === "POST" && req.url === "/deliver") {
                deliveries.push({ path: req.url, body: JSON.parse(raw || "{}") });
                res.writeHead(answer.status, { "content-type": "text/plain" });
                res.end(answer.body);
                return;
            }
            res.writeHead(200, { "content-type": "text/plain" });
            res.end("ok");
        });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return { port: (server.address() as AddressInfo).port, deliveries, close: () => server.close() };
};

test("agents.place in a channel conversation delivers the line to the provider's gateway, then appends and logs the send", async () => {
    const gateway = await fakeGateway({ status: 200, body: "ok" });
    const activity: unknown[] = [];
    try {
        const { client } = channelPlaceHarness({ [extensionProcessKey("intentic.discord", "gateway")]: gateway.port }, activity);
        await runAgentTurn(client, {
            prompt: "answer the mention",
            conversationId: "conv1",
            isolated: true,
            origin: { automationId: "auto", provider: "discord", channelId: "123" },
        });
        expect(await client.agents.place({ id: "conv1", text: "On it. checking now." })).toEqual({ ok: true });
        expect(gateway.deliveries).toEqual([{ path: "/deliver", body: { channelId: "123", text: "On it. checking now." } }]);
        expect((await client.agents.transcript({ id: "conv1" })).messages.at(-1)).toEqual({
            role: "assistant",
            text: "On it. checking now.",
            placed: true,
        });
        // Same activity row shape an ordinary agent send would produce.
        await vi.waitFor(
            () =>
                expect(activity.filter((event) => (event as { type?: string }).type === "message.send")).toMatchObject([
                    { provider: "discord", direction: "out", channelId: "123", content: "On it. checking now.", conversationId: "conv1" },
                ]),
            SETTLES,
        );
    } finally {
        gateway.close();
    }
});

test("agents.place refuses a channel conversation whose gateway is not running, leaving the record untouched", async () => {
    const { client, records } = channelPlaceHarness({});
    await runAgentTurn(client, {
        prompt: "answer the mention",
        conversationId: "conv1",
        isolated: true,
        origin: { automationId: "auto", provider: "discord", channelId: "123" },
    });
    expect(await errorCode(client.agents.place({ id: "conv1", text: "planted" }))).toBe("BAD_GATEWAY");
    // Nothing appended and the session pointer kept: the conversation is unchanged by the failed attempt.
    expect((records.get("conv1") ?? []).some((message) => message.placed === true)).toBe(false);
    expect((await client.agents.list()).agents[0]).toMatchObject({ sessionId: "sess-live" });
});

test("agents.place surfaces the gateway's own refusal sentence", async () => {
    const gatewayBody = "no connected Discord bot can post in this channel";
    const gateway = await fakeGateway({ status: 500, body: gatewayBody });
    try {
        const { client } = channelPlaceHarness({ [extensionProcessKey("intentic.discord", "gateway")]: gateway.port });
        await runAgentTurn(client, {
            prompt: "answer the mention",
            conversationId: "conv1",
            isolated: true,
            origin: { automationId: "auto", provider: "discord", channelId: "123" },
        });
        const message = await client.agents.place({ id: "conv1", text: "planted" }).then(
            () => undefined,
            (error: unknown) => (error as Error).message,
        );
        expect(message).toBe(gatewayBody);
    } finally {
        gateway.close();
    }
});

// Webchat has no gateway extension: the visitor transport exists only while a turn streams (webchat.routes.ts).
test("agents.place in a webchat conversation places into the record alone", async () => {
    const { client, records } = channelPlaceHarness({});
    await runAgentTurn(client, {
        prompt: "answer the visitor",
        conversationId: "conv1",
        isolated: true,
        origin: { automationId: "auto", provider: "webchat", channelId: "wc-visitor-1" },
    });
    expect(await client.agents.place({ id: "conv1", text: "We are on it." })).toEqual({ ok: true });
    expect(records.get("conv1")?.at(-1)).toEqual({ role: "assistant", text: "We are on it.", placed: true });
});

// Same refusal shape as land/discard: place takes the turn's own mutex.
test("agents.place is refused while the agent's turn is running", async () => {
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
    await client.agent.run({ prompt: "a long think", conversationId: "conv1", isolated: true });
    expect(await errorCode(client.agents.place({ id: "conv1", text: "planted" }))).toBe("CONFLICT");
    release?.();
    await collect(await client.agent.attach({ conversationId: "conv1" }));
});

// Browser builds this URL by hand, not via the typed client, so a dropped `before` would break paging silently.
test("agents.transcript serves the newest turns by default and walks back through `before`", async () => {
    const record: TranscriptRow[] = Array.from({ length: 60 }, (_, index) =>
        index % 2 === 0 ? { role: "user", text: `ask ${index / 2}` } : { role: "assistant", text: `answer ${(index - 1) / 2}` },
    );
    const app = createApp(
        services({
            async *agent() {
                yield { kind: "done" };
            },
            transcripts: {
                read: async () => record,
                fork: async () => {},
                append: async () => {},
                page: async (_agent, window = {}) => windowOf(record, window),
                count: async () => record.length,
                truncate: async () => 0,
            },
        }),
    );
    await runAgentTurn(clientFor(app), { prompt: "seed the registry", conversationId: "conv1" });

    const page = async (query: string): Promise<{ messages: TranscriptRow[]; from: number; more: boolean }> =>
        (await (await app.request(`/agents/conv1/transcript${query}`)).json()) as { messages: TranscriptRow[]; from: number; more: boolean };

    // Thirty turns, twenty-turn window: newest twenty returned, starting ten turns in.
    const newest = await page("");
    expect(newest.messages).toHaveLength(40);
    expect(newest.messages[0]).toMatchObject({ role: "user", text: "ask 10" });
    expect(newest.from).toBe(20);
    expect(newest.more).toBe(true);

    // Passing `from` back as `before` reaches the beginning, where nothing more is left to page.
    const oldest = await page(`?before=${newest.from}`);
    expect(oldest.messages[0]).toMatchObject({ role: "user", text: "ask 0" });
    expect(oldest.from).toBe(0);
    expect(oldest.more).toBe(false);

    // Together, the two pages equal the record once: no row lost at the seam, none served twice.
    expect([...oldest.messages, ...newest.messages].map(({ text }) => text)).toEqual(record.map(({ text }) => text));

    // `turns` narrows the window for a surface that wants fewer than a full chat page.
    expect((await page("?turns=2")).messages).toHaveLength(4);
});
