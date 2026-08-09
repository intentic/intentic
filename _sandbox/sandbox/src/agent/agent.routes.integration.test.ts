import { expect, test } from "vitest";

import { createApp } from "../app.js";

import { clientFor, collect, errorCode, runAgentTurn, services } from "../route-testing.js";
import { createRequest } from "./agent-requests.js";

/* The agent routes, driven over the daemon's HTTP surface exactly as the browser drives them.
 * Split out of app.integration.test.ts, which had grown to 116 tests across every route in the daemon —
 * one file that two agents working on unrelated features collided in every time. The fakes and the client
 * are shared (route-testing.ts); what lives here is what these routes do. */

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
    // The run is live (parked on the gate) — a second start bounces at the door, before any registry work.
    expect(await errorCode(client.agent.run({ prompt: "again", conversationId: "conv1", isolated: true }))).toBe("CONFLICT");
    release?.();
    // Attaching to its end is the settle barrier: the run finished and the registry mutex released.
    const frames = await collect(await client.agent.attach({ conversationId: "conv1" }));
    expect(frames[0]).toMatchObject({ kind: "attached", run: first });
    // The next turn starts — and runs the full isolated path again.
    const events = await runAgentTurn(client, { prompt: "after", conversationId: "conv1", isolated: true });
    expect(events[0]).toMatchObject({ kind: "worktree" });
});

test("a chat turn without a conversationId is refused — the run registry has nothing to key it on", async () => {
    const client = clientFor(createApp(services()));
    expect(await errorCode(client.agent.run({ prompt: "hi" }))).toBe("BAD_REQUEST");
});

test("isolated requires conversationId at the contract gate", async () => {
    const client = clientFor(createApp(services()));
    expect(await errorCode(client.agent.run({ prompt: "hi", isolated: true }))).toBe("BAD_REQUEST");
});

/* DISMISSING A QUESTION ENDS THE TURN, HERE — one request, not the browser's old two.
 *
 * The rule is old: the card was raised because the agent could not choose, so waving it away answers nothing
 * and letting the turn run on means it guesses at the fork it just said it could not guess at. What this pins
 * is that the ending happens where the dismissal lands. Released-then-stopped, as two requests, left the
 * daemon holding a live turn with nothing parked on it for the round trip in between — a working agent, as far
 * as the roster could tell — so the board pulled the card out of Attention to say so and then moved it again
 * when the stop arrived. It also made where the card CAME TO REST a race: whichever request won.
 *
 * `idle` is the resting ending, the one that hands the question to git and puts the card in Finished — NOT the
 * `stopped` a Stop press writes (app.integration.test.ts), which waits in Attention to be picked up. Both are
 * endings the user chose; only one of them is them saying they are done with it. */
test("dismissing a question ends the turn where the dismissal lands, and settles the card as finished", async () => {
    let raised: ((id: string) => void) | undefined;
    const card = new Promise<string>((resolve) => (raised = resolve));
    const client = clientFor(
        createApp(
            services({
                agent: async function* (request) {
                    // Exactly what the `ask` tool does — the card names the conversation it parked, which is
                    // what lets the reply route end that turn.
                    const { id, wait } = createRequest(
                        "question",
                        { kind: "question", requestId: "", cancelled: true },
                        request.conversationId,
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
    // Answering the reply is the whole interaction: it comes back with the turn already unwound, so nothing
    // follows it and the next message cannot collide with a run that is still holding the conversation.
    expect(await client.agent.reply({ kind: "question", requestId, cancelled: true })).toEqual({ ok: true });
    const { agents } = await client.agents.list();
    expect(agents[0]).toMatchObject({ id: "conv1", status: "idle", attention: { question: false } });
    // A reply for a card that is gone is NOT_FOUND, which is what tells a second window to freeze it as stale.
    expect(await errorCode(client.agent.reply({ kind: "question", requestId, cancelled: true }))).toBe("NOT_FOUND");
});
