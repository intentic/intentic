import type { DeviceCommandResult } from "@intentic/sandbox-contract/schemas/devices";
import { DEV_REBUILD_EXIT_MARK, DEV_REBUILD_QUIET_MARK, DEV_REBUILD_SWAP_MARK, DEV_REBUILD_WAITING_MARK } from "@intentic/sandbox-contract/schemas/devices";
import type { RestartResume } from "../../system/restart-resume.js";
import { createDevSwapWhenIdle, type DevSwapCommand, type DevSwapWhenIdle } from "../idle/dev-swap-when-idle.js";

// A checkout rebuild held at its swap gate, let through by this sandbox the moment nobody is mid-turn: the hold placed
// first, the build's log read only while letting it through would cut nobody, and the release sent only once the gate
// is actually holding — never before, since a release ahead of the gate is a restart the moment the build ends,
// whoever is mid-turn by then.

let busy: string[] = [];
let sent: { host: string; command: DevSwapCommand }[] = [];
// What the build's log reads as, one stdout per read; the last repeats.
let logs: string[] = [];
// The device's words for a command it would not run.
const refuse = new Map<DevSwapCommand, string>();
let asks: string[] = [];
let waiter: DevSwapWhenIdle | undefined;

const read = (...lines: string[]): string => [`${DEV_REBUILD_QUIET_MARK} 3`, ...lines].join("\n");
const BUILDING = read("#21 [stage-0 18/23] RUN apt-get update");
const HOLDING = read("#27 DONE 192.3s", DEV_REBUILD_WAITING_MARK);
const SWAPPING = read(DEV_REBUILD_WAITING_MARK, DEV_REBUILD_SWAP_MARK, "intentic: pre-flighting…");
const ENDED = read("intentic: done", `${DEV_REBUILD_EXIT_MARK} 0`);

const restartResume: RestartResume = {
    ask: async () => {
        asks.push("ask");
    },
    withdraw: async () => {
        asks.push("withdraw");
    },
    take: async () => false,
    announce: (intent) => {
        asks.push(`announce ${intent.by} ${intent.action}`);
    },
};

const answer = (command: DevSwapCommand): DeviceCommandResult => {
    const refusal = refuse.get(command);
    if (refusal !== undefined) {
        return { ok: false, refused: false, message: refusal, output: refusal };
    }
    if (command === "dev-rebuild-log") {
        const text = logs.length > 1 ? (logs.shift() ?? "") : (logs[0] ?? "");
        return { ok: true, refused: false, message: text, output: text };
    }
    return { ok: true, refused: false, message: "done", output: "done" };
};

const make = (): DevSwapWhenIdle => {
    waiter = createDevSwapWhenIdle({
        working: () => busy,
        run: async (host, command) => {
            sent.push({ host, command });
            return answer(command);
        },
        restartResume,
        logger: { info: () => undefined, warn: () => undefined },
        pollMs: 5,
        now: () => 1_000,
    });
    return waiter;
};

const tick = async (ms = 25): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, ms));
};
const commands = (): DevSwapCommand[] => sent.map((call) => call.command);

afterEach(() => {
    waiter?.stop();
    waiter = undefined;
    busy = [];
    sent = [];
    logs = [];
    refuse.clear();
    asks = [];
});

test("holds the gate, waits while an agent is mid-turn without reading the log, and lets it through once none is", async () => {
    busy = ["LEDGERLY", "ORCHESTRATOR"];
    logs = [HOLDING];
    const swap = make();
    await swap.ask({ host: "rog" });
    await tick();
    // The hold, and nothing else: reading the log while somebody is mid-turn would decide nothing.
    expect(commands()).toEqual(["dev-rebuild-hold"]);
    expect(swap.state()).toEqual({ host: "rog", requestedAt: 1_000, phase: "waiting", waitingOn: ["LEDGERLY", "ORCHESTRATOR"] });

    busy = [];
    await tick();
    expect(commands().slice(0, 3)).toEqual(["dev-rebuild-hold", "dev-rebuild-log", "dev-rebuild-release"]);
    expect(sent.every((call) => call.host === "rog")).toBe(true);
    // Named as the daemon's restart, and the next boot asked to resume a turn that starts in the gap.
    expect(asks).toEqual(["announce daemon rebuild", "ask"]);
    expect(swap.state()).toEqual({ host: "rog", requestedAt: 1_000, phase: "released", waitingOn: [] });
});

test("never lets a gate through before the build is holding at it", async () => {
    logs = [BUILDING, BUILDING, HOLDING];
    const swap = make();
    await swap.ask({ host: "rog" });
    await tick(8);
    expect(commands()).not.toContain("dev-rebuild-release");
    expect(swap.state()?.phase).toBe("waiting");
    await tick(40);
    expect(commands()).toContain("dev-rebuild-release");
    expect(swap.state()?.phase).toBe("released");
});

test("clears itself once the build has ended, and a wait whose gate the owner let through reads as released", async () => {
    logs = [SWAPPING, ENDED];
    const swap = make();
    await swap.ask({ host: "rog" });
    await tick(8);
    // Let through by someone else (the card's own Restart now): nothing left to release.
    expect(commands()).not.toContain("dev-rebuild-release");
    await tick(40);
    expect(swap.state()).toBeUndefined();
});

test("says a hold the device would not take in its words, and polls no further", async () => {
    refuse.set("dev-rebuild-hold", "mkdir: cannot create directory: Permission denied");
    const swap = make();
    await swap.ask({ host: "rog" });
    await tick();
    expect(swap.state()).toMatchObject({ phase: "failed", message: "mkdir: cannot create directory: Permission denied", waitingOn: [] });
    expect(commands()).toEqual(["dev-rebuild-hold"]);
});

test("withdraws the resume ask when the release could not be sent", async () => {
    logs = [HOLDING];
    refuse.set("dev-rebuild-release", "The command was killed after 20s.");
    const swap = make();
    await swap.ask({ host: "rog" });
    await tick();
    expect(asks).toEqual(["announce daemon rebuild", "ask", "withdraw"]);
    expect(swap.state()).toMatchObject({ phase: "failed", message: "The command was killed after 20s." });
});

test("stops waiting on cancel without touching the hold, which is the page's to send next", async () => {
    busy = ["LEDGERLY"];
    logs = [HOLDING];
    const swap = make();
    await swap.ask({ host: "rog" });
    swap.cancel();
    busy = [];
    await tick();
    expect(swap.state()).toBeUndefined();
    expect(commands()).toEqual(["dev-rebuild-hold"]);
});

test("a second ask replaces the first, on the device it names", async () => {
    busy = ["LEDGERLY"];
    const swap = make();
    await swap.ask({ host: "rog" });
    await swap.ask({ host: "omen" });
    expect(swap.state()).toMatchObject({ host: "omen", phase: "waiting" });
    expect(sent).toEqual([
        { host: "rog", command: "dev-rebuild-hold" },
        { host: "omen", command: "dev-rebuild-hold" },
    ]);
});
