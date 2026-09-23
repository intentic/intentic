import { waitFor, advanceTimersByTimeAsync } from "@intentic/testing/bun";
import { dialPeer, LONG_OUTAGE_ATTEMPTS, LONG_OUTAGE_MS, PEER_TRY_AGAIN, type SocketLike } from "./peer-dial.js";

/* The loop every peer runs, over a socket the test plays. */

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
    const revoked = jest.fn();
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
    await waitFor(() => expect(sockets).toHaveLength(1));
    expect(link.state()).toBe("connecting");
    sockets[0]?.opens();
    await waitFor(() => expect(sockets[0]?.sent).toHaveLength(1));
    expect(attached).toEqual([sockets[0]!]);
    expect(JSON.parse(sockets[0]?.sent[0] ?? "{}")).toEqual({ type: "hello", token: "iht_test", version: "1.0.0" });
    expect(said).toEqual(["connected #1"]);
    expect(link.state()).toBe("open");
    link.stop();
    await link.done;
    expect(sockets[0]?.closed).toEqual({ code: 1000, reason: "stopping" });
    expect(link.state()).toBe("closed");
});

test("a drop redials on the ladder, telling it how long the socket held", async () => {
    jest.useFakeTimers();
    try {
        const { link, sockets, said } = dialling();
        await waitFor(() => expect(sockets).toHaveLength(1));
        sockets[0]?.opens();
        await advanceTimersByTimeAsync(5_000);
        sockets[0]?.drops(1006);
        expect(link.state()).toBe("connecting");
        expect(said.at(-1)).toBe("disconnected (1006); reconnecting in 1s");
        await advanceTimersByTimeAsync(1_000);
        await waitFor(() => expect(sockets).toHaveLength(2));
        link.stop();
        await link.done;
    } finally {
        jest.useRealTimers();
    }
});

/* A silent socket must be abandoned even when no close event arrives. */
test("a socket that goes silent is abandoned and redialled, though no close ever arrives", async () => {
    jest.useFakeTimers();
    try {
        const { link, sockets, said } = dialling();
        await waitFor(() => expect(sockets).toHaveLength(1));
        sockets[0]?.opens();

        // A frame inside every window holds the link: this is the sandbox's heartbeat, three beats of it.
        for (let beat = 0; beat < 3; beat += 1) {
            await advanceTimersByTimeAsync(SILENCE_MS - 1_000);
            sockets[0]?.says();
        }
        expect(link.state()).toBe("open");
        expect(sockets).toHaveLength(1);

        // Then the beats stop, and nothing else happens: no close, no error.
        await advanceTimersByTimeAsync(SILENCE_MS);
        expect(said.at(-1)).toBe(`nothing heard for ${SILENCE_MS / 1_000}s; reconnecting in 1s`);
        expect(sockets[0]?.closed).toEqual({ code: 1000, reason: "no heartbeat" });
        expect(link.state()).toBe("connecting");

        await advanceTimersByTimeAsync(1_000);
        await waitFor(() => expect(sockets).toHaveLength(2));

        // The close an abandoned socket may still emit minutes later must not put a second loop on the link.
        sockets[0]?.drops(1006);
        await advanceTimersByTimeAsync(10_000);
        expect(sockets).toHaveLength(2);

        link.stop();
        await link.done;
    } finally {
        jest.useRealTimers();
    }
});

/* THE FAR END THAT IS NEVER COMING BACK, which is not a failure the loop can fix and not one it may narrate. */
test("a far end that never answers is reported a few times, then retried quietly", async () => {
    jest.useFakeTimers();
    try {
        const { link, sockets, said } = dialling(60_000);
        for (let attempt = 1; attempt <= 20; attempt += 1) {
            // oxlint-disable-next-line eslint/no-await-in-loop -- one attempt after another is the thing under test
            await waitFor(() => expect(sockets).toHaveLength(attempt));
            sockets.at(-1)?.errors();
            sockets.at(-1)?.drops(1006);
            // oxlint-disable-next-line eslint/no-await-in-loop -- the ladder's own wait, serial by construction
            await advanceTimersByTimeAsync(60_000);
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
        // The retries themselves are untouched while the outage is young: one dial per ladder delay, twenty of them.
        // The twentieth failure is what arms the long rest, so the dial after it is LONG_OUTAGE_MS away rather than
        // one more rung — quiet in the log and quiet on the wire, which are separate rules meeting here.
        expect(sockets).toHaveLength(20);
        await advanceTimersByTimeAsync(LONG_OUTAGE_MS);
        await waitFor(() => expect(sockets).toHaveLength(21));

        link.stop();
        await link.done;
    } finally {
        jest.useRealTimers();
    }
});

// Quiet is a property of the current outage, not of the link: whatever it hid, the next one starts from nothing.
test("a link that comes back is loud again about the outage after it", async () => {
    jest.useFakeTimers();
    try {
        const { link, sockets, said } = dialling();
        for (let attempt = 1; attempt <= 5; attempt += 1) {
            // oxlint-disable-next-line eslint/no-await-in-loop -- one attempt after another is the thing under test
            await waitFor(() => expect(sockets).toHaveLength(attempt));
            sockets.at(-1)?.drops(1006);
            // oxlint-disable-next-line eslint/no-await-in-loop -- the ladder's own wait, serial by construction
            await advanceTimersByTimeAsync(1_000);
        }
        const whileQuiet = said.length;

        await waitFor(() => expect(sockets).toHaveLength(6));
        sockets.at(-1)?.opens();
        await waitFor(() => expect(said.at(-1)).toBe("connected #6"));
        sockets.at(-1)?.drops(1006);

        expect(said.at(-1)).toBe("disconnected (1006); reconnecting in 1s");
        expect(said).toHaveLength(whileQuiet + 2);

        link.stop();
        await link.done;
    } finally {
        jest.useRealTimers();
    }
});

test("a refused enrollment (1008) is never retried and is reported once", async () => {
    jest.useFakeTimers();
    try {
        const { link, sockets, revoked } = dialling();
        await waitFor(() => expect(sockets).toHaveLength(1));
        sockets[0]?.opens();
        sockets[0]?.drops(1008);
        await link.done;
        expect(revoked).toHaveBeenCalledTimes(1);
        await advanceTimersByTimeAsync(60_000);
        expect(sockets).toHaveLength(1);
        expect(link.state()).toBe("closed");
    } finally {
        jest.useRealTimers();
    }
});

// The other half of the same rule, and the one that cost real pairings: a sandbox mid-restart refuses sockets it
// cannot decide about, and every one of those refusals used to arrive as 1008. Both codes here mean "come back",
// and a loop that ended on either would leave someone walking to a laptop to paste a command.
test.each([
    [PEER_TRY_AGAIN, "the sandbox is not ready to admit this connection yet"],
    [1002, "disconnected (1002)"],
])("a refusal that is not about the credential (%i) keeps the loop on the ladder", async (code, complaint) => {
    jest.useFakeTimers();
    try {
        const { link, sockets, said, revoked } = dialling();
        await waitFor(() => expect(sockets).toHaveLength(1));
        sockets[0]?.opens();
        sockets[0]?.drops(code);

        expect(revoked).not.toHaveBeenCalled();
        expect(said.at(-1)).toBe(`${complaint}; reconnecting in 1s`);
        await advanceTimersByTimeAsync(1_000);
        await waitFor(() => expect(sockets).toHaveLength(2));

        link.stop();
        await link.done;
    } finally {
        jest.useRealTimers();
    }
});

// The ladder caps at 30s and would stay there forever. Right for the first minutes, absurd after the first week: a
// link to a sandbox that no longer exists spent 2,880 attempts a day saying so. It is never given up — a laptop closed
// for a fortnight has to find its sandboxes again — it just stops asking every half minute.
test("a link nobody has answered in a long time rests between tries, and is never given up", async () => {
    jest.useFakeTimers();
    try {
        const RUNG_MS = 30_000;
        const { link, sockets, said } = dialling(RUNG_MS);
        // Up to the threshold on the ordinary ladder: drop, wait its rung, get the next socket.
        for (let attempt = 1; attempt < LONG_OUTAGE_ATTEMPTS; attempt += 1) {
            // oxlint-disable-next-line eslint/no-await-in-loop -- one drop per attempt is serial by definition
            await waitFor(() => expect(sockets).toHaveLength(attempt));
            sockets.at(-1)?.drops(1006);
            // oxlint-disable-next-line eslint/no-await-in-loop -- ditto
            await advanceTimersByTimeAsync(RUNG_MS);
        }
        await waitFor(() => expect(sockets).toHaveLength(LONG_OUTAGE_ATTEMPTS));
        sockets.at(-1)?.drops(1006);

        // The ladder's own rung would have redialled by now. This one is resting.
        await advanceTimersByTimeAsync(RUNG_MS);
        expect(sockets).toHaveLength(LONG_OUTAGE_ATTEMPTS);

        // And it does come round: slowed, never abandoned.
        await advanceTimersByTimeAsync(LONG_OUTAGE_MS - RUNG_MS);
        await waitFor(() => expect(sockets).toHaveLength(LONG_OUTAGE_ATTEMPTS + 1));

        // And one answer puts it straight back on the fast ladder — the outage is over, the penalty goes with it.
        sockets.at(-1)?.opens();
        sockets.at(-1)?.drops(1006);
        expect(said.at(-1)).toBe("disconnected (1006); reconnecting in 30s");

        link.stop();
        await link.done;
    } finally {
        jest.useRealTimers();
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
    await waitFor(() => expect(answer).toEqual(expect.any(Function)));
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
    await waitFor(() => expect(answer).toEqual(expect.any(Function)));
    careless.stop();
    answer?.();
    await waitFor(() => expect(late[0]?.closed).toEqual({ code: 1000, reason: "stopping" }));
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
    await waitFor(() => expect(sockets).toHaveLength(1));
    sockets[0]?.opens();
    sockets[0]?.drops(1006);
    await link.done;
    expect(sockets).toHaveLength(1);
    expect(link.state()).toBe("closed");
});
