import { EventEmitter } from "node:events";
import pino from "pino";
import { engineServing, noteEngineServing } from "../../../engines/engine-resolve.js";
import { superviseTranslator, type TranslatorCopy } from "../translator-supervisor.js";

// The proxy resolves its binary once per spawn; these pin that a pointer move reaches the running process once no turn
// is in flight, and never under one.

const OLD: TranslatorCopy = {
    id: "translator",
    version: "8.0.12",
    source: "store",
    paths: {},
    binary: "/engines/translator/versions/8.0.12/cli-proxy-api",
};
const NEW: TranslatorCopy = {
    id: "translator",
    version: "8.0.13",
    source: "store",
    paths: {},
    binary: "/engines/translator/versions/8.0.13/cli-proxy-api",
};

// A child that exits when signalled, the way the real proxy answers SIGTERM. Only what the supervisor touches is real.
class FakeChild extends EventEmitter {
    readonly stdout = null;
    readonly stderr = null;
    readonly signals: (NodeJS.Signals | number | undefined)[] = [];
    kill(signal?: NodeJS.Signals | number): boolean {
        this.signals.push(signal);
        this.emit("exit", null, signal);
        return true;
    }
}

const harness = (initial: TranslatorCopy) => {
    let selected = initial;
    let busy = false;
    const spawned: { binary: string; child: FakeChild }[] = [];
    const scheduled: number[] = [];
    const supervisor = superviseTranslator({
        resolve: async () => selected,
        spawn: async (binary) => {
            const child = new FakeChild();
            spawned.push({ binary, child });
            return child;
        },
        busy: () => busy,
        logger: pino({ level: "silent" }),
        schedule: (_fn, ms) => scheduled.push(ms),
    });
    return {
        supervisor,
        spawned,
        scheduled,
        select: (copy: TranslatorCopy) => {
            selected = copy;
        },
        setBusy: (value: boolean) => {
            busy = value;
        },
    };
};

// Lets the respawn the exit handler starts run its awaits.
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

afterEach(() => noteEngineServing("translator", undefined));

test("a proxy whose copy is still the selected one is left running", async () => {
    const h = harness(OLD);
    await h.supervisor.start();

    expect(await h.supervisor.swapIfStale()).toBe(false);
    expect(h.spawned.map((entry) => entry.binary)).toEqual([OLD.binary]);
    expect(engineServing("translator")?.version).toBe("8.0.12");
});

test("a newly selected version replaces the running proxy at once when no turn is running", async () => {
    const h = harness(OLD);
    await h.supervisor.start();
    h.select(NEW);

    expect(await h.supervisor.swapIfStale()).toBe(true);
    await settle();

    expect(h.spawned[0]?.child.signals).toEqual(["SIGTERM"]);
    expect(h.spawned.map((entry) => entry.binary)).toEqual([OLD.binary, NEW.binary]);
    // Deliberate, so it skips the crash backoff entirely.
    expect(h.scheduled).toEqual([]);
    expect(engineServing("translator")?.version).toBe("8.0.13");
});

test("the swap waits while a turn is running, then happens once it ends", async () => {
    const h = harness(OLD);
    await h.supervisor.start();
    h.select(NEW);
    h.setBusy(true);

    expect(await h.supervisor.swapIfStale()).toBe(false);
    expect(h.spawned[0]?.child.signals).toEqual([]);
    expect(engineServing("translator")?.version).toBe("8.0.12");

    h.setBusy(false);
    expect(await h.supervisor.swapIfStale()).toBe(true);
    await settle();
    expect(h.spawned.map((entry) => entry.binary)).toEqual([OLD.binary, NEW.binary]);
});

test("a crash still restarts on the backoff ladder", async () => {
    const h = harness(OLD);
    await h.supervisor.start();

    h.spawned[0]?.child.emit("exit", 2, null);

    expect(h.scheduled).toEqual([10_000]);
    expect(engineServing("translator")).toBeUndefined();
});
