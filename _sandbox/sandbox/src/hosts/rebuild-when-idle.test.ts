import type { DeviceFlowLine, DeviceSandboxFlow } from "@intentic/sandbox-contract";
import type { RestartResume } from "../agent/run/turn/restart-resume.js";
import { createRebuildWhenIdle, type RebuildWhenIdle } from "./rebuild-when-idle.js";

// E2: "Rebuild now" cut four agents mid-turn. Asked to wait, the sandbox holds the rebuild until no agent is mid-turn,
// then hands it to the device exactly as the button would, asking the next boot to resume whatever the restart still
// cuts; a device that answers in words instead of restarting leaves nothing asked and says why.

let busy: string[] = [];
let relayed: { host: string; flow: DeviceSandboxFlow }[] = [];
// What the device answers: nothing (the stream dies at the cutover, as a real swap of this sandbox does), or words.
let answer: DeviceFlowLine[] = [];
let asks: string[] = [];
let waiter: RebuildWhenIdle | undefined;

const restartResume: RestartResume = {
    ask: async () => {
        asks.push("ask");
    },
    withdraw: async () => {
        asks.push("withdraw");
    },
    take: async () => false,
};

const make = (slug: () => string | undefined = () => "work"): RebuildWhenIdle => {
    waiter = createRebuildWhenIdle({
        midTurn: () => busy,
        async *relay (host, flow) {
            relayed.push({ host, flow });
            yield* answer;
        },
        restartResume,
        slug,
        logger: { info: () => undefined, warn: () => undefined },
        pollMs: 5,
        now: () => 1_000,
    });
    return waiter;
};

const tick = async (ms = 20): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, ms));
};

afterEach(() => {
    waiter?.stop();
    waiter = undefined;
    busy = [];
    relayed = [];
    answer = [];
    asks = [];
});

test("waits while an agent is mid-turn, naming it, and rebuilds by itself once none is", async () => {
    busy = ["LEDGERLY", "ORCHESTRATOR"];
    const rebuild = make();
    expect(await rebuild.ask({ host: "rog", hash: "approved" })).toBeUndefined();
    await tick();
    expect(relayed).toEqual([]);
    expect(rebuild.state()).toEqual({ host: "rog", hash: "approved", requestedAt: 1_000, phase: "waiting", waitingOn: ["LEDGERLY", "ORCHESTRATOR"] });

    busy = [];
    await tick();
    expect(relayed).toEqual([{ host: "rog", flow: { op: "rebuild", slug: "work", hash: "approved" } }]);
    // The turn that started while it built is cut at the restart, so the next boot is asked to resume it; the stream
    // dying at the cutover never lets this process withdraw that.
    expect(asks).toEqual(["ask"]);
    expect(rebuild.state()?.phase).toBe("rebuilding");
});

test("a stream that stopped without a word, with this sandbox still up long after, is said to have lost contact", async () => {
    const rebuild = createRebuildWhenIdle({
        midTurn: () => [],
        async *relay () {
            yield { kind: "line", text: "building" } as const;
        },
        restartResume,
        slug: () => "work",
        logger: { info: () => undefined, warn: () => undefined },
        cutoverGraceMs: 10,
        now: () => 1_000,
    });
    waiter = rebuild;
    await rebuild.ask({ host: "rog", hash: "approved" });
    await tick(40);
    expect(rebuild.state()).toMatchObject({ phase: "failed", message: expect.stringContaining("Lost contact with that device") });
});

test("starts at once when nobody is mid-turn, and a started rebuild cannot be withdrawn", async () => {
    // A stream that never ends is a device still building.
    const rebuild = createRebuildWhenIdle({
        midTurn: () => [],
        async *relay () {
            await new Promise<never>(() => undefined);
            yield* [];
        },
        restartResume,
        slug: () => "work",
        logger: { info: () => undefined, warn: () => undefined },
        pollMs: 5,
        now: () => 1_000,
    });
    waiter = rebuild;
    await rebuild.ask({ host: "rog", hash: "approved" });
    expect(rebuild.state()).toEqual({ host: "rog", hash: "approved", requestedAt: 1_000, phase: "rebuilding", waitingOn: [] });
    expect(rebuild.cancel()).toBe("started");
    expect(rebuild.state()?.phase).toBe("rebuilding");
});

test("a waiting rebuild is withdrawn and never starts", async () => {
    busy = ["LEDGERLY"];
    const rebuild = make();
    await rebuild.ask({ host: "rog", hash: "approved" });
    expect(rebuild.cancel()).toBeUndefined();
    expect(rebuild.state()).toBeUndefined();
    busy = [];
    await tick();
    expect(relayed).toEqual([]);
    expect(asks).toEqual([]);
});

test("a device that refuses leaves nothing asked of the next boot and says why until dismissed", async () => {
    answer = [
        { kind: "line", text: "checking the overlay" },
        { kind: "error", message: "Manage sandboxes is off on rog." },
    ];
    const rebuild = make();
    await rebuild.ask({ host: "rog", hash: "approved" });
    await tick();
    expect(asks).toEqual(["ask", "withdraw"]);
    expect(rebuild.state()).toEqual({
        host: "rog",
        hash: "approved",
        requestedAt: 1_000,
        phase: "failed",
        waitingOn: [],
        message: "Manage sandboxes is off on rog.",
    });
    expect(rebuild.cancel()).toBeUndefined();
    expect(rebuild.state()).toBeUndefined();
});

test("a device with nothing to do answers in words and the ask simply ends", async () => {
    answer = [{ kind: "result", message: "Already running that environment." }];
    const rebuild = make();
    await rebuild.ask({ host: "rog", hash: "approved" });
    await tick();
    expect(asks).toEqual(["ask", "withdraw"]);
    expect(rebuild.state()).toBeUndefined();
});

test("a sandbox no device knows by name cannot be asked to rebuild itself", async () => {
    const rebuild = make(() => undefined);
    expect(await rebuild.ask({ host: "rog", hash: "approved" })).toBe("unnamed");
    expect(rebuild.state()).toBeUndefined();
});
