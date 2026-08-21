import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, test, vi } from "vitest";
import { SETTLES } from "@intentic/testing/vitest";

import { createApp } from "../app.js";

import type { RestoredMessage } from "@intentic/sandbox-contract";
import type { AgentWorktrees } from "../agents/worktrees.js";
import { clientFor, collect, errorCode, runAgentTurn, services } from "../route-testing.js";
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
                agent: async function* () {
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
    const events = await runAgentTurn(client, { prompt: "after", conversationId: "conv1", isolated: true });
    expect(events[0]).toMatchObject({ kind: "worktree" });
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
                agent: async function* () {
                    yield { kind: "error", code: "rate_limit", message: "429 RESOURCE_EXHAUSTED: no headroom left" };
                    yield { kind: "done" };
                },
                providerRefusals: {
                    read: async () => ({}),
                    record: async (_provider, refusal) => void filed.push({ kind: refusal.kind, message: refusal.message }),
                    clear: async () => {},
                },
            }),
        ),
    );
    await runAgentTurn(client, { prompt: "keep going", conversationId: "conv-limit" });
    expect(filed).toEqual([{ kind: "limit", message: "429 RESOURCE_EXHAUSTED: no headroom left" }]);
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
                agent: async function* (request) {
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
                agent: async function* (request) {
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
    const recorded: RestoredMessage[] = [];
    // Spread the harness's own transcripts fake rather than replacing it: the override is shallow, and a
    // transcripts object missing the members the TURN path reads fails the run with a bare "Internal server
    // error" before the agent below is ever called (see route-testing's note on that fake).
    const { transcripts } = services({});
    const client = clientFor(
        createApp(
            services({
                transcripts: { ...transcripts, append: async (_agent, messages) => void recorded.push(...messages) },
                agent: async function* () {
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

    const frames = (await collect(await client.agent.attach({ conversationId: "conv-steer" }))).flatMap((frame) =>
        frame.kind === "frame" ? [frame.event] : [],
    );
    expect(frames.filter((event) => event.kind === "delta" || event.kind === "steer")).toEqual([
        { kind: "delta", text: "on it" },
        { kind: "steer", text: "and the tests", sentAt: expect.any(Number) },
        { kind: "delta", text: "will do" },
    ]);
    // And the copy a reopened chat is drawn from holds the same three speakers in the same order.
    await vi.waitFor(() => expect(recorded).not.toHaveLength(0), SETTLES);
    expect(recorded.map(({ role, text }) => ({ role, text }))).toEqual([
        { role: "user", text: "ship it" },
        { role: "assistant", text: "on it" },
        { role: "user", text: "and the tests" },
        { role: "assistant", text: "will do" },
    ]);
});
