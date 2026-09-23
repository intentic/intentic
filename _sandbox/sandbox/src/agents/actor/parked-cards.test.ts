import { test, expect } from "bun:test";
import { memoryFleet } from "../../testing.js";
import { parkedCards } from "./parked-cards.js";

// The registry decides what every client is told about a card's fate: a real answer versus the abort's stand-in is the
// one distinction it draws.

const onAbort = { kind: "question", requestId: "", cancelled: true } as const;

// The cards of one fleet's actors, which every test not about a dispose parks in.
const cards = parkedCards(memoryFleet().conversations);

test("a user's answer settles the waiter and rides out as the frame that freezes the card", async () => {
    const { id, wait } = cards.create("question", onAbort);
    const settled = wait(new AbortController().signal);

    expect(cards.resolve({ kind: "question", requestId: id, answers: { Which: ["A"] } })).toBe("settled");

    const { reply, resolved } = await settled;
    expect(reply).toEqual({ kind: "question", requestId: id, answers: { Which: ["A"] } });
    expect(resolved).toEqual({ kind: "resolved", requestId: id, reply });
});

test("an abort settles the caller with its stand-in, but resolves the card as answered by nobody", async () => {
    const controller = new AbortController();
    const { id, wait } = cards.create("question", onAbort);
    const settled = wait(controller.signal);

    controller.abort();

    const { reply, resolved } = await settled;
    // The caller still gets a reply: the SDK's tool handler must never hang holding the turn open.
    expect(reply).toBe(onAbort);
    // But nobody chose it, so it must not replay as a decision: no reply, and the card freezes cancelled.
    expect(resolved).toEqual({ kind: "resolved", requestId: id });
});

test("a card already aborted before the wait resolves immediately, without registering", async () => {
    const { id, wait } = cards.create("question", onAbort);
    const { resolved } = await wait(AbortSignal.abort());

    expect(resolved).toEqual({ kind: "resolved", requestId: id });
    expect(cards.resolve({ kind: "question", requestId: id, cancelled: true })).toBe("missing");
});

test("a reply for another kind of card settles as the abort value rather than an answer", async () => {
    const { id, wait } = cards.create("question", onAbort);
    const settled = wait(new AbortController().signal);

    // Only a client bug produces this; the waiter's own kind is what its caller is typed against.
    cards.resolve({ kind: "plan", requestId: id, approve: true });

    const { reply, resolved } = await settled;
    expect(reply).toBe(onAbort);
    expect(resolved).toEqual({ kind: "resolved", requestId: id });
});

// A card restored from the journal answers to the id it was raised with one process ago, the id a replayed frame and
// saved draft still hold.
test("a restored card settles under its original id", async () => {
    const { id, wait } = cards.restore("r-restored", "question", onAbort, "c-1");
    expect(id).toBe("r-restored");
    const settled = wait(new AbortController().signal);

    expect(cards.resolve({ kind: "question", requestId: "r-restored", answers: { Which: ["B"] } })).toBe("settled");

    const { reply, resolved } = await settled;
    expect(reply).toEqual({ kind: "question", requestId: "r-restored", answers: { Which: ["B"] } });
    expect(resolved).toEqual({ kind: "resolved", requestId: "r-restored", reply });
});

test("only the first settle counts: a second reply for the same id finds nothing to resolve", async () => {
    const { id, wait } = cards.create("question", onAbort);
    const settled = wait(new AbortController().signal);

    expect(cards.resolve({ kind: "question", requestId: id, cancelled: true })).toBe("settled");
    expect(cards.resolve({ kind: "question", requestId: id, answers: { Which: ["A"] } })).toBe("missing");

    const { resolved } = await settled;
    expect(resolved).toEqual({ kind: "resolved", requestId: id, reply: { kind: "question", requestId: id, cancelled: true } });
});

// Who may answer is a card-level check here, not in the reply route, since a second copy of the list there is the one
// that goes stale. A refusal must leave the card standing.
const approver = { email: "bob@corp.com", role: "collaborator" } as const;

test("a caller the card does not name is refused, and the card stays parked for one who is", async () => {
    const { id, wait } = cards.create("credential_offer", { kind: "credential_offer", requestId: "", approve: false }, "c-1", {
        mayAnswer: (caller) => (caller?.email === approver.email ? undefined : "Only bob@corp.com can release this credential"),
    });
    const settled = wait(new AbortController().signal);

    expect(cards.resolve({ kind: "credential_offer", requestId: id, approve: true }, { email: "eve@corp.com", role: "maintainer" })).toEqual({
        refused: "Only bob@corp.com can release this credential",
    });
    // A stranger's no is refused too, or skipping a release on the approver's behalf becomes a denial-of-service.
    expect(cards.resolve({ kind: "credential_offer", requestId: id, approve: false }, { email: "eve@corp.com", role: "maintainer" })).toEqual({
        refused: "Only bob@corp.com can release this credential",
    });
    // Still parked: the approver's own click settles it.
    expect(cards.resolve({ kind: "credential_offer", requestId: id, approve: true }, approver)).toBe("settled");

    const { reply, caller } = await settled;
    expect(reply).toEqual({ kind: "credential_offer", requestId: id, approve: true });
    // Who answered rides back on the settlement; the reply itself carries no sender.
    expect(caller).toEqual(approver);
});

test("a reply with no verified identity is refused where the card names anybody", async () => {
    const { id, wait } = cards.create("credential_offer", { kind: "credential_offer", requestId: "", approve: false }, "c-1", {
        mayAnswer: (caller) => (caller === undefined ? "No signed-in identity: only bob@corp.com can release this" : undefined),
    });
    const settled = wait(AbortSignal.abort());
    await settled;
    expect(cards.resolve({ kind: "credential_offer", requestId: id, approve: true })).toBe("missing");
});

// Every other card has no list, so an anonymous caller still answers it, with nothing attributed to anybody.
test("a card with no approver list settles for any caller, and records none", async () => {
    const { id, wait } = cards.create("question", onAbort);
    const settled = wait(new AbortController().signal);
    expect(cards.resolve({ kind: "question", requestId: id, answers: { Which: ["A"] } })).toBe("settled");
    expect((await settled).caller).toBeUndefined();
});

// A card lives with the conversation it was raised on, so the one dispose a discard or a purge goes through reaches it.
test("a card raised on a conversation names it, and that conversation's dispose settles it as its turn dying would", async () => {
    const { conversations } = memoryFleet();
    const held = parkedCards(conversations);
    const { id, wait } = held.create("question", onAbort, "c-held");
    const settled = wait(new AbortController().signal);
    expect(held.conversationOf(id)).toBe("c-held");

    await conversations.dispose(["c-held"]);

    expect(await settled).toEqual({ reply: onAbort, resolved: { kind: "resolved", requestId: id } });
    expect(held.conversationOf(id)).toBeUndefined();
    expect(held.resolve({ kind: "question", requestId: id, cancelled: true })).toBe("missing");
    expect(conversations.traces("c-held")).toEqual([]);
});

test("a card raised on no conversation names none, and outlives every conversation's dispose until it is answered", async () => {
    const { conversations } = memoryFleet();
    const held = parkedCards(conversations);
    const { id, wait } = held.create("question", onAbort);
    const settled = wait(new AbortController().signal);
    expect(held.conversationOf(id)).toBeUndefined();

    await conversations.dispose(["c-other"]);

    expect(held.resolve({ kind: "question", requestId: id, answers: { Which: ["A"] } })).toBe("settled");
    expect((await settled).reply).toEqual({ kind: "question", requestId: id, answers: { Which: ["A"] } });
});
