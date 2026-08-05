import { expect, test, vi } from "vitest";

import { createApp } from "../app.js";

import type { Services } from "../composition.js";

import { userPromptsOf } from "../sessions/prompt-index.js";

import { clientFor, codexConnectedProxy, errorCode, fakeHistory, runAgentTurn, services, withTranslator } from "../route-testing.js";

/* The agents routes, driven over the daemon's HTTP surface exactly as the browser drives them.
 * Split out of app.integration.test.ts, which had grown to 116 tests across every route in the daemon —
 * one file that two agents working on unrelated features collided in every time. The fakes and the client
 * are shared (route-testing.ts); what lives here is what these routes do. */

test("an isolated turn runs in the conversation worktree, leads with the worktree frame, skips the main-tree snapshots, and registers the agent", async () => {
    let seen: { cwd?: string } | undefined;
    let snapshots = 0;
    const client = clientFor(
        createApp(
            services({
                agent: async function* (request) {
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
    const events = await runAgentTurn(client, { prompt: "fix it", conversationId: "conv1", isolated: true });
    // The worktree identity frame precedes every provider frame; the stub composition's root base is aaaa….
    // `unenforced` because this sandbox cannot build the namespace: the turn still works in its worktree, but
    // the guarantee comes from the path redirect rather than from mounts, and the operator is told so.
    expect(events[0]).toEqual({ kind: "worktree", branch: "agent/conv1", base: "aaaaaaa", unenforced: true });
    // The single binding point: the turn's cwd is the worktree, not /work.
    expect(seen?.cwd).toBe("/history/worktrees/conv1");
    // Both main-tree history snapshots (attribution fence + turn end) are skipped.
    expect(snapshots).toBe(0);
    // The fleet registry recorded the conversation: idle after finish, usage flushed, session captured.
    const { agents } = await client.agents.list();
    expect(agents).toHaveLength(1);
    expect(agents[0]).toMatchObject({ id: "conv1", status: "idle", branch: "agent/conv1", costUsd: 0.5, sessionId: "sess-iso" });
});

test("a workspace turn follows the same registry lifecycle without inventing a branch", async () => {
    let cwd: string | undefined;
    const snapshots: string[] = [];
    const spend: Parameters<Services["usage"]["record"]>[0][] = [];
    const client = clientFor(
        createApp(
            services({
                agent: async function* (request) {
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

    const events = await runAgentTurn(client, { prompt: "fix tests in intentic", conversationId: "workspace-conv" });
    expect(events.some((event) => event.kind === "worktree")).toBe(false);
    expect(cwd).toBe("/work");
    expect(snapshots).toEqual(["user", "turn"]);
    expect((await client.agents.list()).agents).toMatchObject([{ id: "workspace-conv", status: "idle", sessionId: "sess-workspace", costUsd: 0.25 }]);
    expect((await client.agents.list()).agents[0]).not.toHaveProperty("branch");
    await vi.waitFor(() => expect(spend).toMatchObject([{ conversationId: "workspace-conv" }]));
    // Registry actions remain unified; branch actions are placement-specific and fail explicitly.
    expect(await errorCode(client.agents.diff({ id: "workspace-conv" }))).toBe("BAD_REQUEST");
    expect(await errorCode(client.agents.autoLand({ id: "workspace-conv", autoLand: false }))).toBe("BAD_REQUEST");
    expect(await errorCode(client.agents.land({ id: "workspace-conv" }))).toBe("BAD_REQUEST");
    expect(await errorCode(client.agents.discard({ id: "workspace-conv" }))).toBe("BAD_REQUEST");
});

test("a thrown workspace turn settles its surfaced card as an error", async () => {
    const client = clientFor(
        createApp(
            services({
                // The adapter dies on the first pull, before any frame — a provider outage, a missing binary.
                agent: async function* () {
                    yield await Promise.reject(new Error("adapter crashed"));
                },
            }),
        ),
    );

    expect(await runAgentTurn(client, { prompt: "do it", conversationId: "workspace-error" })).toEqual([
        { kind: "error", message: "adapter crashed" },
        { kind: "done" },
    ]);
    // And the roster carries WHY, not just that: the sentence is the whole of what a card, a run row or a
    // notification can say about a turn that produced nothing else, and reaching it through the transcript is
    // the trip this field exists to spare the reader.
    expect((await client.agents.list()).agents[0]).toMatchObject({ id: "workspace-error", status: "error", failure: "adapter crashed" });
    expect((await client.agents.list()).agents[0]).not.toHaveProperty("branch");
});

test("an existing conversation keeps its registered placement when a later client sends stale isolation", async () => {
    const cwds: string[] = [];
    const client = clientFor(
        createApp(
            services({
                agent: async function* (request) {
                    cwds.push(request.cwd);
                    yield { kind: "done" };
                },
            }),
        ),
    );

    await runAgentTurn(client, { prompt: "first", conversationId: "placed" });
    const second = await runAgentTurn(client, { prompt: "second", conversationId: "placed", isolated: true });
    expect(second.some((event) => event.kind === "worktree")).toBe(false);
    expect(cwds).toEqual(["/work", "/work"]);
    expect((await client.agents.list()).agents[0]).not.toHaveProperty("branch");
});

test("an isolated turn that dies on a provider gate still releases the conversation mutex", async () => {
    // No Claude account and no env fallback → the gate yields an error before the adapter ever runs.
    const client = clientFor(
        createApp(
            services({
                claudeStore: { read: async () => undefined, write: async () => {}, clear: async () => {}, list: async () => [] },
            }),
        ),
    );
    const first = await runAgentTurn(client, { prompt: "hi", conversationId: "conv1", isolated: true });
    expect(first.some((event) => event.kind === "error" && event.message.includes("No Claude account"))).toBe(true);
    // The gate exit must not leave the agent stuck "running" — the retry hits the same gate, NOT agent-busy.
    const second = await runAgentTurn(client, { prompt: "hi", conversationId: "conv1", isolated: true });
    expect(second.some((event) => event.kind === "error" && event.code === "agent-busy")).toBe(false);
    const { agents } = await client.agents.list();
    expect(agents[0]?.status).not.toBe("running");
});

test("a turn's title seeds a fresh entry and agents.rename overwrites it", async () => {
    const client = clientFor(
        createApp(
            services({
                agent: async function* () {
                    yield { kind: "done" };
                },
            }),
        ),
    );
    // A renamed draft's first turn carries the user-chosen title — it wins over the prompt derivation.
    await runAgentTurn(client, { prompt: "fix the login bug", title: "My agent", conversationId: "conv1", isolated: true });
    expect((await client.agents.list()).agents[0]?.title).toBe("My agent");
    const renamed = await client.agents.rename({ id: "conv1", title: "  Login fix  " });
    expect(renamed.title).toBe("Login fix");
    expect((await client.agents.list()).agents[0]?.title).toBe("Login fix");
    expect(await errorCode(client.agents.rename({ id: "nope", title: "x" }))).toBe("NOT_FOUND");
});

/* The fleet filter. Matches the title (which IS the sanitized first prompt) or any later prompt the user
 * wrote, and — the part the board depends on and no session-level search can give it — it answers over the
 * ARCHIVE too. A board whose filter stopped at the live roster would report "no matches" for an agent sitting
 * one click away behind the archive button. */
test("agents.search matches titles and later prompts, across the archive, and never the agent's own words", async () => {
    // Prompts keyed by session id, standing in for the transcripts the daemon would read.
    const prompts: Record<string, string[]> = {
        "sess-1": ["fix the login bug", "actually make it use landAgent instead"],
        "sess-2": ["tidy the readme"],
    };
    // Every store read the fleet makes, with the dir it scoped to — an isolated turn's session is filed under
    // the workspace ROOT (its namespace makes the worktree /work), so a read scoped to the worktree path finds
    // nothing and the card redraws as a conversation that never happened.
    const scopedTo: string[] = [];
    const app = createApp(
        services({
            // One SDK session per conversation, told apart by the prompt each turn carries.
            agent: async function* (request) {
                yield { kind: "session", sessionId: request.prompt.includes("login") ? "sess-1" : "sess-2" };
                yield { kind: "done" };
            },
            sessions: {
                list: async () => [],
                read: async (dir, id) => {
                    scopedTo.push(dir);
                    return id === "sess-1" ? [{ role: "user" as const, text: "restored words" }] : [];
                },
                search: async () => [],
                prompts: async (dir, id) => {
                    scopedTo.push(dir);
                    return prompts[id] ?? [];
                },
                exists: async () => true,
            },
        }),
    );
    const client = clientFor(app);
    await runAgentTurn(client, { prompt: "fix the login bug", conversationId: "conv1", isolated: true });
    await runAgentTurn(client, { prompt: "tidy the readme", conversationId: "conv2", isolated: true });

    // The session the REGISTRY recorded from the turn's own frame, never re-derived from where the turn ran.
    expect(await client.agents.transcript({ id: "conv1" })).toEqual({
        sessionId: "sess-1",
        messages: [{ role: "user", text: "restored words" }],
    });
    expect(scopedTo).toEqual(["/work"]);
    // An id the registry has never heard of is a 404 ON THE WIRE, not merely a rejected call: the browser reads
    // that exact status as "this conversation has no entry any more" and stops a tab claiming a fleet card
    // nothing on the board can render (see useChat's replayStoredSession). Anything else — a 500, an
    // unreachable daemon — must stay a retryable read, so the status is the contract, not the message.
    await expect(client.agents.transcript({ id: "nope" })).rejects.toThrow();
    expect((await app.request("/agents/nope/transcript")).status).toBe(404);

    // Under two characters the contract refuses: below that everything matches and the scan is pure cost.
    expect(await errorCode(client.agents.search({ query: "a" }))).toBe("BAD_REQUEST");

    // A title hit needs no transcript, so it reports no snippet — the card already shows what it matched on.
    expect(await client.agents.search({ query: "login" })).toEqual({ matches: [{ id: "conv1" }], scanned: 2 });
    // …and a hit in a LATER prompt reports the line, which is the whole reason a filtered card is believable.
    expect(await client.agents.search({ query: "readme" })).toMatchObject({ matches: [{ id: "conv2" }] });

    // Archiving takes conv1 off the roster; the filter must still find it.
    await client.agents.archive({ ids: ["conv1"] });
    expect((await client.agents.list()).agents.map((agent) => agent.id)).toEqual(["conv2"]);
    expect(await client.agents.search({ query: "login" })).toEqual({ matches: [{ id: "conv1" }], scanned: 2 });

    expect(await client.agents.search({ query: "nothing here" })).toEqual({ matches: [], scanned: 2 });
});

test("agents.search reads the daemon transcript for a provider with no SDK prompt store", async () => {
    const codexSearchTranscript = (id: string) =>
        id === "codex-search"
            ? [
                  { role: "user" as const, text: "open the codex task" },
                  { role: "assistant" as const, text: "I mentioned forbidden-assistant-needle" },
                  { role: "user" as const, text: "find durable-transcript-needle" },
              ]
            : [];
    const app = createApp(
        services({
            config: withTranslator,
            cliProxy: codexConnectedProxy,
            codexAgent: async function* () {
                yield { kind: "done" };
            },
            // Native Codex has no Claude SDK session to search. The daemon transcript is the provider-neutral
            // source, and includes a later prompt that is deliberately absent from the card title. `prompts`
            // extracts from the same record through the real userPromptsOf, so the assistant-exclusion
            // assertion below exercises the extraction rather than a hand-picked list.
            transcripts: {
                read: async (agent) => codexSearchTranscript(agent.id),
                open: async () => {},
                fork: async () => {},
                append: async () => {},
                prompts: async (agent) => userPromptsOf(codexSearchTranscript(agent.id)),
                // Derived from the same record `read` answers from, so the fake cannot contradict itself.
                count: async (agent) => codexSearchTranscript(agent.id).length,
                truncate: async (agent, keep) => Math.max(0, codexSearchTranscript(agent.id).length - keep),
            },
            sessions: {
                list: async () => [],
                read: async () => [],
                search: async () => [],
                prompts: async () => {
                    throw new Error("provider store must not be consulted");
                },
                exists: async () => true,
            },
        }),
    );
    const client = clientFor(app);
    await runAgentTurn(client, { prompt: "open the codex task", title: "Codex task", agent: "codex", conversationId: "codex-search" });

    expect(await client.agents.search({ query: "durable-transcript-needle" })).toMatchObject({
        matches: [{ id: "codex-search", snippet: "find durable-transcript-needle" }],
    });
    expect(await client.agents.search({ query: "forbidden-assistant-needle" })).toMatchObject({ matches: [] });
});
