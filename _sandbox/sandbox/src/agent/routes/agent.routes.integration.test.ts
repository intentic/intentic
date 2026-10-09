import { rm, writeFile } from "node:fs/promises";
import { WORKSPACE_ROOT } from "@intentic/constants";
import { join } from "node:path";
import { waitFor, SETTLES } from "@intentic/testing/bun";

import { createApp } from "../../app.js";

import { type AgentEvent, RESUME_NOTES, type TranscriptRow, SandboxSettingsSchema } from "@intentic/sandbox-contract";
import { experimentArm } from "@intentic/agent-context/experiments";
import { clientFor, collect, errorCode } from "../../harness/route-client.testing.js";
import { gitOut, realCheckout } from "../../harness/route-fakes.testing.js";
import { codexConnectedProxy, services, withTranslator } from "../../harness/route-services.testing.js";
import { attachedRows, runAgentTurn, startedRun } from "../../harness/route-turns.testing.js";
import { createTurnResumeScheduler, ROOM_SETTLE_MS } from "../run/turn/turn-resume.js";
import { FIRST_RECHECK_MS, type SeatProbe } from "../../runtimes/claude/claude-seat-check.js";
import { BACK_ON, memorySeats, scriptedSeatCheck, STILL_OFF } from "../../runtimes/claude/claude-seat-check.testing.js";

// Exercises the agent routes over the daemon's HTTP surface, as the browser does. Shared fakes and client live in
// route-services.testing.ts and its siblings.

// Real git only for what a land actually touches (checkout, branch, main tree); other worktree lifecycle members stay
// the harness's inert fakes.
const tempDirs: string[] = [];
afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
        await rm(dir, { recursive: true, force: true });
    }
});

// A real checkout, removed after the test that made it.
const checkout = async (id: string): ReturnType<typeof realCheckout> => {
    const made = await realCheckout(id);
    tempDirs.push(made.root);
    return made;
};

test("agent.run rejects an empty prompt", async () => {
    const client = clientFor(createApp(services()));
    expect(await errorCode(client.agent.run({ prompt: "" }))).toBe("BAD_REQUEST");
});

test("a second message while a turn runs goes into that turn rather than beside it, and the next turn waits for it to settle", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let running: (() => void) | undefined;
    const started = new Promise<void>((resolve) => (running = resolve));
    const client = clientFor(
        createApp(
            services({
                async *agent() {
                    running?.();
                    await gate;
                    yield { kind: "done" };
                },
            }),
        ),
    );
    const first = await startedRun(client, { prompt: "long task", conversationId: "conv1", isolated: true });
    await started;
    // This runtime takes words mid-turn, so they are said into the turn already running.
    expect(await client.agent.run({ prompt: "again", conversationId: "conv1", isolated: true })).toEqual({ delivered: "steered", run: first });
    release?.();
    const frames = await collect(await client.agent.attach({ conversationId: "conv1" }));
    expect(frames[0]).toMatchObject({ kind: "attached", run: first });
    const { facts } = await runAgentTurn(client, { prompt: "after", conversationId: "conv1", isolated: true });
    expect(facts[0]).toMatchObject({ kind: "worktree" });
});

// A turn per gate, each held open until released or stopped, so one run can be over while the next is live.
const gatedTurns = (): { readonly gates: (() => void)[]; readonly services: ReturnType<typeof services> } => {
    const gates: (() => void)[] = [];
    return {
        gates,
        services: services({
            async *agent(request) {
                await new Promise<void>((release) => {
                    gates.push(release);
                    request.signal.addEventListener("abort", () => release(), { once: true });
                });
                yield { kind: "done" };
            },
        }),
    };
};

// The press raced the turn's own end, and the conversation has started another since: cancelling "whatever runs" would
// kill a turn the person never saw.
test("a stop naming a turn that has ended cancels nothing, and names the run live instead", async () => {
    const { gates, services: turns } = gatedTurns();
    const client = clientFor(createApp(turns));
    const first = await startedRun(client, { prompt: "one", conversationId: "conv-stop", isolated: true, messageId: "m-one" });
    await waitFor(() => expect(gates).toHaveLength(1), SETTLES);
    gates[0]?.();
    await collect(await client.agent.attach({ conversationId: "conv-stop" }));
    const second = await startedRun(client, { prompt: "two", conversationId: "conv-stop", isolated: true, messageId: "m-two" });
    await waitFor(() => expect(gates).toHaveLength(2), SETTLES);

    expect(await client.agent.stop({ conversationId: "conv-stop", run: first })).toEqual({ stopped: false, running: second });
    expect(await client.agent.stop({ conversationId: "conv-stop", messageId: "m-one" })).toEqual({ stopped: false, running: second });
    // The message the live turn carries names it as surely as its run does: a send not yet answered knows only that.
    expect(await client.agent.stop({ conversationId: "conv-stop", messageId: "m-two" })).toEqual({ stopped: true });
    expect(await client.agent.stop({ conversationId: "conv-stop", run: second })).toEqual({ stopped: false });
});

test("a stop that cannot name its turn cancels whatever runs", async () => {
    const { gates, services: turns } = gatedTurns();
    const client = clientFor(createApp(turns));
    await client.agent.run({ prompt: "one", conversationId: "conv-live", isolated: true });
    await waitFor(() => expect(gates).toHaveLength(1), SETTLES);

    expect(await client.agent.stop({ conversationId: "conv-live", live: true })).toEqual({ stopped: true });
    expect(await client.agent.stop({ conversationId: "conv-live", live: true })).toEqual({ stopped: false });
});

// Another window rewound and a turn ran since this one read the transcript, so position 0 now holds a different
// message; restoring its checkpoint would put back a point the person never chose.
test("a rewind naming a message its position no longer holds is refused as stale, before anything is restored", async () => {
    const restored: string[] = [];
    const { transcripts, history } = services({});
    const client = clientFor(
        createApp(
            services({
                transcripts: {
                    ...transcripts,
                    page: async () => ({ rows: [{ role: "user", text: "the reworded ask", messageId: "m-after" }], from: 0, more: false }),
                },
                history: {
                    ...history,
                    restore: async (id) => {
                        restored.push(id);
                        return true;
                    },
                },
            }),
        ),
    );

    expect(await errorCode(client.agent.rewind({ conversationId: "conv-rewound", index: 0, messageId: "m-before" }))).toBe("PRECONDITION_FAILED");
    expect(restored).toEqual([]);
});

// A send whose answer was lost is sent again under the same id: the sandbox answers with what the first one did.
test("a message sent again under an id the sandbox took is answered as a duplicate, and starts no second turn", async () => {
    const { gates, services: turns } = gatedTurns();
    const client = clientFor(createApp(turns));
    const send = { prompt: "tidy the docs", conversationId: "conv-again", isolated: true, messageId: "m-1" };

    const first = await client.agent.run(send);
    expect(first).toEqual({ delivered: "started", run: expect.any(String) });
    expect(await client.agent.run(send)).toEqual({ delivered: "started", run: first.run, duplicate: true });
    await waitFor(() => expect(gates).toHaveLength(1), SETTLES);
    gates[0]?.();
    await collect(await client.agent.attach({ conversationId: "conv-again" }));
    // Its turn being over does not make the same message a new one.
    expect(await client.agent.run(send)).toEqual({ delivered: "started", run: first.run, duplicate: true });
    expect(gates).toHaveLength(1);
});

// A daemon that restarted since knows the message only from its row: the record keeps each message's id and its run.
test("a message the record already holds is answered from its row, after a restart forgot the answer", async () => {
    const asked: string[] = [];
    const { transcripts } = services({});
    const client = clientFor(
        createApp(
            services({
                transcripts: {
                    ...transcripts,
                    page: async () => ({
                        rows: [
                            { role: "user", text: "tidy the docs", messageId: "m-7", run: "r-before" },
                            { role: "assistant", text: "tidied", run: "r-before" },
                            { role: "user", text: "and the tests", messageId: "m-8", run: "r-before" },
                        ],
                        from: 0,
                        more: false,
                    }),
                },
                async *agent(request) {
                    asked.push(request.spec.prompt);
                    yield { kind: "done" };
                },
            }),
        ),
    );

    expect(await client.agent.run({ prompt: "tidy the docs", conversationId: "conv-restarted", messageId: "m-7" })).toEqual({
        delivered: "started",
        run: "r-before",
        duplicate: true,
    });
    expect(await client.agent.steer({ conversationId: "conv-restarted", text: "and the tests", messageId: "m-8" })).toEqual({
        delivered: "steered",
        run: "r-before",
        duplicate: true,
    });
    expect(asked).toEqual([]);
});

// A runtime that takes no words mid-turn (the opencode loop behind Grok): each turn held open until released or stopped,
// and every prompt it was handed kept, in order.
const unsteerableTurns = (): { readonly gates: (() => void)[]; readonly prompts: string[]; readonly services: ReturnType<typeof services> } => {
    const gates: (() => void)[] = [];
    const prompts: string[] = [];
    const { openCode } = services({});
    return {
        gates,
        prompts,
        services: services({
            openCode: { ...openCode, connected: async () => true },
            async *grokAgent(request) {
                prompts.push(request.spec.prompt);
                await new Promise<void>((release) => {
                    gates.push(release);
                    request.signal.addEventListener("abort", () => release(), { once: true });
                });
                yield { kind: "done" };
            },
        }),
    };
};

// The conversation's queue as every window reads it, off its roster card.
const queueOf = async (client: ReturnType<typeof clientFor>, conversationId: string) =>
    (await client.agents.list()).agents.find((agent) => agent.id === conversationId)?.queue;

describe("the conversation's queue", () => {
    it("holds a message the running turn cannot take, shows it on the card, and starts the next turn with it once this one settles", async () => {
        const { gates, prompts, services: turns } = unsteerableTurns();
        const client = clientFor(createApp(turns));
        await startedRun(client, { prompt: "draft the release notes", conversationId: "conv-q", agent: "grok", messageId: "m-1" });
        await waitFor(() => expect(gates).toHaveLength(1), SETTLES);

        expect(await client.agent.run({ prompt: "and the changelog", conversationId: "conv-q", agent: "grok", messageId: "m-2" })).toEqual({
            delivered: "queued",
        });
        expect(await queueOf(client, "conv-q")).toEqual({
            items: [{ id: "m-2", text: "and the changelog", voice: "person", queuedAt: expect.any(Number), revision: 1 }],
            revision: 1,
        });

        gates[0]?.();
        await waitFor(() => expect(gates).toHaveLength(2), SETTLES);
        expect(prompts[1]).toContain("and the changelog");
        // The same message sent again is answered with where it went: the turn it started.
        const again = await client.agent.run({ prompt: "and the changelog", conversationId: "conv-q", agent: "grok", messageId: "m-2" });
        expect(again).toEqual({ delivered: "started", run: expect.any(String), duplicate: true });
        expect(await queueOf(client, "conv-q")).toEqual({ items: [], revision: 2 });
        gates[1]?.();
    });

    it("rides several waiting messages out as one turn, in the order they were written", async () => {
        const { gates, prompts, services: turns } = unsteerableTurns();
        const client = clientFor(createApp(turns));
        await startedRun(client, { prompt: "draft the release notes", conversationId: "conv-many", agent: "grok" });
        await waitFor(() => expect(gates).toHaveLength(1), SETTLES);
        await client.agent.run({ prompt: "and the changelog", conversationId: "conv-many", agent: "grok" });
        await client.agent.run({ prompt: "then tag it", conversationId: "conv-many", agent: "grok" });

        gates[0]?.();
        await waitFor(() => expect(gates).toHaveLength(2), SETTLES);
        expect(prompts[1]).toContain("and the changelog\n\nthen tag it");
        gates[1]?.();
    });

    // The composer's scheduled send, for an allowance the person knows is spent: nothing starts, nothing reaches the
    // provider, and the words wait on the card, scheduled, until the resume pass lets them go at their instant.
    it("holds a scheduled send on the card without starting a turn, and lets it go when its time comes", async () => {
        const { gates, prompts, services: turns } = unsteerableTurns();
        const client = clientFor(createApp(turns));
        await startedRun(client, { prompt: "draft the release notes", conversationId: "conv-at", agent: "grok" });
        await waitFor(() => expect(gates).toHaveLength(1), SETTLES);
        gates[0]?.();
        await collect(await client.agent.attach({ conversationId: "conv-at" }));

        const at = Date.now() + 60 * 60 * 1000;
        expect(await client.agent.run({ prompt: "and the changelog", conversationId: "conv-at", agent: "grok", messageId: "m-at", sendAt: at })).toEqual({
            delivered: "queued",
        });
        expect(await queueOf(client, "conv-at")).toMatchObject({ items: [{ id: "m-at", text: "and the changelog", until: at }], paused: "scheduled", until: at });
        expect(gates).toHaveLength(1);

        const pass = createTurnResumeScheduler(turns);
        await pass.tick(at - 1);
        expect(gates).toHaveLength(1);
        await pass.tick(at);
        await waitFor(() => expect(gates).toHaveLength(2), SETTLES);
        expect(prompts[1]).toContain("and the changelog");
        expect((await queueOf(client, "conv-at"))?.items).toEqual([]);
        gates[1]?.();
    });

    // A message that opens its conversation can wait too: the card is on the board from the press, scheduled, with the
    // answers the opening message gave, and the turn it starts at its time is that conversation's first.
    it("opens the conversation on the board for a scheduled first message, and starts its first turn at the time", async () => {
        const { gates, prompts, services: turns } = unsteerableTurns();
        const client = clientFor(createApp(turns));
        const at = Date.now() + 60 * 60 * 1000;
        expect(
            await client.agent.run({
                prompt: "write the migration guide",
                conversationId: "conv-new-at",
                agent: "grok",
                isolated: true,
                messageId: "m-first",
                sendAt: at,
                conversationAutoLand: true,
            }),
        ).toEqual({ delivered: "queued" });
        const card = (await client.agents.list()).agents.find((agent) => agent.id === "conv-new-at");
        expect(card).toMatchObject({
            status: "idle",
            title: "Write the migration guide",
            branch: "agent/conv-new-at",
            autoLand: true,
            queue: { items: [{ id: "m-first", text: "write the migration guide" }], paused: "scheduled", until: at },
        });
        expect(gates).toHaveLength(0);

        await createTurnResumeScheduler(turns).tick(at);
        await waitFor(() => expect(gates).toHaveLength(1), SETTLES);
        expect(prompts[0]).toContain("write the migration guide");
        expect((await queueOf(client, "conv-new-at"))?.items).toEqual([]);
        gates[0]?.();
        await collect(await client.agent.attach({ conversationId: "conv-new-at" }));

        // A time already past has nothing to wait for.
        expect(await client.agent.run({ prompt: "late", conversationId: "conv-new-at", agent: "grok", sendAt: Date.now() - 1 })).toMatchObject({
            delivered: "started",
        });
        await waitFor(() => expect(gates).toHaveLength(2), SETTLES);
        gates[1]?.();
    });

    // Scheduling is the person choosing when the words go: a turn running when they press is not that moment.
    it("holds a send booked while a turn runs, and lets it go at its time rather than when that turn ends", async () => {
        const { gates, prompts, services: turns } = unsteerableTurns();
        const client = clientFor(createApp(turns));
        await startedRun(client, { prompt: "draft the release notes", conversationId: "conv-live-at", agent: "grok" });
        await waitFor(() => expect(gates).toHaveLength(1), SETTLES);
        const at = Date.now() + 60 * 60 * 1000;
        expect(await client.agent.run({ prompt: "then tag it", conversationId: "conv-live-at", agent: "grok", sendAt: at })).toEqual({ delivered: "queued" });

        gates[0]?.();
        await collect(await client.agent.attach({ conversationId: "conv-live-at" }));
        expect(await queueOf(client, "conv-live-at")).toMatchObject({ items: [{ text: "then tag it" }], paused: "scheduled", until: at });
        expect(gates).toHaveLength(1);

        await createTurnResumeScheduler(turns).tick(at);
        await waitFor(() => expect(gates).toHaveLength(2), SETTLES);
        expect(prompts[1]).toContain("then tag it");
        gates[1]?.();
    });

    // A Stop ends the turn that runs, and holds what waited behind it for a press; a message booked for a time or another
    // agent's land is the person's own appointment, which it leaves alone.
    it("keeps a send booked while a turn runs when that turn is stopped, and lets it go at its time", async () => {
        const { gates, prompts, services: turns } = unsteerableTurns();
        const client = clientFor(createApp(turns));
        await startedRun(client, { prompt: "draft the release notes", conversationId: "conv-stop-at", agent: "grok" });
        await waitFor(() => expect(gates).toHaveLength(1), SETTLES);
        const at = Date.now() + 60 * 60 * 1000;
        await client.agent.run({ prompt: "then tag it", conversationId: "conv-stop-at", agent: "grok", sendAt: at });

        expect(await client.agent.stop({ conversationId: "conv-stop-at", live: true })).toEqual({ stopped: true });
        await collect(await client.agent.attach({ conversationId: "conv-stop-at" }));
        expect(await queueOf(client, "conv-stop-at")).toMatchObject({ items: [{ text: "then tag it", until: at }], paused: "scheduled", until: at });

        const pass = createTurnResumeScheduler(turns);
        await pass.tick(at - 1);
        expect(gates).toHaveLength(1);
        await pass.tick(at);
        await waitFor(() => expect(gates).toHaveLength(2), SETTLES);
        expect(prompts[1]).toContain("then tag it");
        gates[1]?.();
    });

    // The archive refuses a conversation holding a booked message, but one filed away by any other road (the aged sweep
    // reads the same rule, an older editor does not) must not lose the person's words when their time comes: the booking
    // is their say-so, as their message was, and reopens the conversation.
    it("starts a booked message's turn in a conversation archived since, rather than dropping the person's words", async () => {
        const { gates, prompts, services: turns } = unsteerableTurns();
        const client = clientFor(createApp(turns));
        await startedRun(client, { prompt: "draft the release notes", conversationId: "conv-filed-at", agent: "grok" });
        await waitFor(() => expect(gates).toHaveLength(1), SETTLES);
        gates[0]?.();
        await collect(await client.agent.attach({ conversationId: "conv-filed-at" }));
        const at = Date.now() + 60 * 60 * 1000;
        await client.agent.run({ prompt: "then tag it", conversationId: "conv-filed-at", agent: "grok", sendAt: at });
        await turns.agents.setArchived(["conv-filed-at"], Date.now());

        await createTurnResumeScheduler(turns).tick(at);
        await waitFor(() => expect(gates).toHaveLength(2), SETTLES);
        expect(prompts[1]).toContain("then tag it");
        expect((await client.agents.archived()).agents).toEqual([]);
        gates[1]?.();
    });

    // Work that builds on another agent's waits for that agent's work to be in the workspace: here a conversation in the
    // shared tree, whose work is there as soon as its turn ends clean.
    it("holds a message until the conversation it waits for has finished with its work in, and lets it go then", async () => {
        const { gates, prompts, services: turns } = unsteerableTurns();
        const client = clientFor(createApp(turns));
        await startedRun(client, { prompt: "rename the auth module", conversationId: "conv-first", agent: "grok" });
        await waitFor(() => expect(gates).toHaveLength(1), SETTLES);

        expect(
            await client.agent.run({ prompt: "update the docs for it", conversationId: "conv-next", agent: "grok", messageId: "m-next", sendAfter: "conv-first" }),
        ).toEqual({ delivered: "queued" });
        expect(await queueOf(client, "conv-next")).toEqual({
            items: [{ id: "m-next", text: "update the docs for it", voice: "person", queuedAt: expect.any(Number), revision: 1, after: "conv-first" }],
            revision: 1,
            paused: "scheduled",
            after: "conv-first",
        });
        const pass = createTurnResumeScheduler(turns);
        await pass.tick();
        expect(gates).toHaveLength(1);

        gates[0]?.();
        await collect(await client.agent.attach({ conversationId: "conv-first" }));
        await pass.tick();
        await waitFor(() => expect(gates).toHaveLength(2), SETTLES);
        expect(prompts[1]).toContain("update the docs for it");
        gates[1]?.();
    });

    it("sends at once after a conversation with nothing left to land, and refuses to wait for one that cannot land", async () => {
        const { gates, services: turns } = unsteerableTurns();
        const client = clientFor(createApp(turns));
        await startedRun(client, { prompt: "rename the auth module", conversationId: "conv-done", agent: "grok" });
        await waitFor(() => expect(gates).toHaveLength(1), SETTLES);
        gates[0]?.();
        await collect(await client.agent.attach({ conversationId: "conv-done" }));

        expect(await client.agent.run({ prompt: "update the docs", conversationId: "conv-after-done", agent: "grok", sendAfter: "conv-done" })).toMatchObject({
            delivered: "started",
        });
        await waitFor(() => expect(gates).toHaveLength(2), SETTLES);
        gates[1]?.();
        expect(await errorCode(client.agent.run({ prompt: "wait for nobody", conversationId: "conv-orphan", agent: "grok", sendAfter: "conv-nobody" }))).toBe(
            "BAD_REQUEST",
        );
        expect(await errorCode(client.agent.run({ prompt: "wait for myself", conversationId: "conv-self", agent: "grok", sendAfter: "conv-self" }))).toBe(
            "BAD_REQUEST",
        );
    });

    // What waits can be re-timed from any window: another instant, another conversation's land, or now when that has come.
    it("re-times what waits, and lets it go when what it would wait for has already come", async () => {
        const { gates, prompts, services: turns } = unsteerableTurns();
        const client = clientFor(createApp(turns));
        const at = Date.now() + 60 * 60 * 1000;
        await client.agent.run({ prompt: "write the guide", conversationId: "conv-retime", agent: "grok", sendAt: at });
        await startedRun(client, { prompt: "rename the auth module", conversationId: "conv-other", agent: "grok" });
        await waitFor(() => expect(gates).toHaveLength(1), SETTLES);

        // Named by no id, as an older editor asks: every waiting message is re-timed.
        expect(await client.agent.queueSchedule({ conversationId: "conv-retime", sendAt: at + 1_000 })).toMatchObject({
            items: [{ until: at + 1_000 }],
            paused: "scheduled",
            until: at + 1_000,
        });
        const waiting = await client.agent.queueSchedule({ conversationId: "conv-retime", sendAfter: "conv-other" });
        expect(waiting).toMatchObject({ items: [{ after: "conv-other" }], paused: "scheduled", after: "conv-other" });
        expect(waiting).not.toHaveProperty("until");
        expect(waiting.items[0]).not.toHaveProperty("until");
        expect(await errorCode(client.agent.queueSchedule({ conversationId: "conv-retime", sendAfter: "conv-nobody" }))).toBe("BAD_REQUEST");
        expect(await errorCode(client.agent.queueSchedule({ conversationId: "conv-empty", sendAt: at }))).toBe("NOT_FOUND");

        gates[0]?.();
        await collect(await client.agent.attach({ conversationId: "conv-other" }));
        expect(await client.agent.queueSchedule({ conversationId: "conv-retime", sendAt: Date.now() - 1 })).toEqual({ items: [], revision: expect.any(Number) });
        await waitFor(() => expect(gates).toHaveLength(2), SETTLES);
        expect(prompts[1]).toContain("write the guide");
        gates[1]?.();
    });

    // Each booked message goes at its own time (2026-10-06): the queue once held one booking for all of them, so the
    // second message booked re-timed the first, and both went together at whichever time was booked last.
    it("lets two booked messages go each at its own time, whichever was booked first", async () => {
        const { gates, prompts, services: turns } = unsteerableTurns();
        const client = clientFor(createApp(turns));
        await startedRun(client, { prompt: "draft the release notes", conversationId: "conv-two-at", agent: "grok" });
        await waitFor(() => expect(gates).toHaveLength(1), SETTLES);
        gates[0]?.();
        await collect(await client.agent.attach({ conversationId: "conv-two-at" }));

        const soon = Date.now() + 60 * 60 * 1000;
        const late = soon + 60 * 60 * 1000;
        await client.agent.run({ prompt: "then tag it", conversationId: "conv-two-at", agent: "grok", messageId: "m-late", sendAt: late });
        await client.agent.run({ prompt: "and the changelog", conversationId: "conv-two-at", agent: "grok", messageId: "m-soon", sendAt: soon });
        expect(await queueOf(client, "conv-two-at")).toMatchObject({
            items: [
                { id: "m-late", until: late },
                { id: "m-soon", until: soon },
            ],
            paused: "scheduled",
            until: soon,
        });

        const pass = createTurnResumeScheduler(turns);
        await pass.tick(soon);
        await waitFor(() => expect(gates).toHaveLength(2), SETTLES);
        expect(prompts[1]).toContain("and the changelog");
        expect(prompts[1]).not.toContain("then tag it");
        expect(await queueOf(client, "conv-two-at")).toMatchObject({ items: [{ id: "m-late", until: late }], paused: "scheduled", until: late });
        gates[1]?.();
        await collect(await client.agent.attach({ conversationId: "conv-two-at" }));

        await pass.tick(late - 1);
        expect(gates).toHaveLength(2);
        await pass.tick(late);
        await waitFor(() => expect(gates).toHaveLength(3), SETTLES);
        expect(prompts[2]).toContain("then tag it");
        gates[2]?.();
    });

    it("re-times or lets go only the messages a window names, leaving every other booking on its time", async () => {
        const { gates, prompts, services: turns } = unsteerableTurns();
        const client = clientFor(createApp(turns));
        await startedRun(client, { prompt: "draft the release notes", conversationId: "conv-ids", agent: "grok" });
        await waitFor(() => expect(gates).toHaveLength(1), SETTLES);
        gates[0]?.();
        await collect(await client.agent.attach({ conversationId: "conv-ids" }));

        const at = Date.now() + 60 * 60 * 1000;
        await client.agent.run({ prompt: "write the guide", conversationId: "conv-ids", agent: "grok", messageId: "m-a", sendAt: at });
        await client.agent.run({ prompt: "then tag it", conversationId: "conv-ids", agent: "grok", messageId: "m-b", sendAt: at + 1_000 });

        expect(await client.agent.queueSchedule({ conversationId: "conv-ids", sendAt: at + 5_000, ids: ["m-a"] })).toMatchObject({
            items: [
                { id: "m-a", until: at + 5_000 },
                { id: "m-b", until: at + 1_000 },
            ],
            paused: "scheduled",
            until: at + 1_000,
        });
        // A message that has gone, or was taken back, cannot be re-timed: nothing else is re-timed in its place.
        expect(await errorCode(client.agent.queueSchedule({ conversationId: "conv-ids", sendAt: at, ids: ["m-gone"] }))).toBe("NOT_FOUND");

        const resumed = await client.agent.queueResume({ conversationId: "conv-ids", ids: ["m-b"] });
        expect(resumed).toMatchObject({ run: expect.any(String), queue: { items: [{ id: "m-a", until: at + 5_000 }], paused: "scheduled", until: at + 5_000 } });
        await waitFor(() => expect(gates).toHaveLength(2), SETTLES);
        expect(prompts[1]).toContain("then tag it");
        expect(prompts[1]).not.toContain("write the guide");
        gates[1]?.();
    });

    // A Stop is the person saying the agent must not carry on by itself: whatever waited stays until somebody lets it go.
    it("is held for everyone by a stop, and a resume lets it go as the next turn", async () => {
        const { gates, prompts, services: turns } = unsteerableTurns();
        const client = clientFor(createApp(turns));
        const first = await startedRun(client, { prompt: "draft the release notes", conversationId: "conv-held", agent: "grok" });
        await waitFor(() => expect(gates).toHaveLength(1), SETTLES);
        await client.agent.run({ prompt: "and the changelog", conversationId: "conv-held", agent: "grok", messageId: "m-held" });

        expect(await client.agent.stop({ conversationId: "conv-held", run: first })).toEqual({ stopped: true });
        await collect(await client.agent.attach({ conversationId: "conv-held" }));
        expect(await queueOf(client, "conv-held")).toMatchObject({ items: [{ id: "m-held" }], paused: "stopped" });
        expect(gates).toHaveLength(1);

        const resumed = await client.agent.queueResume({ conversationId: "conv-held" });
        // Answered with the queue it left, so the pressing window need not wait on a roster frame to stop drawing the words.
        expect(resumed).toEqual({ run: expect.any(String), queue: { items: [], revision: 4 } });
        await waitFor(() => expect(gates).toHaveLength(2), SETTLES);
        expect(prompts[1]).toContain("and the changelog");
        // Queued, held, let go, and taken out by the turn it started: every one of them a change another window saw.
        expect(await queueOf(client, "conv-held")).toEqual({ items: [], revision: 4 });
        gates[1]?.();
    });

    it("takes back or rewords a waiting message only as it was read, so two devices never write over each other", async () => {
        const { gates, services: turns } = unsteerableTurns();
        const client = clientFor(createApp(turns));
        await startedRun(client, { prompt: "draft the release notes", conversationId: "conv-edit", agent: "grok" });
        await waitFor(() => expect(gates).toHaveLength(1), SETTLES);
        await client.agent.run({ prompt: "and the changelog", conversationId: "conv-edit", agent: "grok", messageId: "m-e" });

        expect(
            await client.agent.queueEdit({ conversationId: "conv-edit", id: "m-e", revision: 1, text: "and the changelog, briefly" }),
        ).toMatchObject({
            items: [{ id: "m-e", text: "and the changelog, briefly", revision: 2 }],
            revision: 2,
        });
        // Another device still holding revision 1 cannot rewrite or take back words it has not seen.
        expect(await errorCode(client.agent.queueEdit({ conversationId: "conv-edit", id: "m-e", revision: 1, text: "skip it" }))).toBe(
            "PRECONDITION_FAILED",
        );
        expect(await errorCode(client.agent.queueRemove({ conversationId: "conv-edit", id: "m-e", revision: 1 }))).toBe("PRECONDITION_FAILED");
        expect(await errorCode(client.agent.queueEdit({ conversationId: "conv-edit", id: "m-e", revision: 2, text: "  " }))).toBe("BAD_REQUEST");
        expect(await client.agent.queueRemove({ conversationId: "conv-edit", id: "m-e", revision: 2 })).toEqual({ items: [], revision: 3 });
        expect(await errorCode(client.agent.queueRemove({ conversationId: "conv-edit", id: "m-e", revision: 2 }))).toBe("NOT_FOUND");
        gates[0]?.();
    });

    // What waited behind the card is said into the turn it un-parks, the moment the answer lands, whichever window sent it.
    it("waits behind a parked card, and goes into the turn once the card is answered", async () => {
        let requestId: ((id: string) => void) | undefined;
        const raised = new Promise<string>((resolve) => (requestId = resolve));
        let release: (() => void) | undefined;
        const held = new Promise<void>((resolve) => (release = resolve));
        const client = clientFor(
            createApp(
                services({
                    async *agent(request) {
                        const { id, wait } = request.hooks.cards.create(
                            "question",
                            { kind: "question", requestId: "", cancelled: true },
                            request.spec.conversationId,
                        );
                        yield { kind: "question", requestId: id, questions: [] };
                        requestId?.(id);
                        const { resolved } = await wait(request.signal);
                        yield resolved;
                        await held;
                        yield { kind: "done" };
                    },
                }),
            ),
        );
        const run = await startedRun(client, { prompt: "rename Credits?", conversationId: "conv-card", isolated: true });
        const card = await raised;

        expect(
            await client.agent.run({
                prompt: "and keep the old name as an alias",
                conversationId: "conv-card",
                isolated: true,
                messageId: "m-alias",
            }),
        ).toEqual({
            delivered: "queued",
        });
        await client.agent.reply({ kind: "question", requestId: card, answers: {} });
        await waitFor(async () => expect(await queueOf(client, "conv-card")).toEqual({ items: [], revision: 2 }), SETTLES);
        expect(
            await client.agent.run({
                prompt: "and keep the old name as an alias",
                conversationId: "conv-card",
                isolated: true,
                messageId: "m-alias",
            }),
        ).toEqual({
            delivered: "steered",
            run,
            duplicate: true,
        });
        release?.();
        const rows = attachedRows(await collect(await client.agent.attach({ conversationId: "conv-card" })));
        expect(rows.filter((row) => row.role === "user").map(({ text, messageId }) => ({ text, messageId }))).toEqual([
            { text: "rename Credits?", messageId: expect.any(String) },
            { text: "and keep the old name as an alias", messageId: "m-alias" },
        ]);
    });

    // The composer that sent it no longer keeps a copy: a refusal before the model saw a word hands it back here, held,
    // since sending it again as it stands would be refused again.
    it("takes back a message a refusal at the door turned away, held until somebody lets it go", async () => {
        const client = clientFor(
            createApp(
                services({
                    async *agent() {
                        yield { kind: "error", code: "sandbox-memory-low", message: "Sandbox memory is low." };
                        yield { kind: "done" };
                    },
                }),
            ),
        );
        await runAgentTurn(client, { prompt: "fix the pipeline", conversationId: "conv-refused", isolated: true, messageId: "m-refused" });

        await waitFor(
            async () =>
                expect(await queueOf(client, "conv-refused")).toMatchObject({
                    items: [{ id: "m-refused", text: "fix the pipeline" }],
                    paused: "refused",
                }),
            SETTLES,
        );
        expect(
            await client.agent.run({ prompt: "fix the pipeline", conversationId: "conv-refused", isolated: true, messageId: "m-refused" }),
        ).toEqual({
            delivered: "queued",
            duplicate: true,
        });
    });

    // Two separate things said: the held words are not dropped for the new ones, nor sent after them.
    it("lets words a refusal held go with the next thing a person says, the held words first", async () => {
        const prompts: string[] = [];
        const client = clientFor(
            createApp(
                services({
                    async *agent(request) {
                        prompts.push(request.spec.prompt);
                        if (prompts.length === 1) {
                            yield { kind: "error", code: "sandbox-memory-low", message: "Sandbox memory is low." };
                        }
                        yield { kind: "done" };
                    },
                }),
            ),
        );
        await runAgentTurn(client, { prompt: "fix the tests", conversationId: "conv-go", isolated: true, messageId: "m-fix" });
        await waitFor(async () => expect(await queueOf(client, "conv-go")).toMatchObject({ items: [{ id: "m-fix" }], paused: "refused" }), SETTLES);

        expect(await client.agent.run({ prompt: "go ahead", conversationId: "conv-go", isolated: true, messageId: "m-go" })).toEqual({
            delivered: "started",
            run: expect.any(String),
        });
        await waitFor(() => expect(prompts).toHaveLength(2), SETTLES);
        expect(prompts[1]).toContain("fix the tests\n\ngo ahead");
        expect(await queueOf(client, "conv-go")).toMatchObject({ items: [] });
    });
});

// The one refusal at the door that a moment's wait clears by itself: the conversation's answer to the memory wall says
// whether its held words go once memory has stayed free (the sandbox-wide default) or wait for a press.
describe("a message held because the sandbox was short of memory", () => {
    // Every conversation's first turn is turned away for memory; any later one runs.
    const refusedOnce = (prompts: string[], code: Extract<AgentEvent, { kind: "error" }>["code"] = "sandbox-memory-low") => {
        const tried = new Set<string>();
        return services({
            async *agent(request) {
                prompts.push(request.spec.prompt);
                const conversationId = request.spec.conversationId ?? "";
                if (!tried.has(conversationId)) {
                    tried.add(conversationId);
                    yield { kind: "error", code, message: "Refused at the door." };
                }
                yield { kind: "done" };
            },
        });
    };
    const settled = (): number => Date.now() + ROOM_SETTLE_MS + 1_000;

    it("goes by itself once memory has stayed free for a while, and not on the first good reading", async () => {
        const prompts: string[] = [];
        const daemon = refusedOnce(prompts);
        const client = clientFor(createApp(daemon));
        await runAgentTurn(client, { prompt: "fix the pipeline", conversationId: "conv-room", isolated: true, messageId: "m-room" });
        await waitFor(async () => expect(await queueOf(client, "conv-room")).toMatchObject({ items: [{ id: "m-room" }], paused: "refused" }), SETTLES);
        const pass = createTurnResumeScheduler(daemon);

        await pass.tick(Date.now());
        expect(prompts).toHaveLength(1);

        await pass.tick(settled());
        await waitFor(() => expect(prompts).toHaveLength(2), SETTLES);
        expect(prompts[1]).toContain("fix the pipeline");
        await waitFor(async () => expect(await queueOf(client, "conv-room")).toMatchObject({ items: [] }), SETTLES);
    });

    it("waits for a press where the conversation's answer is to wait", async () => {
        const prompts: string[] = [];
        const daemon = refusedOnce(prompts);
        const client = clientFor(createApp(daemon));
        await runAgentTurn(client, { prompt: "fix the pipeline", conversationId: "conv-wait", isolated: true, messageId: "m-wait" });
        await waitFor(async () => expect(await queueOf(client, "conv-wait")).toMatchObject({ paused: "refused" }), SETTLES);
        await client.agents.breakPolicy({ id: "conv-wait", ending: "memory", policy: "wait" });
        expect((await client.agents.list()).agents.find((agent) => agent.id === "conv-wait")?.memoryPolicy).toBe("wait");

        await createTurnResumeScheduler(daemon).tick(settled());
        expect(prompts).toHaveLength(1);
        expect(await queueOf(client, "conv-wait")).toMatchObject({ items: [{ id: "m-wait" }], paused: "refused" });
    });

    it("leaves a refusal memory does not clear for its press", async () => {
        const prompts: string[] = [];
        const daemon = refusedOnce(prompts, "model-unavailable");
        const client = clientFor(createApp(daemon));
        await runAgentTurn(client, { prompt: "fix the pipeline", conversationId: "conv-model", isolated: true, messageId: "m-model" });
        await waitFor(async () => expect(await queueOf(client, "conv-model")).toMatchObject({ paused: "refused" }), SETTLES);

        await createTurnResumeScheduler(daemon).tick(settled());
        expect(prompts).toHaveLength(1);
    });

    it("lets one conversation go a pass, the longest waiting first", async () => {
        const prompts: string[] = [];
        const daemon = refusedOnce(prompts);
        const client = clientFor(createApp(daemon));
        await runAgentTurn(client, { prompt: "first in line", conversationId: "conv-first", isolated: true, messageId: "m-first" });
        await runAgentTurn(client, { prompt: "second in line", conversationId: "conv-second", isolated: true, messageId: "m-second" });
        await waitFor(async () => expect(await queueOf(client, "conv-second")).toMatchObject({ paused: "refused" }), SETTLES);
        const pass = createTurnResumeScheduler(daemon);

        await pass.tick(settled());
        await waitFor(() => expect(prompts).toHaveLength(3), SETTLES);
        expect(prompts[2]).toContain("first in line");
        expect(await queueOf(client, "conv-second")).toMatchObject({ items: [{ id: "m-second" }], paused: "refused" });

        await waitFor(() => expect(daemon.conversations.running("conv-first")).toBe(false), SETTLES);
        await pass.tick(settled());
        await waitFor(() => expect(prompts).toHaveLength(4), SETTLES);
        expect(prompts[3]).toContain("second in line");
    });

    it("runs a turn the sandbox kept at the door once memory has stayed free", async () => {
        const prompts: string[] = [];
        const daemon = refusedOnce(prompts);
        expect(await daemon.turns.say({ voice: "sandbox", turn: { prompt: "The watch fired.", conversationId: "conv-kept" } })).toMatchObject({
            delivered: "started",
        });
        await waitFor(() => expect(daemon.conversations.state("conv-kept")?.resume.held?.reason).toBe("door"), SETTLES);
        // The hold is filed as the refusal frame arrives, the run's ending only once it settles; the pass reads both, so a
        // tick between them finds no memory hold, or a conversation still busy, and lets nothing go.
        await waitFor(() => {
            expect(daemon.conversations.running("conv-kept")).toBe(false);
            expect(daemon.agents.entry("conv-kept")?.ending).toMatchObject({ kind: "failed", code: "sandbox-memory-low" });
        }, SETTLES);

        await createTurnResumeScheduler(daemon).tick(settled());
        await waitFor(() => expect(prompts).toHaveLength(2), SETTLES);
        expect(prompts[1]).toContain("The watch fired.");
    });
});

// A wake carries the routing of the turn that armed it (a watch, a background job), and the conversation may have moved
// since. Replaying the armed account resumed the new session on the old credential and wrote that account back onto the
// conversation, so the person's next message no longer matched it and opened a fresh session: an account switch nobody
// chose, on both sides of the wake.
test("a wake runs on the account its conversation is on now, not the one the watch was armed under", async () => {
    const tokens: string[] = [];
    const daemon = services({
        claudeStore: {
            read: async (id) => ({ id, label: id, connectedAt: 0, accessToken: `tok-${id}` }),
            list: async () => [
                { id: "acct-a", label: "A", connectedAt: 0 },
                { id: "acct-b", label: "B", connectedAt: 0 },
            ],
        },
        async *agent(request) {
            tokens.push(request.credential?.kind === "claude-oauth" ? request.credential.token : request.credential?.kind ?? "none");
            yield { kind: "done" };
        },
    });
    const client = clientFor(createApp(daemon));
    await runAgentTurn(client, { prompt: "start the server and watch it", conversationId: "conv-wake", account: "acct-a" });
    await runAgentTurn(client, { prompt: "now the docs", conversationId: "conv-wake", account: "acct-b" });

    // The watch's report, carrying the profile it was armed under on the first turn.
    expect(await daemon.turns.say({ voice: "sandbox", turn: { prompt: "The watch fired.", conversationId: "conv-wake", account: "acct-a" } })).toMatchObject({
        delivered: "started",
    });
    await waitFor(() => expect(daemon.conversations.running("conv-wake")).toBe(false), SETTLES);

    expect(tokens).toEqual(["tok-acct-a", "tok-acct-b", "tok-acct-b"]);
    expect(daemon.agents.entry("conv-wake")?.profile.account).toBe("acct-b");
});

// Which session a person's turn goes on in is the daemon's to say (routing.ts `continues`). A window's idea of it can be
// older than the conversation's (another window moved it, the daemon moved it off a refused seat), and an older editor
// still sends one: it is no say in the matter.
test("a person's turn goes on in the session the daemon holds, not one the client names", async () => {
    const sessions: (string | undefined)[] = [];
    const client = clientFor(
        createApp(
            services({
                async *agent(request) {
                    sessions.push(request.spec.sessionId);
                    yield { kind: "session", sessionId: "s-daemon" };
                    yield { kind: "done" };
                },
            }),
        ),
    );
    await runAgentTurn(client, { prompt: "start", conversationId: "conv-session" });

    await runAgentTurn(client, { prompt: "carry on", conversationId: "conv-session", sessionId: "s-stale-window" });

    expect(sessions).toEqual([undefined, "s-daemon"]);
});

// An organisation turning Claude Code off for an account leaves it signing in fine and reading full headroom. The seat is
// marked at the first refusal, and a conversation still pinned to it moves off it on its next turn, whoever sends that
// turn, while a person naming the account for a turn still gets it. THE FAILURE THIS PREVENTS: only the unnamed pick
// read the mark, so every later turn of the conversation was sent back to the refused seat and refused again.
describe("a conversation on an account its organisation turned off", () => {
    const roomy = { measuredAt: Date.now(), windows: [{ kind: "five_hour" as const, utilization: 20, gates: "all" as const }] };
    // The seats are the test's record (a turn that answers clears its account's), and so is what the provider says when
    // a marked account is re-tested, on the clock the test moves.
    const fleet = (
        seats: Record<string, { at: number; reason: string }>,
        ready: readonly string[],
        probe: { answer: SeatProbe; now: number } = { answer: STILL_OFF, now: Date.now() },
    ) => {
        const tokens: string[] = [];
        const daemon = services({
            claudeStore: {
                read: async (id) => ({ id, label: id, connectedAt: 0, accessToken: `tok-${id}` }),
                list: async () => ["acct-a", "acct-b", "acct-c"].map((id) => ({ id, label: id, connectedAt: 0 })),
            },
            claudeSeats: memorySeats(seats),
            claudeSeatCheck: scriptedSeatCheck({ seats: memorySeats(seats), answer: () => probe.answer, now: () => probe.now }).check,
            accountUsage: {
                read: async () => Object.fromEntries(ready.map((id) => [id, roomy])),
                record: async () => {},
                markUnread: async () => undefined,
                clear: async () => {},
            },
            async *agent(request) {
                tokens.push(request.credential?.kind === "claude-oauth" ? request.credential.token : (request.credential?.kind ?? "none"));
                yield { kind: "delta", text: "on it" };
                yield { kind: "done" };
            },
        });
        return { daemon, tokens, client: clientFor(createApp(daemon)) };
    };
    const SEAT_OFF = { at: 0, reason: "Your organization has disabled Claude Code." };

    it("moves a person's next message to a ready account, and the conversation with it", async () => {
        const seats: Record<string, { at: number; reason: string }> = {};
        const { daemon, tokens, client } = fleet(seats, ["acct-c"]);
        await runAgentTurn(client, { prompt: "start", conversationId: "conv-seat", account: "acct-a" });
        seats["acct-a"] = SEAT_OFF;

        await runAgentTurn(client, { prompt: "carry on", conversationId: "conv-seat" });

        expect(tokens).toEqual(["tok-acct-a", "tok-acct-c"]);
        expect(daemon.agents.entry("conv-seat")?.profile.account).toBe("acct-c");
    });

    it("runs the account a person names for the turn, refused or not", async () => {
        const { tokens, client } = fleet({ "acct-a": SEAT_OFF }, ["acct-c"]);

        await runAgentTurn(client, { prompt: "on this one, please", conversationId: "conv-named", account: "acct-a" });

        expect(tokens).toEqual(["tok-acct-a"]);
    });

    // An explicit pick is an attempt, not a hold: the editor names the account for the turn (turnRequest.ts
    // accountIntent), and the answer lifts the mark.
    it("runs a turn that names a marked account, and its answer lifts the mark", async () => {
        const seats: Record<string, { at: number; reason: string }> = {};
        const { tokens, client } = fleet(seats, []);
        await runAgentTurn(client, { prompt: "start", conversationId: "conv-pick", account: "acct-a" });
        seats["acct-a"] = SEAT_OFF;

        await runAgentTurn(client, { prompt: "try it again", conversationId: "conv-pick", account: "acct-a" });

        expect(tokens).toEqual(["tok-acct-a", "tok-acct-a"]);
        await waitFor(() => expect(seats).toEqual({}), SETTLES);
    });

    // THE FAILURE THIS PREVENTS: turns were kept off the marked account, so none ran there to lift the mark, and a user
    // with one account stayed held after their admin turned access back on.
    it("sends the held words on the account once a re-test finds its access back", async () => {
        const seats: Record<string, { at: number; reason: string }> = {};
        const probe = { answer: STILL_OFF, now: Date.now() };
        const { daemon, tokens, client } = fleet(seats, [], probe);
        await runAgentTurn(client, { prompt: "start", conversationId: "conv-back", account: "acct-a" });
        seats["acct-a"] = SEAT_OFF;
        await runAgentTurn(client, { prompt: "carry on", conversationId: "conv-back", messageId: "m-back" });
        await waitFor(async () => expect(await queueOf(client, "conv-back")).toMatchObject({ items: [{ id: "m-back" }], paused: "refused" }), SETTLES);

        probe.answer = BACK_ON;
        probe.now += 2 * FIRST_RECHECK_MS;
        await client.agent.queueResume({ conversationId: "conv-back" });

        await waitFor(() => expect(tokens).toEqual(["tok-acct-a", "tok-acct-a"]), SETTLES);
        expect(seats).toEqual({});
        expect(daemon.agents.entry("conv-back")?.profile.account).toBe("acct-a");
    });

    it("holds the words for a press when no account can serve, spawning nothing", async () => {
        const seats: Record<string, { at: number; reason: string }> = {};
        const { daemon, tokens, client } = fleet(seats, []);
        await runAgentTurn(client, { prompt: "start", conversationId: "conv-held", account: "acct-a" });
        seats["acct-a"] = SEAT_OFF;

        await runAgentTurn(client, { prompt: "carry on", conversationId: "conv-held", messageId: "m-held" });

        await waitFor(async () => expect(await queueOf(client, "conv-held")).toMatchObject({ items: [{ id: "m-held" }], paused: "refused" }), SETTLES);
        expect(tokens).toEqual(["tok-acct-a"]);
        expect(daemon.agents.entry("conv-held")?.profile.account).toBe("acct-a");
    });

    // The first refusal is the provider's: nothing had marked the seat yet. It marks it, holds the words, and the press
    // that sends them again is routed off the refused seat like any later turn.
    it("holds the words the provider refused for want of a seat, and sends them again on a ready account", async () => {
        const seats: Record<string, { at: number; reason: string }> = {};
        const tokens: string[] = [];
        const daemon = services({
            claudeStore: {
                read: async (id) => ({ id, label: id, connectedAt: 0, accessToken: `tok-${id}` }),
                list: async () => ["acct-a", "acct-c"].map((id) => ({ id, label: id, connectedAt: 0 })),
            },
            claudeSeats: {
                read: async () => seats,
                refuse: async (id, reason) => void (seats[id] = { at: Date.now(), reason }),
                clear: async () => {},
            },
            accountUsage: { read: async () => ({ "acct-c": roomy }), record: async () => {}, markUnread: async () => undefined, clear: async () => {} },
            async *agent(request) {
                const token = request.credential?.kind === "claude-oauth" ? request.credential.token : "none";
                tokens.push(token);
                if (token === "tok-acct-a" && tokens.length > 1) {
                    yield { kind: "error", code: "claude-not-entitled", message: SEAT_OFF.reason };
                }
                yield { kind: "done" };
            },
        });
        const client = clientFor(createApp(daemon));
        await runAgentTurn(client, { prompt: "start", conversationId: "conv-refused-seat", account: "acct-a" });

        await runAgentTurn(client, { prompt: "carry on", conversationId: "conv-refused-seat", messageId: "m-seat" });
        await waitFor(
            async () => expect(await queueOf(client, "conv-refused-seat")).toMatchObject({ items: [{ id: "m-seat" }], paused: "refused" }),
            SETTLES,
        );
        expect(seats["acct-a"]?.reason).toBe(SEAT_OFF.reason);

        await client.agent.queueResume({ conversationId: "conv-refused-seat" });
        await waitFor(() => expect(tokens).toEqual(["tok-acct-a", "tok-acct-a", "tok-acct-c"]), SETTLES);
        expect(daemon.agents.entry("conv-refused-seat")?.profile.account).toBe("acct-c");
    });

    // A wake names the account its conversation runs on only by leaving it to routing, so it is moved the same way.
    it("moves a wake the same way, whichever account the wake was armed under", async () => {
        const seats: Record<string, { at: number; reason: string }> = {};
        const { daemon, tokens, client } = fleet(seats, ["acct-c"]);
        await runAgentTurn(client, { prompt: "start the server and watch it", conversationId: "conv-wake-seat", account: "acct-a" });
        await runAgentTurn(client, { prompt: "now the docs", conversationId: "conv-wake-seat", account: "acct-b" });
        seats["acct-b"] = SEAT_OFF;

        await daemon.turns.say({ voice: "sandbox", turn: { prompt: "The watch fired.", conversationId: "conv-wake-seat", account: "acct-a" } });
        await waitFor(() => expect(tokens).toHaveLength(3), SETTLES);
        await waitFor(() => expect(daemon.conversations.running("conv-wake-seat")).toBe(false), SETTLES);

        expect(tokens).toEqual(["tok-acct-a", "tok-acct-b", "tok-acct-c"]);
        expect(daemon.agents.entry("conv-wake-seat")?.profile.account).toBe("acct-c");
    });
});

// Only a person reopens an archived conversation: the sandbox's own words go nowhere, and a person's message brings it back.
describe("an archived conversation", () => {
    it("takes the sandbox's words nowhere, not even into its queue, and stays archived", async () => {
        const daemon = services();
        const client = clientFor(createApp(daemon));
        await runAgentTurn(client, { prompt: "draft the release notes", conversationId: "conv-filed" });
        await client.agents.archive({ ids: ["conv-filed"] });

        expect(await daemon.turns.say({ voice: "sandbox", turn: { prompt: "The watch fired.", conversationId: "conv-filed" } })).toEqual({
            why: "the conversation is archived, and only a person's message reopens it",
        });
        expect(daemon.conversations.running("conv-filed")).toBe(false);
        expect(daemon.conversations.queued("conv-filed").items).toEqual([]);
        expect((await client.agents.archived()).agents.map((agent) => agent.id)).toEqual(["conv-filed"]);
    });

    it("comes back onto the board with a person's message, which starts its turn", async () => {
        const daemon = services();
        const client = clientFor(createApp(daemon));
        await runAgentTurn(client, { prompt: "draft the release notes", conversationId: "conv-reopened" });
        await client.agents.archive({ ids: ["conv-reopened"] });

        await runAgentTurn(client, { prompt: "and the changelog", conversationId: "conv-reopened" });
        expect((await client.agents.archived()).agents).toEqual([]);
        expect((await client.agents.list()).agents.map((agent) => agent.id)).toEqual(["conv-reopened"]);
    });
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
                    clear: async () => {},
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
                modelCooldowns: { cooling: async () => new Map(), record: async (_p, model) => void filed.push(model), clear: async () => {} },
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
                    seen.push({
                        prompt: request.spec.prompt,
                        ...(request.spec.sessionId === undefined ? {} : { sessionId: request.spec.sessionId }),
                    });
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
                    seen.push({
                        prompt: request.spec.prompt,
                        ...(request.spec.sessionId === undefined ? {} : { sessionId: request.spec.sessionId }),
                    });
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

// Nothing held (a Stop, a restart since, a failure that named its fix): a Continue carries the conversation on in its
// own session with the sandbox's note as the whole prompt. The words a client still sends for an older daemon go
// nowhere: the record gains the sandbox's line, never a "Continue" from the person.
test("a Continue with nothing held carries the session on, adding no words of the person's", async () => {
    const seen: { prompt: string; sessionId: string | undefined }[] = [];
    const client = clientFor(
        createApp(
            services({
                async *agent(request) {
                    seen.push({ prompt: request.spec.prompt, sessionId: request.spec.sessionId });
                    yield { kind: "session", sessionId: "s-kept" };
                    yield { kind: "delta", text: seen.length === 1 ? "half done" : "the rest" };
                    yield { kind: "done" };
                },
            }),
        ),
    );

    await runAgentTurn(client, { prompt: "fix the pipeline", conversationId: "conv-carry" });
    const { rows } = await runAgentTurn(client, { prompt: "Continue", conversationId: "conv-carry", continues: true });

    expect(seen).toHaveLength(2);
    expect(seen[1]!.prompt).toContain(RESUME_NOTES.continued);
    expect(seen[1]!.prompt).not.toMatch(/^Continue$/im);
    expect(seen[1]!.sessionId).toBe("s-kept");
    expect(rows.map(({ role, text }) => ({ role, text }))).toEqual([
        { role: "notice", text: "Carried on from where the last turn stopped." },
        { role: "assistant", text: "the rest" },
    ]);
});

// A Continue that finds a turn held after all (the window had not heard) runs that turn again, as agent.resume would.
test("a Continue that finds a held turn runs it again rather than carrying on past it", async () => {
    const seen: string[] = [];
    let refuse = true;
    const client = clientFor(
        createApp(
            services({
                async *agent(request) {
                    seen.push(request.spec.prompt);
                    yield { kind: "session", sessionId: "s-void" };
                    yield refuse ? { kind: "error", code: "rate_limit", message: "Claude usage limit reached." } : { kind: "delta", text: "on it" };
                    yield { kind: "done" };
                },
            }),
        ),
    );

    await runAgentTurn(client, { prompt: "ship the parser", conversationId: "conv-carry-held" });
    refuse = false;
    await runAgentTurn(client, { prompt: "Continue", conversationId: "conv-carry-held", continues: true });

    expect(seen).toHaveLength(2);
    expect(seen[1]).toContain("ship the parser");
    expect(seen[1]).toMatch(/no part of the request below/i);
    expect(seen[1]).not.toContain(RESUME_NOTES.continued);
});

test("dismissing a question ends the turn where the dismissal lands, and settles the card as finished", async () => {
    let raised: ((id: string) => void) | undefined;
    const card = new Promise<string>((resolve) => (raised = resolve));
    const client = clientFor(
        createApp(
            services({
                async *agent(request) {
                    // Exactly what the `ask` tool does: the card names the conversation it parked.
                    const { id, wait } = request.hooks.cards.create(
                        "question",
                        { kind: "question", requestId: "", cancelled: true },
                        request.spec.conversationId,
                    );
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
    const { work, worktree, worktrees } = await checkout("conv1");
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
                    const { id, wait } = request.hooks.cards.create(
                        "question",
                        { kind: "question", requestId: "", cancelled: true },
                        request.spec.conversationId,
                    );
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

    expect(await gitOut(work, "status", "--porcelain")).toBe("");
    expect(await gitOut(work, "show", "--name-only", "--format=%s", "agent/conv1")).toContain("app.ts");
    const { agents } = await client.agents.list();
    expect(agents[0]).toMatchObject({ id: "conv1", status: "idle", diff: { files: 1, insertions: 1, deletions: 0 } });
});

test("an isolated turn announces the state its message can be rewound to, and files it under that message", async () => {
    const { worktrees } = await checkout("conv-anchor");
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

    const { run } = await client.agent.run({ prompt: "ship it", conversationId: "conv-steer", isolated: true });
    await started;
    expect(await client.agent.steer({ conversationId: "conv-steer", text: "and the tests", messageId: "m-steer" })).toEqual({
        delivered: "steered",
        run,
    });
    // The answer was lost and the words sent again: said once, answered as the first time.
    expect(await client.agent.steer({ conversationId: "conv-steer", text: "and the tests", messageId: "m-steer" })).toEqual({
        delivered: "steered",
        run,
        duplicate: true,
    });
    taken?.();

    const [head] = await collect(await client.agent.attach({ conversationId: "conv-steer" }));
    expect(head?.kind === "attached" ? head.rows.map(({ role, text }) => ({ role, text })) : undefined).toEqual([
        { role: "user", text: "ship it" },
        { role: "assistant", text: "on it" },
        { role: "user", text: "and the tests" },
        { role: "assistant", text: "will do" },
    ]);
    await waitFor(() => expect(recorded).not.toHaveLength(0), SETTLES);
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

    await waitFor(() => expect(ledger).toHaveLength(1), SETTLES);
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

    await waitFor(() => expect(ledger).toHaveLength(1), SETTLES);
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

    await waitFor(() => expect(ledger).toHaveLength(1), SETTLES);
    // The arm this id draws, from the same function planning draws it with: a transcribed `true` would also pass
    // against a row carrying the opposite arm.
    expect(ledger[0]).toMatchObject({ notesArm: experimentArm("field-notes", "conv-notes", 0.5), turnIndex: 0 });
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
                    yield editFrame("1", `${WORKSPACE_ROOT}/src/parser.ts`);
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

    await waitFor(() => expect(ledger).toHaveLength(1), SETTLES);
    // The command matters: 'verified' alone would read as the whole repo passing, not one file.
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
                    yield editFrame("1", `${WORKSPACE_ROOT}/src/parser.ts`);
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
    await waitFor(() => expect(ledger).toHaveLength(1), SETTLES);
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
                    yield readFrame("1", `${WORKSPACE_ROOT}/src/parser.ts`);
                    yield readFrame("2", `${WORKSPACE_ROOT}/src/lexer.ts`);
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

    await waitFor(() => expect(ledger).toHaveLength(1), SETTLES);
    expect(ledger[0]).toMatchObject({
        outcome: "error",
        errorMessage: expect.stringContaining("nothing to show for it"),
        filesEdited: 0,
        toolCalls: 2,
    });
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
    await waitFor(() => expect(ledger).toHaveLength(1), SETTLES);
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

    await waitFor(() => expect(ledger).toHaveLength(1), SETTLES);
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

    await waitFor(() => expect(ledger).toHaveLength(1), SETTLES);
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

    await waitFor(() => expect(ledger).toHaveLength(1), SETTLES);
    expect("modelRequested" in (ledger[0] ?? {})).toBe(false);
});

// Only the land-conflict errand is a client's to compose; every other one is the sandbox's, and a request naming one
// would pass its sender's words off as the sandbox's on the row.
test("a message keeps the land-conflict errand its window composed, and is refused any errand only the sandbox sends", async () => {
    const client = clientFor(createApp(services()));
    const composed = await runAgentTurn(client, { prompt: "resolve it", conversationId: "conv-errand", isolated: true, errand: "land-conflict" });
    expect(composed.rows[0]).toMatchObject({ role: "user", text: "resolve it", errand: "land-conflict" });
    const claimed = await runAgentTurn(client, { prompt: "fix main", conversationId: "conv-claimed", isolated: true, errand: "land-fix" });
    expect(claimed.rows[0]).toMatchObject({ role: "user", text: "fix main" });
    expect(claimed.rows[0]).not.toHaveProperty("errand");
});
