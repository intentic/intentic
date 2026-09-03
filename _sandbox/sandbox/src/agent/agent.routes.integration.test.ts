import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, test, vi } from "vitest";
import { SETTLES } from "@intentic/testing/vitest";

import { createApp } from "../app.js";

import type { TranscriptRow } from "@intentic/sandbox-contract";
import type { AgentWorktrees } from "../agents/worktrees.js";
import { attachedRows, clientFor, codexConnectedProxy, collect, errorCode, runAgentTurn, services, withTranslator } from "../route-testing.js";
import { createRequest } from "./agent-requests.js";

/* The agent routes, driven over the daemon's HTTP surface exactly as the browser drives them.
 * Split out of app.integration.test.ts, which had grown to 116 tests across every route in the daemon:
 * one file that two agents working on unrelated features collided in every time. The fakes and the client
 * are shared (route-testing.ts); what lives here is what these routes do. */

/* A WORKTREE SEAM OVER REAL GIT, for the one test that is about git.
 *
 * The harness stubs worktree mechanics on purpose: the worktree suites own them against real disk, but what a
 * turn's ENDING did to the branch and to the main tree cannot be asked of a stub. So only the parts a land
 * actually reaches are real here: a checkout, the branch it sits on, and the main tree it must not touch. The
 * lifecycle members stay inert, exactly as in the harness's own fake: this conversation's checkout is made once,
 * up front, and nothing in the test tears it down. */
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
            exists: async () => true,
            attached: async () => true,
            snapshot: async () => repos,
            ensure: async () => ({ cwd: worktree, branch: `agent/${id}`, repos }),
            remove: async () => {},
            retire: async () => {},
            reapRepoCheckout: async () => {},
            prune: async () => {},
            withRepoLock: (_repo, task) => task(),
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
    // The run is live (parked on the gate): a second start bounces at the door, before any registry work.
    expect(await errorCode(client.agent.run({ prompt: "again", conversationId: "conv1", isolated: true }))).toBe("CONFLICT");
    release?.();
    // Attaching to its end is the settle barrier: the run finished and the registry mutex released.
    const frames = await collect(await client.agent.attach({ conversationId: "conv1" }));
    expect(frames[0]).toMatchObject({ kind: "attached", run: first });
    // The next turn starts, and runs the full isolated path again.
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

/* A SPENT ALLOWANCE IS FILED AS ONE, whatever words the provider spent it in.
 *
 * The refusal a turn files is what the account surfaces read afterwards, and its `kind` picks the sentence they
 * print: a `limit` says the account hit its ceiling, an `auth` says its credential was refused. Google's
 * Antigravity wording is not in the shared spent-allowance list on purpose (failure-sentences.ts), so a routed
 * turn that ran out of weekly headroom used to be filed as `auth`, and the picker told the user to go and
 * reconnect an account whose sign-in was perfect. */
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

/* A LIMIT ON A NATIVE RUNTIME NAMES ITS RESET TOO, which decides whether the chat schedules or guesses.
 *
 * The frame the Codex app-server produces is bare: the adapter reads "rate limit" off OpenAI's own wire and has
 * no allowance object to ask, unlike the Claude Code loop, which dresses its own (error-frames.ts). The route's
 * only fallback was the per-ACCOUNT snapshot, and a native routed turn names no account, it names the
 * subscription serving every Codex turn there is, so that lookup could never hit. The instant was on file the
 * whole time, in the translator's pool reading, and nothing asked it.
 *
 * What the miss cost is in the client: with no instant the pick-up has no `readyAt`, so auto-continue falls back
 * to its bare ladder and spends 5s, 15s and 45s on a window that reopens in two hours, then stands down for
 * good. With it, the chat sleeps to the reset and picks the work up on the far side (conversation.ts). */
test("a spent allowance on a native runtime carries the reset the translator already knew", async () => {
    const reopensAt = Math.floor(Date.now() / 1000) + 7_200;
    const client = clientFor(
        createApp(
            services({
                config: withTranslator,
                cliProxy: { ...codexConnectedProxy, turnLimit: async () => ({ spent: 1, withHeadroom: 0, reopensAt }) },
                // Exactly what codex-agent.ts emits: coded, and with nothing else on it to read.
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
            held: { ran: false },
            resetsAt: reopensAt,
        }),
    );
});

// …and the same runtime says nothing when the reading does not support one. Headroom on file means the quota is
// not what refused the turn (TurnLimit), so there is no reset the user is waiting for, and a frame carrying one
// anyway would send them away for hours over a cooldown that clears in seconds.
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

/* A SPENT ALLOWANCE HOLDS THE TURN, AND SAYING SO ON THE FRAME IS WHAT MAKES CONTINUE MEAN "AGAIN".
 *
 * Asserted end to end, over the two routes together, because the bug lived exactly in the gap between them: the
 * client could only ever answer a refusal by starting a NEW turn, so continuing meant appending a message, and
 * the only honest message is "Continue". One row per press in the record; underneath, one CLI-materialized
 * "Continue from where you left off." and one synthetic "No response requested." per press in the session the
 * model reads back. Four presses, twelve turns of context describing three refusals it was never told about.
 *
 * `ran: false` is the ordinary case and the one worth pinning: an allowance that is already spent refuses the
 * turn's FIRST request, so nothing ran, and the re-run must neither claim otherwise to the model nor return to
 * the session holding that one unanswered message. */
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
    // The fact says the turn is HELD and that nothing ran, which is the whole of what the client needs: a press
    // now re-runs this turn, and the strip can stop claiming there is work behind it.
    expect(first).toContainEqual(expect.objectContaining({ kind: "error", code: "rate_limit", held: { ran: false } }));

    refuse = false;
    const { run } = await client.agent.resume({ conversationId: "conv-held" });
    const frames = await collect(await client.agent.attach({ conversationId: "conv-held" }));
    expect(frames[0]).toMatchObject({ kind: "attached", run });

    expect(seen).toHaveLength(2);
    // The same request again, in full, behind the note that says why it is here and that nothing was done.
    expect(seen[1]!.prompt).toContain("ship the parser");
    expect(seen[1]!.prompt).toMatch(/no part of the request below/i);
    // And NOT onto s-void, whose whole content is the message the provider refused to read.
    expect(seen[1]!.sessionId).toBeUndefined();
    expect(attachedRows(frames).map(({ role, text }) => ({ role, text }))).toContainEqual({ role: "assistant", text: "on it" });
});

// ...and once it is not held, the route says so rather than starting something, which is what sends the client
// back to saying "carry on". A press cannot become a turn nobody asked for just because the daemon forgot.
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

/* DISMISSING A QUESTION ENDS THE TURN, HERE: one request, not the browser's old two.
 *
 * The rule is old: the card was raised because the agent could not choose, so waving it away answers nothing
 * and letting the turn run on means it guesses at the fork it just said it could not guess at. What this pins
 * is that the ending happens where the dismissal lands. Released-then-stopped, as two requests, left the
 * daemon holding a live turn with nothing parked on it for the round trip in between: a working agent, as far
 * as the roster could tell, so the board pulled the card out of Attention to say so and then moved it again
 * when the stop arrived. It also made where the card CAME TO REST a race: whichever request won.
 *
 * `idle` is the resting ending, the one that hands the question to git and puts the card in Finished: NOT the
 * `stopped` a Stop press writes (app.integration.test.ts), which waits in Attention to be picked up. Both are
 * endings the user chose; only one of them is them saying they are done with it. */
test("dismissing a question ends the turn where the dismissal lands, and settles the card as finished", async () => {
    let raised: ((id: string) => void) | undefined;
    const card = new Promise<string>((resolve) => (raised = resolve));
    const client = clientFor(
        createApp(
            services({
                async *agent(request) {
                    // Exactly what the `ask` tool does: the card names the conversation it parked, which is
                    // what lets the reply route end that turn.
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
    // Answering the reply is the whole interaction: it comes back with the turn already unwound, so nothing
    // follows it and the next message cannot collide with a run that is still holding the conversation.
    expect(await client.agent.reply({ kind: "question", requestId, cancelled: true })).toEqual({ ok: true });
    const { agents } = await client.agents.list();
    expect(agents[0]).toMatchObject({ id: "conv1", status: "idle", attention: { question: false } });
    // A reply for a card that is gone is NOT_FOUND, which is what tells a second window to freeze it as stale.
    expect(await errorCode(client.agent.reply({ kind: "question", requestId, cancelled: true }))).toBe("NOT_FOUND");
});

/* A DISMISSED TURN STILL SETTLES ITS BOOKS: on the branch, and nowhere near the main tree.
 *
 * Dismissing ends the turn by aborting it, and an aborted turn used to skip the whole end-of-turn pass. Skipping
 * the LAND is the point: half-finished work the user just waved away must not appear in their workspace. But
 * that pass is also the only moment a conversation reconciles with the world: the worktree's remainder is
 * preserved on the branch, the card's diffstat is refreshed, and a span the main tree has meanwhile taken by
 * another road is marked accounted-for. A conversation the user is done with has no next turn to do it in, which
 * is how a finished card came to sit there offering to land work the workspace already held. */
test("a dismissed question settles the turn's books on the branch, and lands nothing into the main tree", async () => {
    const { work, worktree, worktrees } = await realCheckout("conv1");
    let raised: ((id: string) => void) | undefined;
    const card = new Promise<string>((resolve) => (raised = resolve));
    const client = clientFor(
        createApp(
            services({
                agentWorktrees: worktrees,
                // A REAL checkout has a before-state to pin, which the harness's absent one never does, so this
                // is the one route suite that reaches the turn's anchor store. Nothing here reads it back.
                turnAnchors: { record: async () => {}, of: async () => undefined, all: async () => new Map(), truncate: async () => {} },
                async *agent(request) {
                    // The turn does some work, then hits the fork it cannot call and parks on the card.
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

    // The user's workspace is exactly as they left it: dismissing a question cannot put a line of code in it.
    expect(await sh(work, "status", "--porcelain")).toBe("");
    // The work itself is safe on the branch, and the card counts it: the diffstat only refreshes when the pass
    // ran, so this is what says the books were settled rather than left for a turn that never comes.
    expect(await sh(work, "show", "--name-only", "--format=%s", "agent/conv1")).toContain("app.ts");
    const { agents } = await client.agents.list();
    expect(agents[0]).toMatchObject({ id: "conv1", status: "idle", diff: { files: 1, insertions: 1, deletions: 0 } });
});

/* AN ISOLATED TURN SAYS WHERE ITS MESSAGE CAN BE PUT BACK TO, out loud, in the stream.
 *
 * It always RECORDED that (agent/turn-anchors.ts) and never announced it, and the two reach different readers.
 * The record is what a tab coming back tomorrow reads, through the stamp on a restored transcript. The FRAME is
 * what the tab watching this turn reads: the client hangs the pencil, the rewind and the files-as-they-were fork
 * on it. So an agent chat offered all three on every turn it had RELOADED and on none of the turns it had just
 * watched — which from the chat's side is the affordance appearing at random, since nothing distinguishes those
 * turns from each other.
 *
 * The id is the one sessions/agent-transcript.ts synthesises for the same anchor, so the live tab and the
 * reopened one put the same string on the same message. It needs a REAL checkout to have anything to pin, which
 * is why this sits with the turn-end suite rather than beside the cheaper route tests. */
test("an isolated turn announces the state its message can be rewound to, and files it under that message", async () => {
    const { worktrees } = await realCheckout("conv-anchor");
    const filed: { index: number; kind: string }[] = [];
    const client = clientFor(
        createApp(
            services({
                agentWorktrees: worktrees,
                turnAnchors: {
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

    // The first turn of the conversation, so the message it answers is row 0 of the record, and the checkpoint
    // is stamped on that very row.
    expect(rows[0]).toMatchObject({ role: "user", text: "start it", checkpointId: "worktree:0" });
    // And the frame is not a claim on its own: the state behind it is filed under the same message.
    expect(filed).toEqual([{ index: 0, kind: "worktree" }]);
});

/* A MID-TURN MESSAGE IS PART OF THE RUN, not a note the sending window keeps to itself.
 *
 * The steer used to reach the model and nothing else: the frame log never heard of it, so the settled record was
 * written without it (reopening the chat lost the message outright), every other window rendering the run never
 * drew it, and the one window that did drew it at the END of its own list, while the turn kept typing into the
 * bubble above, printing the answer over the question. All three are the same missing fact, and the frame this
 * asserts is that fact: WHERE in the stream the turn took the words. */
test("a steer taken mid-turn lands in the run's frames, and in the record, between what came before and the answer", async () => {
    let taken: (() => void) | undefined;
    const delivered = new Promise<void>((resolve) => (taken = resolve));
    let running: (() => void) | undefined;
    const started = new Promise<void>((resolve) => (running = resolve));
    const recorded: TranscriptRow[] = [];
    // Spread the harness's own transcripts fake rather than replacing it: the override is shallow, and a
    // transcripts object missing the members the TURN path reads fails the run with a bare "Internal server
    // error" before the agent below is ever called (see route-testing's note on that fake).
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

    // The rows every window draws hold the three speakers in the order the turn took them.
    const [head] = await collect(await client.agent.attach({ conversationId: "conv-steer" }));
    expect(head?.kind === "attached" ? head.rows.map(({ role, text }) => ({ role, text })) : undefined).toEqual([
        { role: "user", text: "ship it" },
        { role: "assistant", text: "on it" },
        { role: "user", text: "and the tests" },
        { role: "assistant", text: "will do" },
    ]);
    // And the copy a reopened chat is drawn from holds the same three speakers in the same order (an isolated
    // turn's record ends on the daemon's line about landing its work, which is none of them).
    await vi.waitFor(() => expect(recorded).not.toHaveLength(0), SETTLES);
    expect(recorded.filter((row) => row.role !== "notice").map(({ role, text }) => ({ role, text }))).toEqual([
        { role: "user", text: "ship it" },
        { role: "assistant", text: "on it" },
        { role: "user", text: "and the tests" },
        { role: "assistant", text: "will do" },
    ]);
});

/* THE LEDGER NOW SAYS HOW A TURN ENDED, and this is the case that used to leave nothing at all.
 *
 * A turn refused before the provider charged a token emits no usage frame, and the ledger used to skip those
 * rows on the reasoning that a zero-cost row would inflate the turn count. So the failures likeliest to arrive
 * in a burst, a dead seat, a spent allowance, a refused token, were exactly the ones that left no record, and
 * "four sessions all broke a minute ago" had to be answered by re-running the destructive act in a live sandbox.
 *
 * The count is protected in the rollup instead (usage-store.ts `billed`), which is why `turns` is 0 here: the
 * row exists for the post-mortem and contributes nothing to the money. */
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
    /* And the experiment metrics are ABSENT, not zero. A turn that died before the provider spoke has no prose
     * and no searches as a matter of arithmetic; fed to the arms as zeros, a burst of refusals would read as
     * whichever arm was running having silenced the model. Absent is the value those readers already discard. */
    expect("proseChars" in (ledger[0] ?? {})).toBe(false);
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
    expect(ledger[0]).toMatchObject({ outcome: "ok", costUsd: 0.5, proseChars: 4 });
    // Nothing failed, so there is no code and no sentence to carry.
    expect("errorCode" in (ledger[0] ?? {})).toBe(false);
    expect("errorMessage" in (ledger[0] ?? {})).toBe(false);
});

/* AND WHETHER ANYTHING CHECKED THE WORK, which `outcome` alone could never say.
 *
 * A turn that proved its edits and a turn that went quiet halfway through its own checklist are both "ok", and
 * the ledger used to write the same row for each. The facts that separate them were all being computed and
 * thrown away at turn end: what was edited, what ran after it, what the agent still had open, how full the
 * window was. Folded off the FRAME stream, so a Codex or Cursor turn is judged exactly as a Claude one is. */
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
// A call that only LOOKS at the tree. Its category is what keeps it out of the edit ledger (trackedCall), which
// is the whole of the difference the silent-ending tests below turn on.
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
    /* The command is the whole reason "verified" is worth writing down: a passing `pnpm test src/parser.test.ts`
     * is evidence about one file, and a row that said only "verified" would let it read as the repo being green. */
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

    /* AND IT IS STILL A FINISHED TURN, which is the carve-out `silentEnding` makes for exactly this shape. The
     * turn said nothing, but it left a diff, a diffstat on its card and a standing to land, so there is
     * something to come back to and the pair of readings below is the honest account of it. Reporting it as a
     * failure as well would overwrite a considered answer with a blunter one. */
    expect(facts.filter((fact) => fact.kind === "error")).toEqual([]);
    await vi.waitFor(() => expect(ledger).toHaveLength(1), SETTLES);
    expect(ledger[0]).toMatchObject({
        outcome: "ok",
        verification: "unproven",
        filesEdited: 1,
        // Two of its own three steps left standing: a turn that abandoned a plan it wrote itself.
        checklistTotal: 3,
        checklistOpen: 2,
        compactions: 1,
        contextTokens: 148_000,
        contextWindow: 200_000,
    });
    // Nothing spoke, so there is no check to name; an absent one is the difference between "you never checked"
    // and "you checked and it broke".
    expect("check" in (ledger[0] ?? {})).toBe(false);
});

/* AND THE ENDING WITH NOTHING TO SHOW FOR IT AT ALL, which is the one shape the daemon used to call a success.
 *
 * A Gemini turn on the OpenCode runtime read and grepped 59 times, changed no file, wrote not one word, and was
 * ended by an ordinary `session.idle`. No error frame, so the row said `outcome: "ok"`, the registry wrote the
 * resting `idle`, and the card settled into the board's Finished lane over an empty assistant bubble: the lane
 * that means "nothing to do here", on the one card that most needed somebody. */
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

    /* The fact is the turn's last word, ahead of its `done`, which is what puts it on the one path every reader
     * of a failed turn already watches: the transcript, the activity record, the ledger below, and the registry,
     * whose `errored` is what moves this card out of Finished and into Attention. */
    expect(facts.at(-1)?.kind).toBe("error");
    const failure = facts.find((fact) => fact.kind === "error");
    expect(failure).toMatchObject({ message: expect.stringContaining("2 tool calls") });
    /* UNCODED, and that is the difference between a red dead end and a way on: an uncoded failure is the one
     * shape the chat answers with a Continue press, which is the whole recovery here (turnFailures.ts). */
    expect("code" in (failure ?? {})).toBe(false);

    await vi.waitFor(() => expect(ledger).toHaveLength(1), SETTLES);
    expect(ledger[0]).toMatchObject({ outcome: "error", errorMessage: expect.stringContaining("nothing to show for it"), filesEdited: 0 });
});

/* The same ending one step earlier: the model thought, and stopped. It is the same failure and it wants a
 * different sentence, because "59 tool calls and then a stop" and "it never got past its own first thought"
 * send a reader to two different places. */
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
    // The whole point of the frame: `error` is what the board reads as the Attention lane (agentStatus.ts).
    expect(agents.find((agent) => agent.id === "conv-thought")).toMatchObject({ status: "error" });
});

/* A REFUSED TURN GETS NO VERDICT, for the same reason it gets no prose count: "it changed no code" is
 * arithmetic when the model never read a word, and a burst of auth refusals would otherwise read as a run of
 * turns that all decided to do nothing. */
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

/* THE MODEL ASKED FOR, BESIDE THE ONE THAT RAN. A pick is resolved past the tier judge, a provider default and
 * a catalog validity check that silently substitutes, and none of those substitutions was recorded, so "I chose
 * one model and got another's error" could only be answered by reading four resolution paths. */
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
    // The wire allows it and the Codex path reads it as "the catalog default", so it is not a pick.
    await runAgentTurn(client, { prompt: "go", conversationId: "conv-blank", model: "" });

    await vi.waitFor(() => expect(ledger).toHaveLength(1), SETTLES);
    expect("modelRequested" in (ledger[0] ?? {})).toBe(false);
});
