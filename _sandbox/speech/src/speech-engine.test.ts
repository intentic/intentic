import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { waitFor } from "@intentic/testing/bun";
import { createSpeechProcess } from "./speech-engine.js";
import type { RecognizerSpec } from "./speech-recognizers.js";
import type { WorkerAnswer, WorkerAsk } from "./speech-worker.js";

/* The daemon's side of the speech process over a fake child: answers find their askers, a crash fails what was in
   flight and the next ask starts a fresh process, and an idle one is stopped to hand its memory back. */

const SPEC: RecognizerSpec = { engine: "parakeet", dir: "/models/parakeet", threads: 2 };

// A child that answers each ask the way `answer` says, or holds it when `answer` returns undefined.
const fakeChild = (answer: (ask: WorkerAsk) => WorkerAnswer | undefined) => {
    const spawned: (EventEmitter & { asks: WorkerAsk[]; killed: boolean })[] = [];
    const spawn = (): ChildProcess => {
        const child = Object.assign(new EventEmitter(), { asks: [] as WorkerAsk[], killed: false, stderr: new EventEmitter() });
        spawned.push(child);
        return Object.assign(child, {
            send: (ask: WorkerAsk, callback: (error: Error | null) => void) => {
                child.asks.push(ask);
                callback(null);
                const reply = answer(ask);
                if (reply !== undefined) {
                    queueMicrotask(() => child.emit("message", reply));
                }
                return true;
            },
            kill: () => {
                child.killed = true;
                queueMicrotask(() => child.emit("exit", null, "SIGTERM"));
                return true;
            },
        }) as unknown as ChildProcess;
    };
    return { spawn, spawned };
};

test("a phrase is heard by the process and its text comes back to the one who asked", async () => {
    const child = fakeChild((ask) => ({ id: ask.id, ok: true, text: ask.kind === "decode" ? `heard ${ask.samples.length}` : "" }));
    let changes = 0;
    const speech = createSpeechProcess({ log: () => {}, spawn: child.spawn, onChange: () => (changes += 1) });
    expect(speech.loaded("parakeet")).toBe(false);
    const [first, second] = await Promise.all([speech.decode(SPEC, new Float32Array(3)), speech.decode(SPEC, new Float32Array(5))]);
    expect([first, second]).toEqual(["heard 3", "heard 5"]);
    expect(child.spawned).toHaveLength(1);
    expect(speech.loaded("parakeet")).toBe(true);
    expect(changes).toBe(1);
    speech.close();
});

test("a model's failure is the asker's error, and the process stays up for the next phrase", async () => {
    const child = fakeChild((ask) => ({ id: ask.id, ok: false, message: "model file missing" }));
    const speech = createSpeechProcess({ log: () => {}, spawn: child.spawn });
    await expect(speech.decode(SPEC, new Float32Array(1))).rejects.toThrow("model file missing");
    await expect(speech.load(SPEC)).rejects.toThrow("model file missing");
    expect(child.spawned).toHaveLength(1);
    speech.close();
});

test("a crash fails what was in flight, says why, and the next phrase starts a fresh process", async () => {
    let hold = true;
    const child = fakeChild((ask) => (hold ? undefined : { id: ask.id, ok: true, text: "after" }));
    const logged: string[] = [];
    const speech = createSpeechProcess({ log: (message) => logged.push(message), spawn: child.spawn });
    const lost = speech.decode(SPEC, new Float32Array(1));
    await waitFor(() => expect(child.spawned[0]?.asks).toHaveLength(1));
    child.spawned[0]?.emit("exit", null, "SIGSEGV");
    await expect(lost).rejects.toThrow("the speech process was killed by SIGSEGV");
    expect(logged.some((line) => line.includes("SIGSEGV"))).toBe(true);
    hold = false;
    expect(await speech.decode(SPEC, new Float32Array(1))).toBe("after");
    expect(child.spawned).toHaveLength(2);
    speech.close();
});

test("an idle process is stopped, and what it held is no longer in memory", async () => {
    const child = fakeChild((ask) => ({ id: ask.id, ok: true, text: "" }));
    const speech = createSpeechProcess({ log: () => {}, spawn: child.spawn, idleMs: 20 });
    await speech.load(SPEC);
    expect(speech.loaded("parakeet")).toBe(true);
    await waitFor(() => expect(child.spawned[0]?.killed).toBe(true));
    expect(speech.loaded("parakeet")).toBe(false);
});

// 2026-11-26: on a laptop with its memory nearly gone, a hover over the mic kept 856 MB loaded for ten minutes.
test("while memory is short, an idle process is stopped after the short wait rather than the full one, and says why", async () => {
    const child = fakeChild((ask) => ({ id: ask.id, ok: true, text: "" }));
    const logged: string[] = [];
    const speech = createSpeechProcess({
        log: (message) => logged.push(message),
        spawn: child.spawn,
        idleMs: 60_000,
        shortIdleMs: 20,
        short: async () => true,
    });
    await speech.load(SPEC);
    await waitFor(() => expect(child.spawned[0]?.killed).toBe(true));
    expect(speech.loaded("parakeet")).toBe(false);
    expect(logged).toEqual(["speech process idle while memory is short, stopping it early to free its memory"]);
});

test("while memory has room the full wait stands, and the process is let go at the first look after memory turns short", async () => {
    const child = fakeChild((ask) => ({ id: ask.id, ok: true, text: "" }));
    let looks = 0;
    let short = false;
    const speech = createSpeechProcess({
        log: () => {},
        spawn: child.spawn,
        idleMs: 60_000,
        shortIdleMs: 10,
        short: async () => {
            looks += 1;
            return short;
        },
    });
    await speech.load(SPEC);
    await waitFor(() => expect(looks).toBeGreaterThanOrEqual(3));
    expect([child.spawned[0]?.killed, speech.loaded("parakeet")]).toEqual([false, true]);
    short = true;
    await waitFor(() => expect(child.spawned[0]?.killed).toBe(true));
    speech.close();
});

test("a memory reading that fails is no shortage: the process stays for the full wait", async () => {
    const child = fakeChild((ask) => ({ id: ask.id, ok: true, text: "" }));
    let looks = 0;
    const speech = createSpeechProcess({
        log: () => {},
        spawn: child.spawn,
        idleMs: 60_000,
        shortIdleMs: 10,
        short: async () => {
            looks += 1;
            throw new Error("no cgroup here");
        },
    });
    await speech.load(SPEC);
    await waitFor(() => expect(looks).toBeGreaterThanOrEqual(3));
    expect(child.spawned[0]?.killed).toBe(false);
    speech.close();
});

test("a phrase asked while a look waits on the memory reading keeps the process: the look speaks for a spell that ended", async () => {
    // Decodes are held, so the phrase is still in hand when memory answers.
    const child = fakeChild((ask) => (ask.kind === "decode" ? undefined : { id: ask.id, ok: true, text: "" }));
    const readings: ((short: boolean) => void)[] = [];
    const speech = createSpeechProcess({
        log: () => {},
        spawn: child.spawn,
        idleMs: 60_000,
        shortIdleMs: 10,
        short: () => new Promise<boolean>((resolve) => readings.push(resolve)),
    });
    await speech.load(SPEC);
    // The look is out, waiting on memory; a phrase arrives meanwhile, and only then does memory answer "short".
    await waitFor(() => expect(readings).toHaveLength(1));
    const phrase = speech.decode(SPEC, new Float32Array(1));
    await waitFor(() => expect(child.spawned[0]?.asks).toHaveLength(2));
    readings[0]?.(true);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(child.spawned[0]?.killed).toBe(false);
    child.spawned[0]?.emit("message", { id: 1, ok: true, text: "kept" } satisfies WorkerAnswer);
    expect(await phrase).toBe("kept");
    speech.close();
});
