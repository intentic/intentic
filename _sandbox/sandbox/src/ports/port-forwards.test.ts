import { createPortForwards } from "./port-forwards.js";

// The table is indifferent to what its slots are CALLED: production salts them with the connect token
// (portSlotsFromToken), which would make every expectation below a digest. Eight readable names instead: this
// suite is about allocation order, idempotence and LRU eviction, and the derivation has its own test.
const SLOTS = ["a", "b", "c", "d", "e", "f", "g", "h"];

// Fake timers so LRU timestamps are deterministic (real Date.now can tie within one ms).
beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(0);
});
afterEach(() => {
    jest.useRealTimers();
});
const tick = (): void => {
    jest.setSystemTime(Date.now() + 1000);
};

const httpProbe = jest.fn(async () => "http" as const);

test("forwarding maps ports onto slots in order and is idempotent per port", async () => {
    const forwards = createPortForwards(SLOTS, httpProbe);
    expect(await forwards.forward(3000, "127.0.0.1")).toBe("a");
    tick();
    expect(await forwards.forward(4000, "127.0.0.1")).toBe("b");
    tick();
    expect(await forwards.forward(3000, "127.0.0.1")).toBe("a");
    expect(forwards.slotOf(4000)).toBe("b");
    expect(forwards.targetOf("a")).toEqual({ port: 3000, host: "127.0.0.1", scheme: "http" });
});

test("the probe's scheme lands on the slot: an https dev server is dialed as https", async () => {
    const forwards = createPortForwards(SLOTS, async () => "https");
    const slot = await forwards.forward(47145, "::1");
    expect(forwards.targetOf(slot)).toEqual({ port: 47145, host: "::1", scheme: "https" });
});

test("a full table evicts the least-recently-used slot, and proxy traffic counts as use", async () => {
    const forwards = createPortForwards(SLOTS, httpProbe);
    for (const [index] of SLOTS.entries()) {
        await forwards.forward(3000 + index, "127.0.0.1");
        tick();
    }
    // Touch slot "a" (port 3000) through the proxy resolver; "b" becomes the LRU.
    forwards.targetOf("a");
    tick();
    expect(await forwards.forward(9999, "127.0.0.1")).toBe("b");
    expect(forwards.slotOf(3001)).toBeUndefined();
    expect(forwards.targetOf("a")).toEqual({ port: 3000, host: "127.0.0.1", scheme: "http" });
});

test("unforward frees the slot for the next forward", async () => {
    const forwards = createPortForwards(SLOTS, httpProbe);
    await forwards.forward(3000, "127.0.0.1");
    forwards.unforward(3000);
    expect(forwards.slotOf(3000)).toBeUndefined();
    expect(forwards.targetOf("a")).toBeUndefined();
    tick();
    expect(await forwards.forward(4000, "127.0.0.1")).toBe("a");
});

test("a runner's port takes a slot of the same table, apart from this sandbox's port of the same number", async () => {
    const probe = jest.fn(async () => "http" as const);
    const forwards = createPortForwards(SLOTS, probe);
    expect(await forwards.forward(5173, "127.0.0.1")).toBe("a");
    tick();
    expect(forwards.forwardRunner("r1", 5173)).toBe("b");
    tick();
    expect(forwards.forwardRunner("r2", 5173)).toBe("c");
    // Idempotent per runner and port, and never probed: the port is the runner's.
    expect(forwards.forwardRunner("r1", 5173)).toBe("b");
    expect(forwards.slotOf(5173)).toBe("a");
    expect(forwards.slotOfRunner("r1", 5173)).toBe("b");
    expect(forwards.targetOf("b")).toEqual({ port: 5173, host: "127.0.0.1", scheme: "http", runner: "r1" });
    expect(forwards.targetOf("a")).toEqual({ port: 5173, host: "127.0.0.1", scheme: "http" });
    expect(probe).toHaveBeenCalledTimes(1);
    // A local forward of the same number keeps its own slot; unforwarding the runner's frees only its.
    expect(await forwards.forward(5173, "127.0.0.1")).toBe("a");
    forwards.unforwardRunner("r1", 5173);
    expect(forwards.targetOf("b")).toBeUndefined();
    expect(forwards.targetOf("c")).toMatchObject({ runner: "r2" });
});
