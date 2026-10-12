import { type ChildProcess, fork } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import type { SynthAsk, SynthSpec, Synthesized } from "./voice-synth.js";
import type { VoiceWorkerAnswer, VoiceWorkerAsk } from "./voice-worker.js";

// The daemon's side of the voice process (voice-worker.ts). A process of its own, apart from dictation's, for the
// reasons that one has (speech-engine.ts: a loaded model's memory comes back reliably only on exit, sherpa-onnx's ONNX
// Runtime should not share an address space with OCR's, a native crash takes down only this) and one more: a reply
// being spoken and a phrase being heard never wait on each other. Started by the first sentence, stopped after IDLE_MS
// without one; the next sentence starts it again in a second or two.

const IDLE_MS = 10 * 60_000;
// The tail of the process's stderr kept for the log line when it dies: ONNX Runtime explains itself there.
const STDERR_KEPT = 4_000;

export interface VoiceProcess {
    readonly load: (spec: SynthSpec) => Promise<void>;
    readonly say: (spec: SynthSpec, ask: SynthAsk) => Promise<Synthesized>;
    // The model is in memory now, so its next sentence is spoken without a load first.
    readonly loaded: (model: string) => boolean;
    readonly close: () => void;
}

export interface VoiceProcessDeps {
    readonly log: (message: string) => void;
    readonly idleMs?: number;
    // The process to talk to; a test hands it a fake.
    readonly spawn?: () => ChildProcess;
}

// The worker beside this file, through tsx when this runs from source under node; bun runs TypeScript itself.
const spawnWorker = (): ChildProcess => {
    const source = import.meta.url.endsWith(".ts");
    const entry = fileURLToPath(new URL(source ? "./voice-worker.ts" : "./voice-worker.js", import.meta.url));
    const execArgv = source && process.versions["bun"] === undefined ? ["--import", createRequire(import.meta.url).resolve("tsx")] : [];
    return fork(entry, [], { execArgv, serialization: "advanced", stdio: ["ignore", "ignore", "pipe", "ipc"] });
};

interface Waiting {
    readonly resolve: (answer: Extract<VoiceWorkerAnswer, { ok: true }>) => void;
    readonly reject: (error: Error) => void;
}

export const createVoiceProcess = ({ log, idleMs = IDLE_MS, spawn = spawnWorker }: VoiceProcessDeps): VoiceProcess => {
    let child: ChildProcess | undefined;
    let nextId = 0;
    const pending = new Map<number, Waiting>();
    const inMemory = new Set<string>();
    let idle: ReturnType<typeof setTimeout> | undefined;

    const stop = (): void => {
        clearTimeout(idle);
        const running = child;
        child = undefined;
        running?.kill();
        inMemory.clear();
    };

    const armIdle = (): void => {
        clearTimeout(idle);
        idle = setTimeout(() => {
            if (pending.size === 0 && child !== undefined) {
                log("voice process idle, stopping it to free its memory");
                stop();
            }
        }, idleMs);
        idle.unref?.();
    };

    const start = (): ChildProcess => {
        const spawned = spawn();
        let stderr = "";
        spawned.stderr?.on("data", (chunk: Buffer) => {
            stderr = (stderr + chunk.toString()).slice(-STDERR_KEPT);
        });
        spawned.on("message", (answer: VoiceWorkerAnswer) => {
            const waiting = pending.get(answer.id);
            pending.delete(answer.id);
            if (answer.ok) {
                waiting?.resolve(answer);
            } else {
                waiting?.reject(new Error(answer.message));
            }
            armIdle();
        });
        const gone = (reason: string): void => {
            if (child !== spawned) {
                return;
            }
            child = undefined;
            clearTimeout(idle);
            inMemory.clear();
            const said = stderr.trim();
            const failure = new Error(`the voice process ${reason}${said === "" ? "" : `: ${said.split("\n").slice(-3).join(" | ")}`}`);
            if (pending.size > 0) {
                log(failure.message);
            }
            for (const waiting of pending.values()) {
                waiting.reject(failure);
            }
            pending.clear();
        };
        spawned.on("exit", (code, signal) => gone(signal === null ? `exited with code ${code}` : `was killed by ${signal}`));
        spawned.on("error", (error) => gone(`failed: ${error.message}`));
        return spawned;
    };

    const ask = (build: (id: number) => VoiceWorkerAsk): Promise<Extract<VoiceWorkerAnswer, { ok: true }>> => {
        child ??= start();
        const id = nextId++;
        const running = child;
        return new Promise((resolve, reject) => {
            pending.set(id, { resolve, reject });
            clearTimeout(idle);
            running.send(build(id), (error) => {
                if (error !== null && pending.delete(id)) {
                    reject(error);
                }
            });
        });
    };

    return {
        load: async (spec) => {
            if (inMemory.has(spec.model) && child !== undefined) {
                return;
            }
            await ask((id) => ({ id, kind: "load", spec }));
            inMemory.add(spec.model);
        },
        say: async (spec, sentence) => {
            const answer = await ask((id) => ({ id, kind: "say", spec, ask: sentence }));
            inMemory.add(spec.model);
            if (answer.samples === undefined || answer.sampleRate === undefined) {
                throw new Error("the voice process answered a sentence with no audio");
            }
            return { samples: answer.samples, sampleRate: answer.sampleRate };
        },
        loaded: (model) => child !== undefined && inMemory.has(model),
        close: stop,
    };
};
