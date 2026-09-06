import { expect, test } from "vitest";
import { createRequest, resolveRequest, restoreRequest } from "./agent-requests.js";

/* The registry decides what every client will be told about a card's fate, so what matters here is the one
 * distinction only it can draw: an answer a user actually gave versus the stand-in an abort settles with. */

const onAbort = { kind: "question", requestId: "", cancelled: true } as const;

test("a user's answer settles the waiter and rides out as the frame that freezes the card", async () => {
    const { id, wait } = createRequest("question", onAbort);
    const settled = wait(new AbortController().signal);

    expect(resolveRequest({ kind: "question", requestId: id, answers: { Which: ["A"] } })).toBe("settled");

    const { reply, resolved } = await settled;
    expect(reply).toEqual({ kind: "question", requestId: id, answers: { Which: ["A"] } });
    expect(resolved).toEqual({ kind: "resolved", requestId: id, reply });
});

test("an abort settles the caller with its stand-in, but resolves the card as answered by nobody", async () => {
    const controller = new AbortController();
    const { id, wait } = createRequest("question", onAbort);
    const settled = wait(controller.signal);

    controller.abort();

    const { reply, resolved } = await settled;
    // The caller still gets an answer: the SDK's tool handler must never hang holding the turn open...
    expect(reply).toBe(onAbort);
    // ...but nobody chose it, so it must not replay as a decision: no reply, and the card freezes cancelled.
    expect(resolved).toEqual({ kind: "resolved", requestId: id });
});

test("a card already aborted before the wait resolves immediately, without registering", async () => {
    const { id, wait } = createRequest("question", onAbort);
    const { resolved } = await wait(AbortSignal.abort());

    expect(resolved).toEqual({ kind: "resolved", requestId: id });
    expect(resolveRequest({ kind: "question", requestId: id, cancelled: true })).toBe("missing");
});

test("a reply for another kind of card settles as the abort value rather than an answer", async () => {
    const { id, wait } = createRequest("question", onAbort);
    const settled = wait(new AbortController().signal);

    // Only a client bug produces this; the waiter's own kind is what its caller is typed against.
    resolveRequest({ kind: "plan", requestId: id, approve: true });

    const { reply, resolved } = await settled;
    expect(reply).toBe(onAbort);
    expect(resolved).toEqual({ kind: "resolved", requestId: id });
});

// The restart path: a card restored from the journal answers to the id it was raised with one process ago:
// the id every replayed frame and saved answer draft still holds.
test("a restored card settles under its original id", async () => {
    const { id, wait } = restoreRequest("r-restored", "question", onAbort, "c-1");
    expect(id).toBe("r-restored");
    const settled = wait(new AbortController().signal);

    expect(resolveRequest({ kind: "question", requestId: "r-restored", answers: { Which: ["B"] } })).toBe("settled");

    const { reply, resolved } = await settled;
    expect(reply).toEqual({ kind: "question", requestId: "r-restored", answers: { Which: ["B"] } });
    expect(resolved).toEqual({ kind: "resolved", requestId: "r-restored", reply });
});

test("only the first settle counts: a second reply for the same id finds nothing to resolve", async () => {
    const { id, wait } = createRequest("question", onAbort);
    const settled = wait(new AbortController().signal);

    expect(resolveRequest({ kind: "question", requestId: id, cancelled: true })).toBe("settled");
    expect(resolveRequest({ kind: "question", requestId: id, answers: { Which: ["A"] } })).toBe("missing");

    const { resolved } = await settled;
    expect(resolved).toEqual({ kind: "resolved", requestId: id, reply: { kind: "question", requestId: id, cancelled: true } });
});

/* WHO MAY ANSWER, the one card-level check in the registry, and the reason it is here rather than in the
 * reply route: the card holds the list, and a second copy of "who may release this" in the route is the copy
 * that goes stale. A refusal must leave the card standing, or a stranger's click becomes a way to cancel
 * somebody else's parked turn. */
const approver = { email: "bob@corp.com", role: "collaborator" } as const;

test("a caller the card does not name is refused, and the card stays parked for one who is", async () => {
    const { id, wait } = createRequest("credential_offer", { kind: "credential_offer", requestId: "", approve: false }, "c-1", {
        mayAnswer: (caller) => (caller?.email === approver.email ? undefined : "Only bob@corp.com can release this credential"),
    });
    const settled = wait(new AbortController().signal);

    expect(resolveRequest({ kind: "credential_offer", requestId: id, approve: true }, { email: "eve@corp.com", role: "maintainer" })).toEqual({
        refused: "Only bob@corp.com can release this credential",
    });
    // A no from a stranger is refused too: letting one skip a release on the approver's behalf would make the
    // gate a denial-of-service anybody with a session could aim at a running turn.
    expect(resolveRequest({ kind: "credential_offer", requestId: id, approve: false }, { email: "eve@corp.com", role: "maintainer" })).toEqual({
        refused: "Only bob@corp.com can release this credential",
    });
    // Still parked: the approver's own click settles it.
    expect(resolveRequest({ kind: "credential_offer", requestId: id, approve: true }, approver)).toBe("settled");

    const { reply, caller } = await settled;
    expect(reply).toEqual({ kind: "credential_offer", requestId: id, approve: true });
    // Who answered rides back on the settlement: it is the only road that name travels, because the reply
    // itself carries no sender.
    expect(caller).toEqual(approver);
});

test("a reply with no verified identity is refused where the card names anybody", async () => {
    const { id, wait } = createRequest("credential_offer", { kind: "credential_offer", requestId: "", approve: false }, "c-1", {
        mayAnswer: (caller) => (caller === undefined ? "No signed-in identity: only bob@corp.com can release this" : undefined),
    });
    const settled = wait(AbortSignal.abort());
    await settled;
    expect(resolveRequest({ kind: "credential_offer", requestId: id, approve: true })).toBe("missing");
});

// Every other card in the sandbox has no list, so an anonymous loopback caller still answers it, and nothing
// is attributed to anybody.
test("a card with no approver list settles for any caller, and records none", async () => {
    const { id, wait } = createRequest("question", onAbort);
    const settled = wait(new AbortController().signal);
    expect(resolveRequest({ kind: "question", requestId: id, answers: { Which: ["A"] } })).toBe("settled");
    expect((await settled).caller).toBeUndefined();
});
