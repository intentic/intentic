import { readFile, stat } from "node:fs/promises";
import {
    LOCAL_MODEL_KV_BYTES_PER_TOKEN,
    LOCAL_MODEL_WINDOW_DEFAULT,
    LOCAL_MODEL_WINDOWS,
    LOCAL_MODELS,
    type LocalModelChoice,
    type LocalModelFitResponse,
    type LocalModelGpu,
    type LocalModelPrefetch,
} from "@intentic/sandbox-contract";
import { forkedExec } from "@intentic/scaffold";
import { localModelWeightsPath } from "./local-model.js";

// What this machine can actually run, measured rather than assumed. The same arithmetic gates a start
// (localmodel.handler's admission check) and sizes the connect view's recommendation, from here, so the view cannot
// offer a model the daemon will then refuse — which is the failure this module exists to make impossible.

// Deliberately conservative; the real per-device authority is llama.cpp's own fitter. The runtime floor is what the
// server costs before a single token: weights mapped, context buffers, the graph. Binary, like every other figure this
// feature quotes, since all of them are compared against a machine's RAM.
const MODEL_RUNTIME_BYTES = 1024 ** 3;
// A model may have most of the box, never all of it: the daemon, the harness and whatever the agent runs live here too.
const MODEL_CAPACITY_SHARE = 0.8;

export const estimatedModelMemory = (weightsBytes: number, window: number): number =>
    weightsBytes + window * LOCAL_MODEL_KV_BYTES_PER_TOKEN + MODEL_RUNTIME_BYTES;

// The ask's fate, stamped by the runner: "all" if --gpus=all rode, "unsupported" if the host's Docker has no nvidia
// runtime, absent if nobody ever asked. Read per call so a test need not fight module order.
const gpuEnv = (): string | undefined => process.env["SANDBOX_GPU"];

export const localModelGpu = (): LocalModelGpu => {
    const state = gpuEnv();
    return state === "all" ? "granted" : state === "unsupported" ? "unsupported" : "absent";
};

// The container's own ceiling where it binds, the engine's total otherwise: a 64 GB host says nothing about a sandbox
// capped at 8, and a cap past the engine's total never binds.
export const memoryFrom = (cgroupMax: string, meminfo: string): { bytes: number; capped: boolean } => {
    const engine = Number(/^MemTotal:\s+(\d+) kB$/m.exec(meminfo)?.[1] ?? 0) * 1024;
    const cap = /^\d+$/.test(cgroupMax.trim()) ? Number(cgroupMax.trim()) : undefined;
    return cap !== undefined && (engine <= 0 || cap < engine) ? { bytes: cap, capped: true } : { bytes: engine, capped: false };
};

export const hostMemory = async (): Promise<{ bytes: number; capped: boolean }> => {
    const [cgroupMax, meminfo] = await Promise.all([
        readFile("/sys/fs/cgroup/memory.max", "utf8").catch(() => "max"),
        readFile("/proc/meminfo", "utf8").catch(() => ""),
    ]);
    return memoryFrom(cgroupMax, meminfo);
};

// Zero until the GPU is actually passed through: before the grant there is no device to ask, so any figure here would
// be a guess dressed as a measurement.
export const gpuMemory = async (): Promise<number> => {
    if (localModelGpu() !== "granted") {
        return 0;
    }
    const result = await forkedExec("nvidia-smi", ["--query-gpu=memory.total", "--format=csv,noheader,nounits"]).catch(() => undefined);
    // Unreadable answer reads as 0 GPU memory, never a throw: that already means "size against host memory alone".
    const devices = (result?.stdout ?? "")
        .split("\n")
        .map((line) => Number(line.trim()))
        .filter(Number.isFinite);
    return Math.max(0, ...devices) * 1024 * 1024;
};

// A bare dev run has no llama-server; the local lane then costs a rebuild before it can serve anything.
export const llamaServerMissing = async (): Promise<boolean> =>
    forkedExec("llama-server", ["--version"]).then(
        () => false,
        (error) => (error as NodeJS.ErrnoException).code === "ENOENT",
    );

export interface LocalModelBudget {
    readonly memoryBytes: number;
    readonly memoryCapped: boolean;
    readonly gpu: LocalModelGpu;
    readonly gpuMemoryBytes: number;
    // What a start is admitted against. Zero means "unmeasurable", which every caller reads as "admit anything" rather
    // than "admit nothing" — refusing on a reading we could not take would be worse than letting llama.cpp decide.
    readonly budgetBytes: number;
}

export const localModelBudget = async (): Promise<LocalModelBudget> => {
    const [host, gpuBytes] = await Promise.all([hostMemory(), gpuMemory()]);
    return {
        memoryBytes: host.bytes,
        memoryCapped: host.capped,
        gpu: localModelGpu(),
        gpuMemoryBytes: gpuBytes,
        budgetBytes: Math.round((host.bytes + gpuBytes) * MODEL_CAPACITY_SHARE),
    };
};

// An unmeasurable budget admits everything: see LocalModelBudget.budgetBytes.
export const fitsBudget = (budgetBytes: number, weightsBytes: number, window: number): boolean =>
    budgetBytes <= 0 || estimatedModelMemory(weightsBytes, window) <= budgetBytes;

const held = async (root: string, choice: LocalModelChoice): Promise<boolean> =>
    stat(localModelWeightsPath(root, { file: choice.id.split("/").at(-1) ?? "" })).then(
        () => true,
        () => false,
    );

const WINDOWS = LOCAL_MODEL_WINDOWS.map(Number);
const DEFAULT_WINDOW = Number(LOCAL_MODEL_WINDOW_DEFAULT);

// The largest rung this model fits in, capped at the default: a bigger window than one full turn needs buys nothing a
// first-time reader asked for, and costs a gigabyte a rung. Undefined when even the smallest will not fit.
const windowFor = (budgetBytes: number, choice: LocalModelChoice): number | undefined =>
    [...WINDOWS]
        .filter((tokens) => tokens <= DEFAULT_WINDOW)
        .sort((left, right) => right - left)
        .find((tokens) => fitsBudget(budgetBytes, choice.weightsBytes, tokens));

const offer = (budgetBytes: number, choice: LocalModelChoice | undefined): { model: string; context: string } | undefined => {
    if (choice === undefined) {
        return undefined;
    }
    const window = windowFor(budgetBytes, choice);
    return window === undefined ? undefined : { model: choice.id, context: String(window) };
};

// Heaviest weights that still fit: the list is smallest-first, so the last survivor is the best this machine holds.
const bestChoice = (budgetBytes: number): LocalModelChoice | undefined =>
    LOCAL_MODELS.findLast((choice) => choice.tier === "work" && windowFor(budgetBytes, choice) !== undefined);

const instantChoice = (): LocalModelChoice | undefined => LOCAL_MODELS.find((choice) => choice.tier === "instant");

export const localModelFit = async (root: string, prefetch: LocalModelPrefetch): Promise<LocalModelFitResponse> => {
    const [budget, serverMissing] = await Promise.all([localModelBudget(), llamaServerMissing()]);
    const instant = offer(budget.budgetBytes, instantChoice());
    const best = offer(budget.budgetBytes, bestChoice(budget.budgetBytes));
    const options = await Promise.all(
        LOCAL_MODELS.map(async (choice) => ({
            model: choice.id,
            label: choice.label,
            tier: choice.tier,
            weightsBytes: choice.weightsBytes,
            held: await held(root, choice),
            windows: WINDOWS.map((tokens) => ({
                tokens,
                totalBytes: Math.round(estimatedModelMemory(choice.weightsBytes, tokens)),
                fits: fitsBudget(budget.budgetBytes, choice.weightsBytes, tokens),
            })),
        })),
    );
    return {
        ...budget,
        serverReady: !serverMissing,
        options,
        ...(instant === undefined ? {} : { instant }),
        ...(best === undefined ? {} : { best }),
        prefetch,
    };
};
