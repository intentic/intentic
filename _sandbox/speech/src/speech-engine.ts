import { type ChildProcess, fork } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import type { SpeechEngine } from "@intentic/sandbox-contract/schemas/speech";
import type { RecognizerSpec } from "./speech-recognizers.js";
import type { WorkerAnswer, WorkerAsk } from "./speech-worker.js";

// The daemon's side of the speech process (speech-worker.ts). A process of its own rather than a worker thread for
// three reasons: a loaded model holds about a gigabyte that only an exit reliably hands back to the box, sherpa-onnx
// brings an ONNX Runtime of its own that should not share an address space with the one OCR loads, and a native crash
// in either takes down only this. Started by the first phrase or `load`, and stopped after IDLE_MS without one, or after
// SHORT_IDLE_MS while memory is short; the next phrase starts it again in a few seconds.

const IDLE_MS = 10 * 60_000;
/* AN IDLE MODEL GIVES WAY TO SHORT MEMORY (2026-11-26). On the owner's laptop, its memory nearly gone, this process held
   856 MB for ten minutes after a hover over the mic that never became a phrase. While the sandbox or its host is short
   (`short`, the daemon's own reading of its room), an idle process is stopped after this instead; the rest of the time
   the ten minutes stand, so a person who pauses between phrases does not pay a reload. */
const SHORT_IDLE_MS = 2 * 60_000;
// The tail of the process's stderr kept for the log line when it dies: ONNX Runtime explains itself there.
const STDERR_KEPT = 4_000;

export interface SpeechProcess {
    readonly load: (spec: RecognizerSpec) => Promise<void>;
    readonly decode: (spec: RecognizerSpec, samples: Float32Array) => Promise<string>;
    // In memory now, so its next phrase is heard without a load first.
    readonly loaded: (engine: SpeechEngine) => boolean;
    // Something is being heard or loaded right now: what a running guess at an unfinished phrase yields to.
    readonly busy: () => boolean;
    readonly close: () => void;
}

export interface SpeechProcessDeps {
    readonly log: (message: string) => void;
    // Told when what is in memory changes: a model loaded, or the process stopped.
    readonly onChange?: () => void;
    readonly idleMs?: number;
    // Whether memory is short right now: an idle process is then stopped after `shortIdleMs` rather than `idleMs`.
    // Without it, the full wait always stands.
    readonly short?: (() => Promise<boolean>) | undefined;
    readonly shortIdleMs?: number;
    // The process to talk to; a test hands it a fake.
    readonly spawn?: () => ChildProcess;
}

/** Whether memory reads short now; a reading that cannot be taken is no shortage, the way the daemon's room fails open. */
export const shortNow = async (short: SpeechProcessDeps["short"]): Promise<boolean> =>
    // allow(silent-catch): a memory reading that fails measures nothing, and nothing measured is never short.
    (await short?.().catch(() => false)) === true;

// The worker beside this file, through tsx when this runs from source under node; bun runs TypeScript itself.
const spawnWorker = (): ChildProcess => {
    const source = import.meta.url.endsWith(".ts");
    const entry = fileURLToPath(new URL(source ? "./speech-worker.ts" : "./speech-worker.js", import.meta.url));
    const execArgv = source && process.versions["bun"] === undefined ? ["--import", createRequire(import.meta.url).resolve("tsx")] : [];
    return fork(entry, [], { execArgv, serialization: "advanced", stdio: ["ignore", "ignore", "pipe", "ipc"] });
};

interface IdleClock {
    // A spell begins: the process answered its last ask and has nothing in hand.
    readonly arm: () => void;
    // The spell is over: something was asked, or the process stopped.
    readonly cancel: () => void;
}

// The idle spell's clock. It looks every `shortIdleMs`, stopping the process once memory reads short, and at `idleMs`
// whatever memory says.
const idleClock = (
    { log, idleMs = IDLE_MS, short, shortIdleMs = SHORT_IDLE_MS }: Pick<SpeechProcessDeps, "log" | "idleMs" | "short" | "shortIdleMs">,
    idle: () => boolean,
    stop: () => void,
): IdleClock => {
    const step = short === undefined ? idleMs : Math.min(shortIdleMs, idleMs);
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Which spell a look belongs to: one still waiting on the memory reading when the spell ends speaks for nobody.
    let spell = 0;
    const cancel = (): void => {
        clearTimeout(timer);
        spell += 1;
    };
    const arm = (): void => {
        cancel();
        const mine = spell;
        const still = (): boolean => mine === spell && idle();
        let waited = 0;
        const wait = (): void => {
            const next = Math.min(step, idleMs - waited);
            timer = setTimeout(() => void look(next), next);
            timer.unref?.();
        };
        const look = async (slept: number): Promise<void> => {
            waited += slept;
            if (!still()) {
                return;
            }
            const reason = waited >= idleMs ? "idle" : (await shortNow(short)) ? "short" : undefined;
            if (!still()) {
                return;
            }
            if (reason === undefined) {
                wait();
                return;
            }
            log(
                reason === "idle"
                    ? "speech process idle, stopping it to free its memory"
                    : "speech process idle while memory is short, stopping it early to free its memory",
            );
            stop();
        };
        wait();
    };
    return { arm, cancel };
};

export const createSpeechProcess = (deps: SpeechProcessDeps): SpeechProcess => {
    const { log, onChange, spawn = spawnWorker } = deps;
    let child: ChildProcess | undefined;
    let nextId = 0;
    const pending = new Map<number, { readonly resolve: (text: string) => void; readonly reject: (error: Error) => void }>();
    const inMemory = new Set<SpeechEngine>();

    const stop = (): void => {
        clock.cancel();
        const running = child;
        child = undefined;
        running?.kill();
        if (inMemory.size > 0) {
            inMemory.clear();
            onChange?.();
        }
    };
    const clock = idleClock(deps, () => pending.size === 0 && child !== undefined, stop);

    const start = (): ChildProcess => {
        const spawned = spawn();
        let stderr = "";
        spawned.stderr?.on("data", (chunk: Buffer) => {
            stderr = (stderr + chunk.toString()).slice(-STDERR_KEPT);
        });
        spawned.on("message", (answer: WorkerAnswer) => {
            const waiting = pending.get(answer.id);
            pending.delete(answer.id);
            if (answer.ok) {
                waiting?.resolve(answer.text);
            } else {
                waiting?.reject(new Error(answer.message));
            }
            clock.arm();
        });
        const gone = (reason: string): void => {
            if (child !== spawned) {
                return;
            }
            child = undefined;
            clock.cancel();
            const failure = new Error(
                `the speech process ${reason}${stderr.trim() === "" ? "" : `: ${stderr.trim().split("\n").slice(-3).join(" | ")}`}`,
            );
            if (pending.size > 0) {
                log(failure.message);
            }
            for (const waiting of pending.values()) {
                waiting.reject(failure);
            }
            pending.clear();
            if (inMemory.size > 0) {
                inMemory.clear();
                onChange?.();
            }
        };
        spawned.on("exit", (code, signal) => gone(signal === null ? `exited with code ${code}` : `was killed by ${signal}`));
        spawned.on("error", (error) => gone(`failed: ${error.message}`));
        return spawned;
    };

    const ask = (build: (id: number) => WorkerAsk): Promise<string> => {
        child ??= start();
        const id = nextId++;
        const running = child;
        return new Promise<string>((resolve, reject) => {
            pending.set(id, { resolve, reject });
            clock.cancel();
            running.send(build(id), (error) => {
                if (error !== null && pending.delete(id)) {
                    reject(error);
                }
            });
        });
    };

    const remember = (engine: SpeechEngine): void => {
        if (!inMemory.has(engine)) {
            inMemory.add(engine);
            onChange?.();
        }
    };

    return {
        load: async (spec) => {
            if (inMemory.has(spec.engine) && child !== undefined) {
                return;
            }
            await ask((id) => ({ id, kind: "load", spec }));
            remember(spec.engine);
        },
        decode: async (spec, samples) => {
            const text = await ask((id) => ({ id, kind: "decode", spec, samples }));
            remember(spec.engine);
            return text;
        },
        loaded: (engine) => child !== undefined && inMemory.has(engine),
        busy: () => pending.size > 0,
        close: stop,
    };
};
