// A live socket keeps itself alive: it dials again after a drop, lets a replaced channel go quiet, closes one that has
// stopped answering, and cuts a wait short when the sandbox comes back. Each case drives the channel's side by hand.
import "@intentic/testing/dom";
import { waitFor } from "@intentic/testing/bun";
import { nextTick, ref } from "vue";
import { liveSocket, type LiveChannel, type LiveLink, type LiveSocketOptions } from "./liveSocket";

// One dialled channel as the socket sees it, with the far end's moves on it.
interface Dialled {
    readonly address: string;
    readonly link: LiveLink;
    readonly sent: object[];
    closes: number;
}

// Short enough that the ladder and the silence clock run inside a test, long enough that nothing fires on its own
// between two lines of one.
const FAST = { pingMs: 40, retryMs: 20, maxRetryMs: 40, stableMs: 10_000, staleMs: 100 };

const harness = (over: Partial<LiveSocketOptions<string, object>> = {}) => {
    const dialled: Dialled[] = [];
    const drops: number[] = [];
    let minted = 0;
    const reachable = ref(true);
    const live = liveSocket<string, object>({
        mint: async () => `wss://sandbox.test/live?n=${(minted += 1)}`,
        open: (address, link): LiveChannel<object> => {
            const entry: Dialled = { address, link, sent: [], closes: 0 };
            dialled.push(entry);
            return { send: (message) => entry.sent.push(message), close: () => (entry.closes += 1), ready: () => true };
        },
        onDrop: (code) => drops.push(code),
        reachable,
        timing: FAST,
        ...over,
    });
    return { live, dialled, drops, reachable };
};

const live: { dispose: () => void }[] = [];
afterEach(() => {
    for (const socket of live.splice(0)) {
        socket.dispose();
    }
});

test("a dropped channel is dialled again with a fresh address, and the drop is told once", async () => {
    const { live: socket, dialled, drops } = harness();
    live.push(socket);
    socket.connect();
    await waitFor(() => expect(dialled).toHaveLength(1));
    dialled[0]!.link.opened();

    dialled[0]!.link.closed(1006, ``);

    await waitFor(() => expect(dialled).toHaveLength(2));
    expect({ drops, addresses: dialled.map((entry) => entry.address) }).toEqual({
        drops: [1006],
        addresses: [`wss://sandbox.test/live?n=1`, `wss://sandbox.test/live?n=2`],
    });
});

test("a close the caller ends in its drop handler is never dialled again", async () => {
    const harnessed = harness({ onDrop: () => harnessed.live.end() });
    live.push(harnessed.live);
    harnessed.live.connect();
    await waitFor(() => expect(harnessed.dialled).toHaveLength(1));
    harnessed.dialled[0]!.link.opened();

    harnessed.dialled[0]!.link.closed(1008, `unauthorized`);
    await new Promise((resolve) => setTimeout(resolve, FAST.maxRetryMs * 3));

    expect({ dialled: harnessed.dialled.length, retrying: harnessed.live.retrying() }).toEqual({ dialled: 1, retrying: false });
});

test("connecting afresh lets the old channel go, and its late close and messages are nobody's", async () => {
    const { live: socket, dialled, drops } = harness();
    live.push(socket);
    socket.connect();
    await waitFor(() => expect(dialled).toHaveLength(1));
    dialled[0]!.link.opened();

    socket.connect();
    await waitFor(() => expect(dialled).toHaveLength(2));
    dialled[0]!.link.closed(1000, ``);
    await new Promise((resolve) => setTimeout(resolve, FAST.maxRetryMs * 3));

    expect({
        closedOld: dialled[0]!.closes,
        oldCurrent: dialled[0]!.link.current(),
        newCurrent: dialled[1]!.link.current(),
        drops,
        dialled: dialled.length,
    }).toEqual({ closedOld: 1, oldCurrent: false, newCurrent: true, drops: [], dialled: 2 });
});

test("a channel that opens after it was replaced is closed rather than adopted", async () => {
    const { live: socket, dialled } = harness();
    live.push(socket);
    socket.connect();
    await waitFor(() => expect(dialled).toHaveLength(1));
    socket.connect();
    await waitFor(() => expect(dialled).toHaveLength(2));

    dialled[0]!.link.opened();

    // Once by the fresh connect, once more by its own late open.
    expect(dialled[0]!.closes).toBe(2);
});

test("an open channel is pinged, and one that stops answering is closed so it can be dialled again", async () => {
    const { live: socket, dialled } = harness();
    live.push(socket);
    socket.connect();
    await waitFor(() => expect(dialled).toHaveLength(1));
    dialled[0]!.link.opened();

    await waitFor(() => expect(dialled[0]!.sent).toContainEqual({ type: `ping` }));
    // Nothing heard since it opened: past the silence bound, the next ping tick closes it instead.
    await waitFor(() => expect(dialled[0]!.closes).toBe(1), { timeout: 2_000 });
});

test("a channel that keeps answering is never closed for silence", async () => {
    const { live: socket, dialled } = harness();
    live.push(socket);
    socket.connect();
    await waitFor(() => expect(dialled).toHaveLength(1));
    dialled[0]!.link.opened();
    const heard = setInterval(() => dialled[0]!.link.heard(), FAST.pingMs / 2);

    await new Promise((resolve) => setTimeout(resolve, FAST.staleMs * 3));
    clearInterval(heard);

    expect(dialled[0]!.closes).toBe(0);
});

test("a peer that has never answered a ping is not held to the silence clock when asked not to be", async () => {
    const { live: socket, dialled } = harness({ staleCheck: `once-ponged` });
    live.push(socket);
    socket.connect();
    await waitFor(() => expect(dialled).toHaveLength(1));
    dialled[0]!.link.opened();

    await new Promise((resolve) => setTimeout(resolve, FAST.staleMs * 3));
    expect(dialled[0]!.closes).toBe(0);

    // Once it has ponged, its silence counts.
    socket.ponged();
    await waitFor(() => expect(dialled[0]!.closes).toBe(1), { timeout: 2_000 });
});

test("a mint that fails or finds nothing retries on the ladder, and the sandbox coming back cuts the wait short", async () => {
    let attempts = 0;
    const { live: socket, dialled, reachable } = harness({
        mint: async () => {
            attempts += 1;
            if (attempts === 1) {
                throw new Error(`restarting`);
            }
            return attempts === 2 ? undefined : `wss://sandbox.test/live`;
        },
        // A rung far longer than the test, so only the reachability news can bring the next attempt.
        timing: { ...FAST, retryMs: 60_000, maxRetryMs: 60_000 },
    });
    live.push(socket);
    reachable.value = false;
    socket.connect();
    await waitFor(() => expect(socket.retrying()).toBe(true));

    reachable.value = true;
    await waitFor(() => expect(attempts).toBe(2));
    await waitFor(() => expect(socket.retrying()).toBe(true));
    reachable.value = false;
    await nextTick();
    reachable.value = true;
    await waitFor(() => expect(dialled).toHaveLength(1));
});

test("a lease is handed back once per channel, whether it closed by itself or was replaced", async () => {
    let released = 0;
    const { live: socket, dialled } = harness({ lease: async () => () => (released += 1) });
    live.push(socket);
    socket.connect();
    await waitFor(() => expect(dialled).toHaveLength(1));
    socket.connect();
    await waitFor(() => expect(dialled).toHaveLength(2));

    dialled[0]!.link.closed(1000, ``);
    dialled[0]!.link.closed(1000, ``);
    dialled[1]!.link.closed(1006, ``);

    expect(released).toBe(2);
});

test("a disposed socket dials nothing more, even when the sandbox comes back", async () => {
    const { live: socket, dialled, reachable } = harness();
    socket.connect();
    await waitFor(() => expect(dialled).toHaveLength(1));
    dialled[0]!.link.opened();
    socket.dispose();

    dialled[0]!.link.closed(1006, ``);
    reachable.value = false;
    await nextTick();
    reachable.value = true;
    await new Promise((resolve) => setTimeout(resolve, FAST.maxRetryMs * 3));

    expect({ dialled: dialled.length, closes: dialled[0]!.closes, retrying: socket.retrying() }).toEqual({ dialled: 1, closes: 1, retrying: false });
});
