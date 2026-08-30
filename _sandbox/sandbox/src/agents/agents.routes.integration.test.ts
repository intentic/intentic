import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { expect, test, vi } from "vitest";
import { SETTLES } from "@intentic/testing/vitest";

import type { RestoredMessage } from "@intentic/sandbox-contract";

import { createApp } from "../app.js";

import type { Services } from "../composition.js";

import { extensionProcessKey } from "../extensions/extension-processes.js";

import {
    clientFor,
    codexConnectedProxy,
    collect,
    errorCode,
    fakeHistory,
    fakeProcesses,
    runAgentTurn,
    services,
    withTranslator,
} from "../route-testing.js";

/* The agents routes, driven over the daemon's HTTP surface exactly as the browser drives them.
 * Split out of app.integration.test.ts, which had grown to 116 tests across every route in the daemon:
 * one file that two agents working on unrelated features collided in every time. The fakes and the client
 * are shared (route-testing.ts); what lives here is what these routes do. */

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

    const events = await runAgentTurn(client, { prompt: "fix tests in intentic", conversationId: "workspace-conv" });
    expect(events.some((event) => event.kind === "worktree")).toBe(false);
    expect(cwd).toBe("/work");
    expect(snapshots).toEqual(["user", "turn"]);
    expect((await client.agents.list()).agents).toMatchObject([{ id: "workspace-conv", status: "idle", sessionId: "sess-workspace", costUsd: 0.25 }]);
    expect((await client.agents.list()).agents[0]).not.toHaveProperty("branch");
    await vi.waitFor(() => expect(spend).toMatchObject([{ conversationId: "workspace-conv" }]), SETTLES);
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
                // The adapter dies on the first pull, before any frame: a provider outage, a missing binary.
                async *agent() {
                    yield await Promise.reject(new Error("adapter crashed"));
                },
            }),
        ),
    );

    /* Preamble frames dropped: an unstubbed git.sync makes every turn in this suite carry a repo-sync note, which
     * is a real injection being really disclosed (agent.routes.ts) and nothing to do with the error path here.
     * The tier verdict goes with it, for the same reason and one more: the complexity judge runs on every turn
     * in the default mode (settings.autoTier "shadow"), so its frame rides ahead of everything a turn does,
     * including a turn that then dies. That it survives an adapter crash is the point of it being emitted at
     * plan time; what this test is about is what comes after. */
    const frames = await runAgentTurn(client, { prompt: "do it", conversationId: "workspace-error" });
    expect(frames.filter((frame) => frame.kind !== "preamble" && frame.kind !== "tier")).toEqual([
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
                async *agent(request) {
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
    // The gate exit must not leave the agent stuck "running": the retry hits the same gate, NOT agent-busy.
    const second = await runAgentTurn(client, { prompt: "hi", conversationId: "conv1", isolated: true });
    expect(second.some((event) => event.kind === "error" && event.code === "agent-busy")).toBe(false);
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
    // A renamed draft's first turn carries the user-chosen title: it wins over the prompt derivation.
    await runAgentTurn(client, { prompt: "fix the login bug", title: "My agent", conversationId: "conv1", isolated: true });
    expect((await client.agents.list()).agents[0]?.title).toBe("My agent");
    const renamed = await client.agents.rename({ id: "conv1", title: "  Login fix  " });
    expect(renamed.title).toBe("Login fix");
    expect((await client.agents.list()).agents[0]?.title).toBe("Login fix");
    expect(await errorCode(client.agents.rename({ id: "nope", title: "x" }))).toBe("NOT_FOUND");
});

/* The fleet filter. Matches the title (which IS the sanitized first prompt) or any later line of the
 * conversation, and (the part the board depends on and no session-level search can give it) it answers over
 * the ARCHIVE too. A board whose filter stopped at the live roster would report "no matches" for an agent
 * sitting one click away behind the archive button. */
test("agents.search matches titles and later lines, across the archive", async () => {
    // Every store read the fleet makes, with the dir it scoped to: an isolated turn's session is filed under
    // the workspace ROOT (its namespace makes the worktree /work), so a read scoped to the worktree path finds
    // nothing and the card redraws as a conversation that never happened.
    const scopedTo: string[] = [];
    const app = createApp(
        services({
            // One SDK session per conversation, told apart by the prompt each turn carries.
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

    // The session the REGISTRY recorded from the turn's own frame, never re-derived from where the turn ran.
    expect(await client.agents.transcript({ id: "conv1" })).toEqual({
        sessionId: "sess-1",
        messages: [
            { role: "user", text: "restored words" },
            { role: "assistant", text: "landAgent lives in laneDrop.ts" },
        ],
    });
    expect(scopedTo).toEqual(["/work"]);
    // An id the registry has never heard of is a 404 ON THE WIRE, not merely a rejected call: the browser reads
    // that exact status as "this conversation has no entry any more" and stops a tab claiming a fleet card
    // nothing on the board can render (see useChat's replayStoredSession). Anything else: a 500, an
    // unreachable daemon: must stay a retryable read, so the status is the contract, not the message.
    await expect(client.agents.transcript({ id: "nope" })).rejects.toThrow();
    expect((await app.request("/agents/nope/transcript")).status).toBe(404);

    // A second turn on the same conversation: its words are in no title, and the transcript store behind this
    // fake never sees them: the routed-prompt index is what keeps them searchable.
    await runAgentTurn(client, { prompt: "also tidy the changelog", conversationId: "conv2", isolated: true });

    // Under two characters the contract refuses: below that everything matches and the scan is pure cost.
    expect(await errorCode(client.agents.search({ query: "a" }))).toBe("BAD_REQUEST");

    // A title hit needs no transcript, so it reports no snippet: the card already shows what it matched on.
    expect(await client.agents.search({ query: "login" })).toEqual({ matches: [{ id: "conv1" }], scanned: 2, indexing: false });
    // The title is the first prompt, so a hit there needs no transcript either.
    expect(await client.agents.search({ query: "readme" })).toEqual({ matches: [{ id: "conv2" }], scanned: 2, indexing: false });
    // …and a hit in a LATER line reports it, with the side of the chat that said it: the whole reason a
    // filtered card is believable.
    expect(await client.agents.search({ query: "changelog" })).toMatchObject({
        matches: [{ id: "conv2", snippet: { text: "also tidy the changelog", speaker: "user" } }],
    });
    // The agent's own reply is matchable too, and says whose words they were: read out of the transcript
    // rather than out of the routed-prompt index, which only ever holds what the user sent.
    expect(await client.agents.search({ query: "lanedrop" })).toMatchObject({
        matches: [{ id: "conv1", snippet: { text: "landAgent lives in laneDrop.ts", speaker: "agent" } }],
    });

    /* THE FIELD'S Aa SWITCH, on the wire. Every assertion above ran with it off, where the letters do not
     * matter; with it on the query stands exactly as typed: over the transcript and over the title alike,
     * since a title hit and a prompt hit are one rule. */
    expect(await client.agents.search({ query: "landAgent", caseSensitive: "true" })).toMatchObject({
        matches: [{ id: "conv1", snippet: { text: "landAgent lives in laneDrop.ts", speaker: "agent" } }],
    });
    expect(await client.agents.search({ query: "landagent", caseSensitive: "true" })).toEqual({ matches: [], scanned: 2, indexing: false });
    expect(await client.agents.search({ query: "Login", caseSensitive: "true" })).toEqual({ matches: [], scanned: 2, indexing: false });

    // Archiving takes conv1 off the roster; the filter must still find it.
    await client.agents.archive({ ids: ["conv1"] });
    expect((await client.agents.list()).agents.map((agent) => agent.id)).toEqual(["conv2"]);
    expect(await client.agents.search({ query: "login" })).toEqual({ matches: [{ id: "conv1" }], scanned: 2, indexing: false });

    expect(await client.agents.search({ query: "nothing here" })).toEqual({ matches: [], scanned: 2, indexing: false });
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
            // Native Codex has no Claude SDK session to search. The daemon transcript is the provider-neutral
            // source, and includes a later prompt that is deliberately absent from the card title. The harness
            // fills the phrase index from this `read` through the real spokenLinesOf, so the assertions below
            // exercise the extraction and the index's own query rather than a hand-picked list.
            transcripts: {
                read: async (agent) => codexSearchTranscript(agent.id),
                open: async () => {},
                fork: async () => {},
                append: async () => {},
                // Derived from the same record `read` answers from, so the fake cannot contradict itself.
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
    // The agent's half of that same record is searchable, and reports itself as the agent's.
    expect(await client.agents.search({ query: "assistant-needle" })).toMatchObject({
        matches: [{ id: "codex-search", snippet: { text: "I mentioned an assistant-needle", speaker: "agent" } }],
    });
});

/* THE LAND GUARD, which is narrower than the one archive and discard sit behind (agents.routes.ts landable).
 *
 * A land only READS the agent's checkout, so the question it has to answer is not "is a turn alive" but "is
 * anyone mid-sentence". These three cover the whole of that distinction, because the first two states are the
 * ones a single `running` flag used to flatten into one refusal.
 *
 * `landed: false` is the tell that the guard PASSED: these fakes point main at a directory that does not
 * exist, so a land that runs at all reports that per repo and lands nothing. What is under test is which
 * calls reach the land, not what the land then makes of a stub composition. */
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
    // Parked on the gate with nothing raised: the agent is writing, which is the one state that refuses.
    expect(await errorCode(client.agents.land({ id: "conv1" }))).toBe("CONFLICT");
    // The user's deliberate override: the press behind the warning modal.
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
    /* The park has to have been observed before the guard is asked: the frame travels the relay to get there,
     * behind the turn's own worktree setup. That is real machine work: ~0.4s idle, and several times that on a
     * runner carrying the rest of the suite beside it. On SETTLES for the same reason the integration suite
     * has its own testTimeout (both in _tools/testing/vitest.ts): waitFor's 1s default is a hang detector,
     * and held to it this poll went green on an idle box and red under load, taking the four tests after it
     * down with it: a wait that expires here skips the release below, and the gated turn it leaves parked
     * holds conv1's slot in the run map for the rest of the file. */
    await vi.waitFor(async () => expect((await client.agents.list()).agents[0]?.status).toBe("awaiting"), SETTLES);
    // No `force`, and no refusal: this is the state the old guard sent the user away to wait on, when the
    // thing being waited for could only end once they came back and answered.
    expect(await client.agents.land({ id: "conv1" })).toMatchObject({ landed: false });
    release?.();
    await collect(await client.agent.attach({ conversationId: "conv1" }));
});

// The turn OUTLIVES the land, so the land must not close its books: `finish` releases the conversation mutex
// and writes how the turn ended, and a mid-write land calling it would free the mutex a second turn could
// claim beside the first. The card must still read as live afterwards, and the turn must still settle itself.
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
    // Still running: the land recorded its own outcome and left the turn alone.
    expect((await client.agents.list()).agents[0]?.status).toBe("running");
    release?.();
    await collect(await client.agent.attach({ conversationId: "conv1" }));
    // And the turn's own ending still lands: usage flushed, mutex released, status settled.
    const { agents } = await client.agents.list();
    expect(agents[0]).toMatchObject({ id: "conv1", costUsd: 0.25 });
    expect(agents[0]?.status).not.toBe("running");
});

/* WHAT A NAMED ARCHIVE DOES NOT DO FIRST.
 *
 * The standing probe answers "which agents would the board call finished right now": a question only the bulk
 * press has to ask, since it is the one deciding what qualifies. A named archive has already been decided, by
 * the user, about a card in front of them.
 *
 * Asking anyway made one click cost a probe over the whole live roster. That is nearly free while the verdicts
 * still hold, and a git pass per agent the moment anything moves the main line, which is why archiving one
 * card on a board carrying a thousand sessions was fast most of the time and interminable the rest of it. */
test("archiving a named agent asks nothing of the rest of the fleet; clearing the lane still does", async () => {
    const daemon = services();
    const probe = vi.spyOn(daemon.agents, "refreshStandings");
    const client = clientFor(createApp(daemon));
    await runAgentTurn(client, { prompt: "fix it", conversationId: "conv1", isolated: true });
    await runAgentTurn(client, { prompt: "and this", conversationId: "conv2", isolated: true });
    // The roster read is self-healing and probes on purpose (agents.routes list): this test is about the press.
    probe.mockClear();

    await client.agents.archive({ ids: ["conv1"] });

    expect(probe).not.toHaveBeenCalled();
    expect((await client.agents.archived()).agents.map((agent) => agent.id)).toEqual(["conv1"]);

    probe.mockClear();
    await client.agents.archive({});

    expect(probe).toHaveBeenCalledTimes(1);
    expect((await client.agents.archived()).agents.map((agent) => agent.id)).toEqual(["conv2", "conv1"]);
});

/* AN ARCHIVE THAT CANNOT RELEASE A WORKING COPY SAYS SO, on the wire, which is the whole of the report behind
 * this: the failure was warned to the daemon's log and the answer carried nothing, so the board could only read
 * it as "there was nothing to archive" and told the user exactly that, about a card still in front of them.
 * Now the refusal travels with its own sentence and the card stays where it is. */
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
    // One line, not git's paragraph: this is what the board prints on its strip.
    expect(answer.failed).toEqual([{ id: "conv1", reason: "fatal: not a git repository: /work/vendor/.git/worktrees/vendor" }]);
    expect((await client.agents.list()).agents.map((agent) => agent.id)).toEqual(["conv1"]);
});

/* SPEAKING AS THE AGENT, end to end: the placed row lands in the record marked for human readers, the provider
 * session is retired rewind-style, and the NEXT turn (resuming nothing) is seeded from the record, where the
 * planted line reaches the model as its own prior words with the mark nowhere in sight. That last assertion is
 * the feature's whole contract; the transcript looking right is merely its visible half. */
test("agents.place appends the user's words as the agent's, retires the session, and the next turn reads them as its own", async () => {
    // A working in-memory record (the harness default is inert on append): place appends through the same door
    // a settled turn does, and the handoff reads back through the same `read`.
    const records = new Map<string, RestoredMessage[]>();
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
                    open: async (agent) => void (records.has(agent.id) || records.set(agent.id, [])),
                    fork: async () => {},
                    append: async (agent, messages) => void records.set(agent.id, [...(records.get(agent.id) ?? []), ...messages]),
                    count: async (agent) => (records.get(agent.id) ?? []).length,
                    truncate: async () => 0,
                },
            }),
        ),
    );
    await runAgentTurn(client, { prompt: "map the login flow", conversationId: "conv1", isolated: true });
    expect((await client.agents.list()).agents[0]).toMatchObject({ id: "conv1", sessionId: "sess-live" });

    expect(await client.agents.place({ id: "conv1", text: "I checked the tests and they pass." })).toEqual({ ok: true });

    // The record's newest row is the placed line, marked: the transcript route serves it to every reopening tab.
    expect((await client.agents.transcript({ id: "conv1" })).messages.at(-1)).toEqual({
        role: "assistant",
        text: "I checked the tests and they pass.",
        placed: true,
    });
    // The session pointer is gone (only the pointer: the record above is what the conversation reads back as).
    expect((await client.agents.list()).agents[0]).not.toHaveProperty("sessionId");

    await runAgentTurn(client, { prompt: "carry on", conversationId: "conv1", isolated: true });
    const next = requests.at(-1);
    // Resumed nothing…
    expect(next?.sessionId).toBeUndefined();
    // …so the fresh session is seeded from the record, where the planted line is the agent's own words…
    expect(next?.prompt).toContain("Assistant: I checked the tests and they pass.");
    // …and the human-facing mark is nowhere in what the model reads.
    expect(next?.prompt).not.toContain("placed");

    // An id the registry has never heard of has no transcript to place into.
    expect(await errorCode(client.agents.place({ id: "ghost", text: "boo" }))).toBe("NOT_FOUND");
});

/* SPEAKING AS THE AGENT IN A CHANNEL CONVERSATION: the placed line has a second audience. A conversation woken
 * by an outside message (origin.channelId) is a thread somebody is watching from Discord/Slack/Telegram, so the
 * daemon carries the line out through the provider's gateway (its loopback /deliver door) BEFORE appending, and
 * a delivery that cannot happen refuses the whole place: the record never holds a sentence the channel did not
 * get. These suites run against the repo's real _extensions manifests (testConfig.extensionsDir), which is how
 * "discord has a gateway extension, webchat does not" is the same fact production reads. */

// The in-memory record + one-frame turn the channel-place tests share; `ports` seeds the fake process table so
// a test decides whether the discord gateway "runs" (and where its /deliver door answers).
const channelPlaceHarness = (ports: Record<string, number>, activity?: unknown[]) => {
    const records = new Map<string, RestoredMessage[]>();
    const client = clientFor(
        createApp(
            services({
                async *agent() {
                    yield { kind: "session", sessionId: "sess-live" };
                    yield { kind: "done" };
                },
                transcripts: {
                    read: async (agent) => records.get(agent.id) ?? [],
                    open: async (agent) => void (records.has(agent.id) || records.set(agent.id, [])),
                    fork: async () => {},
                    append: async (agent, messages) => void records.set(agent.id, [...(records.get(agent.id) ?? []), ...messages]),
                    count: async (agent) => (records.get(agent.id) ?? []).length,
                    truncate: async () => 0,
                },
                processes: fakeProcesses(ports),
                ...(activity !== undefined
                    ? { activity: { append: async (event: unknown) => void activity.push(event), list: async () => [] } }
                    : {}),
            }),
        ),
    );
    return { client, records };
};

// A local stand-in for a connector gateway's loopback surface: records every /deliver body, answers as told.
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
        // The channel got the exact line, addressed by the origin's own channel id…
        expect(gateway.deliveries).toEqual([{ path: "/deliver", body: { channelId: "123", text: "On it. checking now." } }]);
        // …the record holds it marked, exactly as an ordinary place would…
        expect((await client.agents.transcript({ id: "conv1" })).messages.at(-1)).toEqual({
            role: "assistant",
            text: "On it. checking now.",
            placed: true,
        });
        // …and the activity feed shows the channel was told, the same row an agent's own send leaves.
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
    // Nothing appended and the session pointer kept: the conversation is exactly as it was before the attempt.
    expect((records.get("conv1") ?? []).some((message) => message.placed === true)).toBe(false);
    expect((await client.agents.list()).agents[0]).toMatchObject({ sessionId: "sess-live" });
});

test("agents.place surfaces the gateway's own refusal sentence", async () => {
    const gateway = await fakeGateway({ status: 500, body: "no connected Discord bot can post in this channel" });
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
        expect(message).toBe("no connected Discord bot can post in this channel");
    } finally {
        gateway.close();
    }
});

// A webchat (or webhook) origin has no gateway extension: there is nothing to carry the line, and that is the
// ordinary place, not a failure: the visitor transport only exists while a turn streams (webchat.routes.ts).
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

// The illusion can only be established between turns: a running turn holds the very session placing exists to
// retire, and the lease place takes is the turn's own mutex: same refusal shape as land/discard.
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
