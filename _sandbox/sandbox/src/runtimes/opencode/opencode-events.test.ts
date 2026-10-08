import type { OpenCodeClient, OpenCodeEvent } from "@opencode/client";
import { unstubbed } from "@intentic/testing";
import { advanceTimersByTimeAsync, realYield } from "@intentic/testing/bun";
import { type OpenCodeEvents, type OpenCodeListener, openEventStream } from "./opencode-events.js";

// The server's one event stream, read once and fanned out. The server is a fake whose `event.subscribe` is a stream
// this test feeds by hand: what it sends, when it ends, and how it fails.

type Subscribe = OpenCodeClient["event"]["subscribe"];

const CONNECTED: OpenCodeEvent = { id: "evt_connected", type: "server.connected", data: {} };
// Two events as OpenCode 2.0.26 publishes them; which kind does not matter to the fan-out, only that they pass whole.
const IDLE: OpenCodeEvent = { id: "evt_idle", created: 1_791_493_690_000, type: "session.idle", data: { sessionID: "ses_1" } };
const ASKED: OpenCodeEvent = {
    id: "evt_asked",
    created: 1_791_493_690_080,
    type: "permission.asked",
    location: { directory: "/work" },
    data: { id: "per_1", sessionID: "ses_1", action: "shell", resources: ["git push origin main"], save: ["git push *"] },
};

type Sent = { readonly event: OpenCodeEvent } | { readonly error: unknown } | { readonly end: true };

const fakeServer = () => {
    const queue: Sent[] = [];
    let wake = Promise.withResolvers<void>();
    // Every subscription's signal, so a test can see the stream being let go.
    const signals: (AbortSignal | undefined)[] = [];
    const deliver = (sent: Sent): void => {
        queue.push(sent);
        wake.resolve();
    };
    async function* stream(signal: AbortSignal | undefined): AsyncGenerator<OpenCodeEvent> {
        for (;;) {
            const next = queue.shift();
            if (next === undefined) {
                // Ends once its subscriber aborts, as the real client's stream does.
                if (signal?.aborted === true) {
                    return;
                }
                const aborted = Promise.withResolvers<void>();
                signal?.addEventListener("abort", () => aborted.resolve(), { once: true });
                await Promise.race([wake.promise, aborted.promise]);
                wake = Promise.withResolvers<void>();
                continue;
            }
            if ("end" in next) {
                return;
            }
            if ("error" in next) {
                throw next.error;
            }
            yield next.event;
        }
    }
    const subscribe: Subscribe = (options) => {
        signals.push(options?.signal);
        return stream(options?.signal);
    };
    return {
        client: unstubbed<OpenCodeClient>("client", { event: unstubbed<OpenCodeClient["event"]>("event", { subscribe }) }),
        signals,
        send: (event: OpenCodeEvent) => deliver({ event }),
        end: () => deliver({ end: true }),
        fail: (error: unknown) => deliver({ error }),
    };
};

// What one listener heard, in order.
const recorder = () => {
    const events: OpenCodeEvent[] = [];
    const lost: Error[] = [];
    const listener: OpenCodeListener = { event: (event) => void events.push(event), lost: (reason) => void lost.push(reason) };
    return { listener, events, lost };
};

// How the open came out, once it has.
interface Opened {
    value?: OpenCodeEvents;
    error?: Error;
}

// Opens the stream against a fake server with `onEvent` and `ended` recorded; `opened` settles with the open.
const opening = () => {
    const server = fakeServer();
    const seen: OpenCodeEvent[] = [];
    const ended: Error[] = [];
    const settled: Opened = {};
    const opened = openEventStream(server.client, { onEvent: (event) => void seen.push(event), ended: (reason) => void ended.push(reason) }).then(
        (events) => {
            settled.value = events;
            return events;
        },
        (error: Error) => {
            settled.error = error;
            throw error;
        },
    );
    return { server, seen, ended, settled, opened };
};

// Lets the fake stream and the reader drain every queued step: a macrotask turn runs after all their microtasks.
const drain = async (): Promise<void> => {
    await realYield();
};

const opens: OpenCodeEvents[] = [];
afterEach(() => {
    for (const events of opens.splice(0)) {
        events.close();
    }
    jest.useRealTimers();
});

const connected = async () => {
    const open = opening();
    open.server.send(CONNECTED);
    const events = await open.opened;
    opens.push(events);
    return { ...open, events };
};

test("the stream is handed over once the server confirms it, and the confirmation itself goes to nobody", async () => {
    const { server, seen, ended, settled, opened } = opening();
    await drain();
    expect(settled).toEqual({});
    expect(server.signals.map((signal) => signal?.aborted)).toEqual([false]);

    server.send(CONNECTED);
    const events = await opened;
    opens.push(events);
    const heard = recorder();
    events.listen(heard.listener);
    await drain();

    expect(seen).toEqual([]);
    expect(heard.events).toEqual([]);
    expect(ended).toEqual([]);
});

test("every later event reaches onEvent and each listener, in the order the server sent it", async () => {
    const { server, seen, events } = await connected();
    const first = recorder();
    const second = recorder();
    events.listen(first.listener);
    events.listen(second.listener);

    server.send(ASKED);
    server.send(IDLE);
    await drain();

    expect(seen).toEqual([ASKED, IDLE]);
    expect(first.events).toEqual([ASKED, IDLE]);
    expect(second.events).toEqual([ASKED, IDLE]);
});

test("a listener that stops listening hears nothing more, and the others carry on", async () => {
    const { server, events } = await connected();
    const leaving = recorder();
    const staying = recorder();
    const stop = events.listen(leaving.listener);
    events.listen(staying.listener);
    server.send(ASKED);
    await drain();

    stop();
    server.send(IDLE);
    await drain();

    expect(leaving.events).toEqual([ASKED]);
    expect(staying.events).toEqual([ASKED, IDLE]);
    expect(leaving.lost).toEqual([]);
});

// A turn waiting on its session's end would wait for ever on a stream that is gone; the service boots afresh on `ended`.
test("a stream that ends tells every listener it is lost, and the service once that it ended", async () => {
    const { server, ended, events } = await connected();
    const first = recorder();
    const second = recorder();
    events.listen(first.listener);
    events.listen(second.listener);

    server.end();
    await drain();

    const reason = new Error("OpenCode's event stream ended.");
    expect(first.lost).toEqual([reason]);
    expect(second.lost).toEqual([reason]);
    expect(ended).toEqual([reason]);
    expect(server.signals.map((signal) => signal?.aborted)).toEqual([true]);
});

test("a listener that arrives after the stream ended is told at once, and hears nothing", async () => {
    const { server, ended, events } = await connected();
    server.end();
    await drain();

    const late = recorder();
    const stop = events.listen(late.listener);
    stop();

    expect(late.lost).toEqual([new Error("OpenCode's event stream ended.")]);
    expect(late.events).toEqual([]);
    expect(ended).toHaveLength(1);
});

test("a stream that fails reports its own error to the listeners and the service", async () => {
    const { server, ended, events } = await connected();
    const heard = recorder();
    events.listen(heard.listener);
    const failure = new Error("socket hang up");

    server.fail(failure);
    await drain();

    expect(heard.lost).toHaveLength(1);
    expect(heard.lost[0]).toBe(failure);
    expect(ended).toHaveLength(1);
    expect(ended[0]).toBe(failure);
});

test("a failure that is not an Error is reported as one carrying its text", async () => {
    const { server, ended } = await connected();
    server.fail("ECONNRESET");
    await drain();

    expect(ended).toEqual([new Error("ECONNRESET")]);
});

test("a server that never confirms its stream is given up on after 15 seconds, and the subscription let go", async () => {
    jest.useFakeTimers();
    const { server, ended, settled, opened } = opening();
    const outcome = opened.then(
        () => "opened",
        (error: Error) => error.message,
    );

    await advanceTimersByTimeAsync(14_999);
    expect(settled).toEqual({});
    expect(ended).toEqual([]);

    await advanceTimersByTimeAsync(1);
    expect(await outcome).toBe("OpenCode's event stream did not connect.");
    // The open's own rejection is the answer; `ended` is for a stream that was open.
    expect(ended).toEqual([]);
    expect(server.signals.map((signal) => signal?.aborted)).toEqual([true]);
});

// It once waited out the whole 15 s and then threw "did not connect", dropping the stream's own reason (a refused
// connection, a 401), and fired `ended` meanwhile, so the service forgot the boot it was still in the middle of and an
// acquisition in that window booted a second server.
test("a stream that fails before the server confirms it fails the open at once, with its own error, and ends nothing", async () => {
    jest.useFakeTimers();
    const { server, ended, settled, opened } = opening();
    opened.catch(() => {});
    const refused = new Error("connect ECONNREFUSED 127.0.0.1:4096");

    server.fail(refused);
    await drain();

    expect(settled.error).toBe(refused);
    expect(ended).toEqual([]);
});

test("close lets the stream go quietly: nobody is told it was lost, the service is not told it ended, and again is a no-op", async () => {
    const { server, ended, events } = await connected();
    const heard = recorder();
    events.listen(heard.listener);

    events.close();
    events.close();
    server.send(IDLE);
    await drain();

    expect(server.signals.map((signal) => signal?.aborted)).toEqual([true]);
    expect(heard.events).toEqual([]);
    expect(heard.lost).toEqual([]);
    expect(ended).toEqual([]);

    const late = recorder();
    events.listen(late.listener);
    expect(late.lost).toEqual([new Error("OpenCode's event stream ended.")]);
});
