import { CallCut, createOpenCalls, type OpenCall, type OpenCalls } from "./open-calls.js";

// The bound on credentialed calls a door carries at once, and the cut of open ones whose card stopped being theirs.

const call = (overrides: Partial<OpenCall> = {}): OpenCall => ({ subject: "tracker", conversationId: "c1", pool: "call", print: "p1", ...overrides });

// An answer whose body never ends until it is cancelled, the way an event stream stays open.
const endless = () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
        pull: () => new Promise(() => undefined),
        cancel: () => {
            cancelled = true;
        },
    });
    return { response: new Response(body), cancelled: () => cancelled };
};

const limits = { call: { perConversation: 2, perDoor: 3 }, stream: { perConversation: 1, perDoor: 2 } };

test("calls are counted per conversation and for the door, and streams in a pool of their own", () => {
    const calls = createOpenCalls(limits);
    const live = new AbortController().signal;
    expect(calls.admit(call(), live)).toMatchObject({ signal: expect.any(AbortSignal) });
    expect(calls.admit(call(), live)).toMatchObject({ signal: expect.any(AbortSignal) });
    // The conversation's third call is refused; another conversation's is let in up to the door's limit.
    expect(calls.admit(call(), live)).toBeUndefined();
    expect(calls.admit(call({ conversationId: "c2" }), live)).toMatchObject({ signal: expect.any(AbortSignal) });
    expect(calls.admit(call({ conversationId: "c3" }), live)).toBeUndefined();
    // Busy calls never starve a stream.
    expect(calls.admit(call({ pool: "stream" }), live)).toMatchObject({ signal: expect.any(AbortSignal) });
    expect(calls.admit(call({ pool: "stream" }), live)).toBeUndefined();
    expect(calls.size("call")).toBe(3);
    expect(calls.size("stream")).toBe(1);
});

test("a slot is held until the answer is read to its end or cancelled, and freed once", async () => {
    const calls = createOpenCalls(limits);
    const live = new AbortController().signal;
    const read = calls.admit(call(), live);
    const held = read?.hold(new Response("done"));
    expect(calls.size("call")).toBe(1);
    expect(await held?.text()).toBe("done");
    expect(calls.size("call")).toBe(0);

    const stream = endless();
    const cancelledCall = calls.admit(call(), live);
    const open = cancelledCall?.hold(stream.response);
    expect(calls.size("call")).toBe(1);
    await open?.body?.cancel();
    expect(stream.cancelled()).toBe(true);
    cancelledCall?.release();
    expect(calls.size("call")).toBe(0);

    const empty = calls.admit(call(), live);
    empty?.hold(new Response(null, { status: 204 }));
    expect(calls.size("call")).toBe(0);
});

test("a sweep cuts the calls whose card no longer holds them, aborting the request and ending the stream", async () => {
    const calls = createOpenCalls(limits);
    const live = new AbortController().signal;
    const kept = calls.admit(call({ subject: "kept" }), live);
    const doomed = calls.admit(call({ subject: "removed", pool: "stream" }), live);
    const stream = endless();
    const reading = doomed?.hold(stream.response).text();
    const cut = await calls.sweep(async (open) => (open.subject === "removed" ? "the card was removed" : undefined));
    expect(cut).toBe(1);
    expect(doomed?.signal.aborted).toBe(true);
    expect(doomed?.signal.reason).toBeInstanceOf(CallCut);
    expect(kept?.signal.aborted).toBe(false);
    await expect(reading).rejects.toThrow("the card was removed");
    expect(stream.cancelled()).toBe(true);
    expect(calls.size("stream")).toBe(0);
});

test("a cut by match aborts every open call it picks, and the client hanging up aborts its own", () => {
    const calls: OpenCalls = createOpenCalls(limits);
    const hangUp = new AbortController();
    const mine = calls.admit(call(), hangUp.signal);
    const other = calls.admit(call({ subject: "other", conversationId: "c2" }), new AbortController().signal);
    expect(calls.cut((open) => open.subject === "tracker", "replaced")).toBe(1);
    expect(mine?.signal.aborted).toBe(true);
    expect(other?.signal.aborted).toBe(false);
    const next = calls.admit(call({ conversationId: "c9" }), hangUp.signal);
    hangUp.abort();
    expect(next?.signal.aborted).toBe(true);
});
