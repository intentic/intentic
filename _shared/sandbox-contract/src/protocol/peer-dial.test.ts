import { expect, test, vi } from "vitest";
import { dialPeer, type SocketLike } from "./peer-dial.js";

/* The loop every peer runs, over a socket the test plays. What is at stake is the order of the two phases
 * (handler attached BEFORE the hello goes out), the retry after a drop, the one close that is never retried,
 * and that a stop reaches a dial still deciding where to go. */

class FakeSocket implements SocketLike {
    readyState = 0;
    readonly sent: string[] = [];
    closed: { readonly code: number | undefined; readonly reason: string | undefined } | undefined;
    private readonly listeners = new Map<string, Set<(event: { readonly code?: number }) => void>>();

    addEventListener(type: "open" | "close" | "error" | "message", listener: (event: { readonly code?: number }) => void): void {
        const set = this.listeners.get(type) ?? new Set();
        set.add(listener);
        this.listeners.set(type, set);
    }
    send(data: string): void {
        this.sent.push(data);
    }
    close(code?: number, reason?: string): void {
        this.closed = { code, reason };
        this.readyState = 3;
    }
    opens(): void {
        this.readyState = 1;
        this.emit("open");
    }
    drops(code: number): void {
        this.readyState = 3;
        this.emit("close", code);
    }
    // A frame from the sandbox: the heartbeat, or any call. Only that one arrived matters to the loop.
    says(): void {
        this.emit("message");
    }
    // What a socket that cannot reach its far end emits before it closes: no code, no reason, just a fault.
    errors(): void {
        this.emit("error");
    }
    private emit(type: string, code?: number): void {
        for (const listener of this.listeners.get(type) ?? []) {
            listener(code === undefined ? {} : { code });
        }
    }
}

// This door's silence deadline, named so the assertions can read it off the same number the loop is given.
const SILENCE_MS = 30_000;

// A ladder that answers with a fixed delay and records what it was told, so the test can read the held time.
const ladder = (delay = 1_000) => {
    const held: number[] = [];
    return {
        held,
        next: (heldMs: number) => {
            held.push(heldMs);
            return delay;
        },
    };
};

const dialling = (delay?: number) => {
    const sockets: FakeSocket[] = [];
    const attached: FakeSocket[] = [];
    const said: string[] = [];
    const revoked = vi.fn();
    const link = dialPeer<FakeSocket>({
        open: async () => {
            const socket = new FakeSocket();
            sockets.push(socket);
            return { socket, said: `connected #${sockets.length}` };
        },
        hello: () => ({ type: "hello", token: "iht_test", version: "1.0.0" }),
        attach: (socket) => void attached.push(socket),
        backoff: ladder(delay),
        silenceMs: SILENCE_MS,
        log: (message) => void said.push(message),
        revoked,
    });
    return { link, sockets, attached, said, revoked };
};

test("the handler is attached before the hello goes out, and the hello is the first frame", async () => {
    const { link, sockets, attached, said } = dialling();
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    expect(link.state()).toBe("connecting");
    sockets[0]?.opens();
    await vi.waitFor(() => expect(sockets[0]?.sent).toHaveLength(1));
    expect(attached).toEqual([sockets[0]]);
    expect(JSON.parse(sockets[0]?.sent[0] ?? "{}")).toEqual({ type: "hello", token: "iht_test", version: "1.0.0" });
    expect(said).toEqual(["connected #1"]);
    expect(link.state()).toBe("open");
    link.stop();
    await link.done;
    expect(sockets[0]?.closed).toEqual({ code: 1000, reason: "stopping" });
    expect(link.state()).toBe("closed");
});

test("a drop redials on the ladder, telling it how long the socket held", async () => {
    vi.useFakeTimers();
    try {
        const { link, sockets, said } = dialling();
        await vi.waitFor(() => expect(sockets).toHaveLength(1));
        sockets[0]?.opens();
        await vi.advanceTimersByTimeAsync(5_000);
        sockets[0]?.drops(1006);
        expect(link.state()).toBe("connecting");
        expect(said.at(-1)).toBe("disconnected (1006); reconnecting in 1s");
        await vi.advanceTimersByTimeAsync(1_000);
        await vi.waitFor(() => expect(sockets).toHaveLength(2));
        link.stop();
        await link.done;
    } finally {
        vi.useRealTimers();
    }
});

/* THE DROP NOBODY REPORTS, which is the one that used to last for days: a far end that is gone while the socket
 * stays open — a sandbox container recreated behind a port relay that outlived it, a NAT that forgot the flow, a
 * laptop's wifi suspended mid-session. Note what this test never calls: `drops`. Nothing closes, nothing errors,
 * and the loop has to reach the conclusion on its own or hold a dead link forever. */
test("a socket that goes silent is abandoned and redialled, though no close ever arrives", async () => {
    vi.useFakeTimers();
    try {
        const { link, sockets, said } = dialling();
        await vi.waitFor(() => expect(sockets).toHaveLength(1));
        sockets[0]?.opens();

        // A frame inside every window holds the link: this is the sandbox's heartbeat, three beats of it.
        for (let beat = 0; beat < 3; beat += 1) {
            await vi.advanceTimersByTimeAsync(SILENCE_MS - 1_000);
            sockets[0]?.says();
        }
        expect(link.state()).toBe("open");
        expect(sockets).toHaveLength(1);

        // Then the beats stop, and nothing else happens: no close, no error.
        await vi.advanceTimersByTimeAsync(SILENCE_MS);
        expect(said.at(-1)).toBe(`nothing heard for ${SILENCE_MS / 1_000}s; reconnecting in 1s`);
        expect(sockets[0]?.closed).toEqual({ code: 1000, reason: "no heartbeat" });
        expect(link.state()).toBe("connecting");

        await vi.advanceTimersByTimeAsync(1_000);
        await vi.waitFor(() => expect(sockets).toHaveLength(2));

        // The close an abandoned socket may still emit minutes later must not put a second loop on the link.
        sockets[0]?.drops(1006);
        await vi.advanceTimersByTimeAsync(10_000);
        expect(sockets).toHaveLength(2);

        link.stop();
        await link.done;
    } finally {
        vi.useRealTimers();
    }
});

/* THE FAR END THAT IS NEVER COMING BACK, which is not a failure the loop can fix and not one it may narrate
 * forever: a sandbox deleted, a tunnel repointed, a machine left on for a week. Every attempt here errors and
 * closes without ever opening, exactly as a laptop's agent did 1,992 times into a 2.3 MB log. What is asserted
 * is BOTH halves: the log stops repeating, and the dialling does not slow down to achieve it. */
test("a far end that never answers is reported a few times, then retried quietly at the same cadence", async () => {
    vi.useFakeTimers();
    try {
        const { link, sockets, said } = dialling(60_000);
        for (let attempt = 1; attempt <= 20; attempt += 1) {
            // oxlint-disable-next-line eslint/no-await-in-loop -- one attempt after another is the thing under test
            await vi.waitFor(() => expect(sockets).toHaveLength(attempt));
            sockets.at(-1)?.errors();
            sockets.at(-1)?.drops(1006);
            // oxlint-disable-next-line eslint/no-await-in-loop -- the ladder's own wait, serial by construction
            await vi.advanceTimersByTimeAsync(60_000);
        }

        // Twenty minutes of a dead link: eight lines, the last of them a count rather than a repetition.
        expect(said).toEqual([
            "connection error",
            "disconnected (1006); reconnecting in 60s",
            "connection error",
            "disconnected (1006); reconnecting in 60s",
            "connection error",
            "disconnected (1006); reconnecting in 60s",
            expect.stringContaining("still nothing after 4 attempts"),
            expect.stringContaining("14 failed attempts"),
        ]);
        // The retries themselves are untouched: one dial per ladder delay, still going, plus the one now armed.
        await vi.waitFor(() => expect(sockets).toHaveLength(21));

        link.stop();
        await link.done;
    } finally {
        vi.useRealTimers();
    }
});

// Quiet is a property of the current outage, not of the link: whatever it hid, the next one starts from nothing.
test("a link that comes back is loud again about the outage after it", async () => {
    vi.useFakeTimers();
    try {
        const { link, sockets, said } = dialling();
        for (let attempt = 1; attempt <= 5; attempt += 1) {
            // oxlint-disable-next-line eslint/no-await-in-loop -- one attempt after another is the thing under test
            await vi.waitFor(() => expect(sockets).toHaveLength(attempt));
            sockets.at(-1)?.drops(1006);
            // oxlint-disable-next-line eslint/no-await-in-loop -- the ladder's own wait, serial by construction
            await vi.advanceTimersByTimeAsync(1_000);
        }
        const whileQuiet = said.length;

        await vi.waitFor(() => expect(sockets).toHaveLength(6));
        sockets.at(-1)?.opens();
        await vi.waitFor(() => expect(said.at(-1)).toBe("connected #6"));
        sockets.at(-1)?.drops(1006);

        expect(said.at(-1)).toBe("disconnected (1006); reconnecting in 1s");
        expect(said).toHaveLength(whileQuiet + 2);

        link.stop();
        await link.done;
    } finally {
        vi.useRealTimers();
    }
});

test("a refused enrollment (1008) is never retried and is reported once", async () => {
    vi.useFakeTimers();
    try {
        const { link, sockets, revoked } = dialling();
        await vi.waitFor(() => expect(sockets).toHaveLength(1));
        sockets[0]?.opens();
        sockets[0]?.drops(1008);
        await link.done;
        expect(revoked).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(60_000);
        expect(sockets).toHaveLength(1);
        expect(link.state()).toBe("closed");
    } finally {
        vi.useRealTimers();
    }
});

// A stop that lands while the address is still being decided has nothing to close and must open nothing after
// the fact: a socket dialled by a loop that has already reported itself done would be a connection nobody stops.
test("a stop during resolution opens nothing, and a socket a slow resolver still hands over is closed", async () => {
    let answer: (() => void) | undefined;
    const sockets: FakeSocket[] = [];
    const link = dialPeer<FakeSocket>({
        open: async (signal) => {
            await new Promise<void>((resolve) => {
                answer = resolve;
            });
            if (signal.aborted) {
                return undefined;
            }
            const socket = new FakeSocket();
            sockets.push(socket);
            return { socket };
        },
        hello: () => ({}),
        attach: () => undefined,
        backoff: ladder(),
        silenceMs: SILENCE_MS,
        log: () => undefined,
        revoked: () => undefined,
    });
    await vi.waitFor(() => expect(answer).toEqual(expect.any(Function)));
    link.stop();
    await link.done;
    answer?.();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(sockets).toHaveLength(0);

    // The other order: a resolver that ignores the signal and hands a socket over anyway.
    const late: FakeSocket[] = [];
    const careless = dialPeer<FakeSocket>({
        open: async () => {
            await new Promise<void>((resolve) => {
                answer = resolve;
            });
            const socket = new FakeSocket();
            late.push(socket);
            return { socket };
        },
        hello: () => ({}),
        attach: () => undefined,
        backoff: ladder(),
        silenceMs: SILENCE_MS,
        log: () => undefined,
        revoked: () => undefined,
    });
    await vi.waitFor(() => expect(answer).toEqual(expect.any(Function)));
    careless.stop();
    answer?.();
    await vi.waitFor(() => expect(late[0]?.closed).toEqual({ code: 1000, reason: "stopping" }));
});

test("a pairing that is gone by the next attempt ends the loop rather than dialling nowhere", async () => {
    let pairings = 1;
    const sockets: FakeSocket[] = [];
    const link = dialPeer<FakeSocket>({
        open: async () => {
            if (pairings === 0) {
                return undefined;
            }
            pairings -= 1;
            const socket = new FakeSocket();
            sockets.push(socket);
            return { socket };
        },
        hello: () => ({}),
        attach: () => undefined,
        backoff: ladder(0),
        silenceMs: SILENCE_MS,
        log: () => undefined,
        revoked: () => undefined,
    });
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    sockets[0]?.opens();
    sockets[0]?.drops(1006);
    await link.done;
    expect(sockets).toHaveLength(1);
    expect(link.state()).toBe("closed");
});
