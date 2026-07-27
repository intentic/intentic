import { expect, test } from "vitest";
import { createRequest, resolveRequest } from "./agent-requests.js";

/* The registry decides what every client will be told about a card's fate, so what matters here is the one
 * distinction only it can draw: an answer a user actually gave versus the stand-in an abort settles with. */

const onAbort = { kind: "question", requestId: "", cancelled: true } as const;

test("a user's answer settles the waiter and rides out as the frame that freezes the card", async () => {
    const { id, wait } = createRequest("question", onAbort);
    const settled = wait(new AbortController().signal);

    expect(resolveRequest({ kind: "question", requestId: id, answers: { Which: ["A"] } })).toBe(true);

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
    // The caller still gets an answer — the SDK's tool handler must never hang holding the turn open...
    expect(reply).toBe(onAbort);
    // ...but nobody chose it, so it must not replay as a decision: no reply, and the card freezes cancelled.
    expect(resolved).toEqual({ kind: "resolved", requestId: id });
});

test("a card already aborted before the wait resolves immediately, without registering", async () => {
    const { id, wait } = createRequest("question", onAbort);
    const { resolved } = await wait(AbortSignal.abort());

    expect(resolved).toEqual({ kind: "resolved", requestId: id });
    expect(resolveRequest({ kind: "question", requestId: id, cancelled: true })).toBe(false);
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

test("only the first settle counts — a second reply for the same id finds nothing to resolve", async () => {
    const { id, wait } = createRequest("question", onAbort);
    const settled = wait(new AbortController().signal);

    expect(resolveRequest({ kind: "question", requestId: id, cancelled: true })).toBe(true);
    expect(resolveRequest({ kind: "question", requestId: id, answers: { Which: ["A"] } })).toBe(false);

    const { resolved } = await settled;
    expect(resolved).toEqual({ kind: "resolved", requestId: id, reply: { kind: "question", requestId: id, cancelled: true } });
});
