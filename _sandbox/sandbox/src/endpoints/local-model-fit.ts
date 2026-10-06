import { readFile, stat } from "node:fs/promises";
import {
    LOCAL_MODEL_KV_BYTES_PER_TOKEN,
    LOCAL_MODEL_WINDOW_DEFAULT,
    LOCAL_MODEL_WINDOWS,
    LOCAL_MODELS,
    type LocalModelChoice,
    type LocalModelDevice,
    type LocalModelFitResponse,
    type LocalModelGpu,
    type LocalModelPrefetch,
} from "@intentic/sandbox-contract";
import { forkedExec } from "@intentic/base/git";
import { opt } from "../opt.js";
import { localModelWeightsPath } from "./local-model.js";
import { llamaServerProcesses, readLoadReport } from "./local-model-load.js";

// What this machine can actually run, measured rather than assumed, as two figures that answer two questions:
// - full speed: does the whole model fit in the FREE memory of one device (the GPU when one reached this sandbox, else
//   the host)? This sizes the connect view's offers. A model split between a card and the CPU runs at the CPU's pace,
//   so a sum of the two would recommend a model that crawls: 8 GB of VRAM plus 32 GB of RAM once offered a 27B.
// - fits at all: does it fit in everything, GPU and host together? This alone gates a start (localmodel.handler's
//   admission check), since llama.cpp will split a model that fits nowhere whole rather than refuse it.
// Both come from here, so a view cannot offer a model the daemon will then refuse (full speed implies fits at all), nor
// quote a figure the refusal was not decided on.

// Deliberately conservative; the real per-device authority is llama.cpp's own fitter. The runtime floor is what the
// server costs before a single token: weights mapped, context buffers, the graph. Binary, like every other figure this
// feature quotes, since all of them are compared against a machine's RAM.
const MODEL_RUNTIME_BYTES = 1024 ** 3;
// A model may have most of the box, never all of it: the daemon, the harness and whatever the agent runs live here too.
const MODEL_CAPACITY_SHARE = 0.8;
// What `--fit` leaves free on each device before it places a layer (llama.cpp's `fit_params_target`, 1 GiB at b11146);
// a model sized into that margin is one the fitter spills to the CPU.
const GPU_FIT_MARGIN_BYTES = 1024 ** 3;

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

// What is free right now: the kernel's MemAvailable, and inside a cap the cap's own headroom, whichever is smaller. A
// cgroup's usage counts page cache the kernel drops before it refuses an allocation, so its inactive half is not use.
// Undefined where neither can be read, which is "unmeasured", never "none free".
export const freeMemoryFrom = (readings: {
    readonly cgroupMax: string;
    readonly cgroupCurrent: string;
    readonly cgroupStat: string;
    readonly meminfo: string;
}): number | undefined => {
    const kb = /^MemAvailable:\s+(\d+) kB$/m.exec(readings.meminfo)?.[1];
    const available = kb === undefined ? undefined : Number(kb) * 1024;
    const digits = (text: string): number | undefined => (/^\d+$/.test(text.trim()) ? Number(text.trim()) : undefined);
    const cap = digits(readings.cgroupMax);
    const current = digits(readings.cgroupCurrent);
    const inactive = Number(/^inactive_file (\d+)$/m.exec(readings.cgroupStat)?.[1] ?? 0);
    const headroom = cap === undefined || current === undefined ? undefined : Math.max(0, cap - Math.max(0, current - inactive));
    const readable = [available, headroom].filter((bytes) => bytes !== undefined);
    return readable.length === 0 ? undefined : Math.min(...readable);
};

export const hostMemory = async (): Promise<{ bytes: number; capped: boolean; freeBytes: number | undefined }> => {
    const [cgroupMax, cgroupCurrent, cgroupStat, meminfo] = await Promise.all([
        readFile("/sys/fs/cgroup/memory.max", "utf8").catch(() => "max"),
        // allow(silent-catch): Absent or unreadable kernel counters contribute no cgroup reading; meminfo is the fallback.
        readFile("/sys/fs/cgroup/memory.current", "utf8").catch(() => ""),
        // allow(silent-catch): Absent or unreadable kernel counters contribute no cgroup reading; meminfo is the fallback.
        readFile("/sys/fs/cgroup/memory.stat", "utf8").catch(() => ""),
        // allow(silent-catch): Unavailable procfs leaves free memory unknown rather than inventing a reading.
        readFile("/proc/meminfo", "utf8").catch(() => ""),
    ]);
    return { ...memoryFrom(cgroupMax, meminfo), freeBytes: freeMemoryFrom({ cgroupMax, cgroupCurrent, cgroupStat, meminfo }) };
};

export interface GpuReading {
    // The card with the most memory, and separately the one with the most free: one device holds a model at full
    // speed, and a second card's memory is not the first one's.
    readonly totalBytes: number;
    readonly freeBytes: number;
}

// nvidia-smi's `memory.total,memory.free` as csv, one line per card, in MiB. A line that does not parse is skipped, so
// an unreadable answer reads as no GPU memory rather than a throw: that already means "size against the host alone".
export const gpuReadingFrom = (csv: string): GpuReading => {
    const cards = csv
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => line.split(",").map((field) => Number(field.trim())))
        .filter((fields) => fields.length === 2 && fields.every(Number.isFinite));
    const mib = 1024 * 1024;
    return {
        totalBytes: Math.max(0, ...cards.map(([total]) => total ?? 0)) * mib,
        freeBytes: Math.max(0, ...cards.map(([, free]) => free ?? 0)) * mib,
    };
};

// Zero until the GPU is actually passed through: before the grant there is no device to ask, so any figure here would
// be a guess dressed as a measurement.
export const gpuMemory = async (): Promise<GpuReading> => {
    if (localModelGpu() !== "granted") {
        return { totalBytes: 0, freeBytes: 0 };
    }
    const result = await forkedExec("nvidia-smi", ["--query-gpu=memory.total,memory.free", "--format=csv,noheader,nounits"]).catch(() => undefined);
    return gpuReadingFrom(result?.stdout ?? "");
};

// What this sandbox's own llama-servers hold, host and GPU: a start stops every other one and restarts its own
// (localmodel.handler), so all of it is free to the model being sized. Without it the model already serving would read
// as not fitting on the machine it is running on.
const heldByLocalModels = async (): Promise<{ hostBytes: number; gpuBytes: number }> => {
    const servers = await llamaServerProcesses();
    const reports = await Promise.all(servers.map(async (server) => readLoadReport(server.port)));
    return {
        hostBytes: servers.reduce((sum, server) => sum + server.residentBytes, 0),
        gpuBytes: reports.reduce((sum, report) => sum + (report?.gpuBytes ?? 0), 0),
    };
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
    readonly gpuFreeBytes: number;
    // Fits at all: what a start is admitted against, the host and the GPU together, by total rather than free, since a
    // start frees what the model it replaces holds. Zero means "unmeasurable", which every caller reads as "admit
    // anything" rather than "admit nothing" — refusing on a reading we could not take would be worse than letting
    // llama.cpp decide.
    readonly budgetBytes: number;
    // The host's free memory, read beside the totals; undefined when unmeasurable.
    readonly hostFreeBytes: number | undefined;
}

export const localModelBudget = async (): Promise<LocalModelBudget> => {
    const [host, gpu] = await Promise.all([hostMemory(), gpuMemory()]);
    return {
        memoryBytes: host.bytes,
        memoryCapped: host.capped,
        gpu: localModelGpu(),
        gpuMemoryBytes: gpu.totalBytes,
        gpuFreeBytes: gpu.freeBytes,
        budgetBytes: Math.round((host.bytes + gpu.totalBytes) * MODEL_CAPACITY_SHARE),
        hostFreeBytes: host.freeBytes,
    };
};

// An unmeasurable budget admits everything: see LocalModelBudget.budgetBytes.
export const fitsBudget = (budgetBytes: number, weightsBytes: number, window: number): boolean =>
    budgetBytes <= 0 || estimatedModelMemory(weightsBytes, window) <= budgetBytes;

export interface FullSpeedBudget {
    readonly device: LocalModelDevice;
    readonly bytes: number;
}

// The one device a model runs at full speed on, and what it may take there. The GPU wherever one was granted and
// answered, less the margin `--fit` keeps; the host otherwise, at the same share of its free memory the box keeps for
// everything else. Undefined when the host's free memory could not be read: an offer sized against nothing would be
// the old sum under another name.
export const fullSpeedFrom = (reading: {
    readonly gpu: LocalModelGpu;
    readonly gpuMemoryBytes: number;
    readonly gpuFreeBytes: number;
    readonly hostFreeBytes: number | undefined;
    readonly held: { readonly hostBytes: number; readonly gpuBytes: number };
}): FullSpeedBudget | undefined => {
    if (reading.gpu === "granted" && reading.gpuMemoryBytes > 0) {
        const free = Math.min(reading.gpuMemoryBytes, reading.gpuFreeBytes + reading.held.gpuBytes);
        return { device: "gpu", bytes: Math.max(0, free - GPU_FIT_MARGIN_BYTES) };
    }
    return reading.hostFreeBytes === undefined
        ? undefined
        : { device: "host", bytes: Math.round((reading.hostFreeBytes + reading.held.hostBytes) * MODEL_CAPACITY_SHARE) };
};

// Measured, never assumed: zero free is a real answer that runs nothing at full speed.
export const runsAtFullSpeed = (fullSpeed: FullSpeedBudget, weightsBytes: number, window: number): boolean =>
    estimatedModelMemory(weightsBytes, window) <= fullSpeed.bytes;

const held = async (root: string, choice: LocalModelChoice): Promise<boolean> =>
    stat(localModelWeightsPath(root, { file: choice.id.split("/").at(-1) ?? "" })).then(
        () => true,
        () => false,
    );

const WINDOWS = LOCAL_MODEL_WINDOWS.map(Number);
const DEFAULT_WINDOW = Number(LOCAL_MODEL_WINDOW_DEFAULT);

// Whether a rung is one to offer.
type Sizing = (weightsBytes: number, window: number) => boolean;

// The largest rung this model fits in, capped at the default: a bigger window than one full turn needs buys nothing a
// first-time reader asked for, and costs a gigabyte a rung. Undefined when even the smallest will not fit.
const windowFor = (sized: Sizing, choice: LocalModelChoice): number | undefined =>
    [...WINDOWS]
        .filter((tokens) => tokens <= DEFAULT_WINDOW)
        .sort((left, right) => right - left)
        .find((tokens) => sized(choice.weightsBytes, tokens));

const offer = (sized: Sizing, choice: LocalModelChoice | undefined): { model: string; context: string } | undefined => {
    if (choice === undefined) {
        return undefined;
    }
    const window = windowFor(sized, choice);
    return window === undefined ? undefined : { model: choice.id, context: String(window) };
};

// Heaviest weights that still run at full speed: the list is smallest-first, so the last survivor is the best this
// machine runs.
const bestChoice = (sized: Sizing): LocalModelChoice | undefined =>
    LOCAL_MODELS.findLast((choice) => choice.tier === "work" && windowFor(sized, choice) !== undefined);

const instantChoice = (): LocalModelChoice | undefined => LOCAL_MODELS.find((choice) => choice.tier === "instant");

export interface LocalModelOffers {
    readonly instant?: { readonly model: string; readonly context: string };
    readonly best?: { readonly model: string; readonly context: string };
}

// The connect view's two offers from the two readings. An offer runs at full speed and also fits at all: the first
// nearly always implies the second and is not trusted to, since an offer the admission check would refuse is the one
// failure this module exists to make impossible. Where free memory could not be read (fullSpeed undefined) the offers
// fall back to fitting at all, which is what they were sized on before.
export const localModelOffers = (budgetBytes: number, fullSpeed: FullSpeedBudget | undefined): LocalModelOffers => {
    const sized: Sizing = (weightsBytes, window) =>
        fitsBudget(budgetBytes, weightsBytes, window) && (fullSpeed === undefined || runsAtFullSpeed(fullSpeed, weightsBytes, window));
    return { ...opt("instant", offer(sized, instantChoice())), ...opt("best", offer(sized, bestChoice(sized))) };
};

export const localModelFit = async (root: string, prefetch: LocalModelPrefetch): Promise<LocalModelFitResponse> => {
    const [budget, ownServers, serverMissing] = await Promise.all([localModelBudget(), heldByLocalModels(), llamaServerMissing()]);
    const fullSpeed = fullSpeedFrom({ ...budget, held: ownServers });
    const { instant, best } = localModelOffers(budget.budgetBytes, fullSpeed);
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
                ...opt("fullSpeed", fullSpeed === undefined ? undefined : runsAtFullSpeed(fullSpeed, choice.weightsBytes, tokens)),
            })),
        })),
    );
    return {
        memoryBytes: budget.memoryBytes,
        memoryCapped: budget.memoryCapped,
        gpu: budget.gpu,
        gpuMemoryBytes: budget.gpuMemoryBytes,
        gpuFreeBytes: budget.gpuFreeBytes,
        budgetBytes: budget.budgetBytes,
        ...opt("fullSpeedBytes", fullSpeed?.bytes),
        ...opt("fullSpeedDevice", fullSpeed?.device),
        serverReady: !serverMissing,
        options,
        ...(instant === undefined ? {} : { instant }),
        ...(best === undefined ? {} : { best }),
        prefetch,
    };
};
