import { execFile } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { downloadFile } from "@huggingface/hub";
import { errorMessage } from "@intentic/base/errors";
import type { Capability, CapabilityStatus, LocalModelConfig } from "@intentic/sandbox-contract";
import { packFragment } from "../../environment/packs.js";
import {
    fitsAgentTurn,
    localModelLabel,
    localModelPort,
    localModelSource,
    localModelWindow,
    localModelWindowLabel,
    type LocalModelSource,
} from "../../endpoints/local-model.js";
import { statePath } from "../../workspace/layout/state-paths.js";
import type { CapabilityCtx, CapabilityHandler } from "../capability.js";

// A model the sandbox runs itself: the user picks weights, this downloads and serves them with the bundled
// llama-server; the entry then IS an endpoint. Apply returns before the download finishes; a background job re-syncs
// the translator once the server actually serves.

const exec = promisify(execFile);

// Tmux session for one entry's llama-server (`panel-model-<id>`); classified as a background process so it sits beside
// extension gateways and dockerd, not as a visible panel tab.
export const LOCAL_MODEL_PREFIX = "model-";
export const localModelPanelKey = (id: string): string => `${LOCAL_MODEL_PREFIX}${id}`;

// CUDA build of llama-server (overlay-only) plus the directive, spelled like docker's for the allowlist.
const GPU_DIRECTIVE = `# local model capability, gpu option: the host's NVIDIA GPUs for llama-server.
# intentic:runtime --gpus=all`;

// The ask is the config; what became of it is SANDBOX_GPU (all/unsupported/absent), read per call.
const gpuAsked = (config: unknown): boolean => (config as LocalModelConfig | undefined)?.gpu === "on";
const gpuState = (): string | undefined => process.env["SANDBOX_GPU"];

// A bare dev run has no llama-server; /opt/sandbox is the in-image sentinel between "rebuild adds it" and "a real
// sandbox has it".
const serverMissing = async (): Promise<boolean> =>
    exec("llama-server", ["--version"]).then(
        () => false,
        (error) => (error as NodeJS.ErrnoException).code === "ENOENT",
    );

// Cached by file name, shared across entries on purpose: two cards naming the same model download it once.
const weightsPath = (ctx: CapabilityCtx, source: LocalModelSource): string =>
    statePath(ctx.workspace.root, ".intentic/local/cache/", "models", source.file);

// Deterministic, not a fresh name per attempt: this file is the resume point the next attempt looks for.
const stagedPath = (destination: string): string => `${destination}.part`;

const fileSize = async (path: string): Promise<number> =>
    stat(path).then(
        (info) => info.size,
        () => 0,
    );

const weightsReady = async (path: string): Promise<boolean> =>
    stat(path).then(
        () => true,
        () => false,
    );

// downloads/fetches key by destination path (shared); jobs/failures key by entry id, cleared on each fresh job.
const downloads = new Map<string, { received: number; total: number }>();
const fetches = new Map<string, { readonly promise: Promise<void>; readonly abort: AbortController }>();
const jobs = new Map<string, { readonly promise: Promise<void>; readonly abort: AbortController }>();
const failures = new Map<string, string>();
let selectedModelId: string | undefined;
let serverSwitch = Promise.resolve();

const gb = (bytes: number): string => `${(bytes / 1e9).toFixed(1)} GB`;

// Both sources answer a range (hub's blob slices itself; a custom URL sends a Range header); a server that ignores it
// answers 200 with the whole file, and `appending: false` says truncate rather than double-write.
const openStream = async (
    source: LocalModelSource,
    from: number,
    signal: AbortSignal,
): Promise<{ body: ReadableStream<Uint8Array>; total: number; appending: boolean }> => {
    if (source.repo !== undefined && source.path !== undefined) {
        const blob = await downloadFile({
            repo: source.repo,
            path: source.path,
            fetch: (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => fetch(input, { ...init, signal }),
        });
        if (blob === null) {
            throw new Error(`${source.repo} has no ${source.path}, check the model path on the card.`);
        }
        const resuming = from > 0 && from < blob.size;
        return {
            body: (resuming ? blob.slice(from) : blob).stream() as unknown as ReadableStream<Uint8Array>,
            total: blob.size,
            appending: resuming,
        };
    }
    const response = await fetch(source.url ?? "", { signal, ...(from > 0 ? { headers: { range: `bytes=${from}-` } } : {}) });
    if (!response.ok || response.body === null) {
        throw new Error(`the model URL answered ${response.status}, check it serves a GGUF file.`);
    }
    // A 206 with no length leaves total 0, never `from`: equal-to-disk would wrongly mark a half file complete.
    const length = Number(response.headers.get("content-length") ?? 0);
    const appending = response.status === 206;
    return { body: response.body, total: length > 0 ? (appending ? from + length : length) : 0, appending };
};

// Streamed to disk, renamed into place whole, so readiness is a stat. A full-size part finished but didn't rename; a
// larger one isn't this file and is discarded; anything else resumes.
const downloadWeights = async (source: LocalModelSource, destination: string, signal: AbortSignal): Promise<void> => {
    await mkdir(dirname(destination), { recursive: true });
    const staged = stagedPath(destination);
    // Read once, shared by the range request and the arithmetic below; one download per destination stays safe.
    const have = await fileSize(staged);
    const stream = await openStream(source, have, signal);
    if (stream.total > 0 && have > stream.total) {
        await rm(staged, { force: true });
        throw new Error(`the part file for ${source.file} is larger than the model, discarded it; press Update to download again.`);
    }
    if (stream.total > 0 && have === stream.total) {
        await stream.body.cancel().catch(() => undefined);
        await rename(staged, destination);
        return;
    }
    const file = createWriteStream(staged, stream.appending ? { flags: "a" } : {});
    const reader = stream.body.getReader();
    let received = stream.appending ? have : 0;
    downloads.set(destination, { received, total: stream.total });
    try {
        for (;;) {
            const chunk = await reader.read();
            if (chunk.done) {
                break;
            }
            received += chunk.value.byteLength;
            downloads.set(destination, { received, total: stream.total });
            if (!file.write(chunk.value)) {
                await once(file, "drain");
            }
        }
        file.end();
        await once(file, "close");
        await rename(staged, destination);
    } catch (error) {
        file.destroy();
        throw error;
    } finally {
        downloads.delete(destination);
    }
};

// One download per destination, however many cards are waiting on it.
const ensureWeights = (source: LocalModelSource, destination: string): Promise<void> => {
    const running = fetches.get(destination);
    if (running !== undefined) {
        return running.promise;
    }
    const abort = new AbortController();
    const promise = downloadWeights(source, destination, abort.signal).finally(() => {
        fetches.delete(destination);
    });
    fetches.set(destination, { promise, abort });
    return promise;
};

// serverCommand's flags, each pinned against a bug:
//   --ctx-size the card's chosen window, never native (dwarfs the weights) or a flat number (may not fit a turn)
//   --parallel 1 llama.cpp defaults to 4 slots, each reserving the full window again
//   --cache-type q8_0 halves the reservation at negligible quality cost
//   --jinja curated models carry their own chat/tool template in the GGUF
export const serverCommand = (path: string, port: number, window: number): string => {
    const gpuFit = gpuState() === "all" ? " --gpu-layers auto --fit on" : "";
    return `llama-server -m '${path}' --host 127.0.0.1 --port ${port} --ctx-size ${window} --parallel 1 --cache-type-k q8_0 --cache-type-v q8_0 --jinja${gpuFit}`;
};

// Deliberately conservative admission check; the real per-device authority is llama.cpp's own fitter.
const KV_BYTES_PER_32K = 2_000_000_000;
const MODEL_RUNTIME_BYTES = 1_000_000_000;
const MODEL_CAPACITY_SHARE = 0.8;

export const estimatedModelMemory = (weightsBytes: number, window: number): number =>
    weightsBytes + (window / 32_768) * KV_BYTES_PER_32K + MODEL_RUNTIME_BYTES;

const hostMemoryCapacity = async (): Promise<number> => {
    const cgroup = (await readFile("/sys/fs/cgroup/memory.max", "utf8").catch(() => "max")).trim();
    if (/^\d+$/.test(cgroup)) {
        return Number(cgroup);
    }
    const meminfo = await readFile("/proc/meminfo", "utf8");
    return Number(/^MemTotal:\s+(\d+) kB$/m.exec(meminfo)?.[1] ?? 0) * 1024;
};

const gpuMemoryCapacity = async (): Promise<number> => {
    if (gpuState() !== "all") {
        return 0;
    }
    const result = await exec("nvidia-smi", ["--query-gpu=memory.total", "--format=csv,noheader,nounits"]).catch(() => undefined);
    // Unreadable answer reads as 0 GPU memory, never a throw: that already means "size against host memory alone".
    const devices = (result?.stdout ?? "")
        .split("\n")
        .map((line) => Number(line.trim()))
        .filter(Number.isFinite);
    return Math.max(0, ...devices) * 1024 * 1024;
};

const admitModel = async (path: string, window: number): Promise<void> => {
    const [weightsBytes, hostBytes, gpuBytes] = await Promise.all([fileSize(path), hostMemoryCapacity(), gpuMemoryCapacity()]);
    const estimated = estimatedModelMemory(weightsBytes, window);
    const budget = (hostBytes + gpuBytes) * MODEL_CAPACITY_SHARE;
    if (budget > 0 && estimated > budget) {
        throw new Error(
            `model start refused before it could exhaust the sandbox: ${gb(estimated)} estimated for weights + ${localModelWindowLabel(window)} KV cache, but the safe GPU/container budget is ${gb(budget)}. Reduce the conversation window or choose smaller weights.`,
        );
    }
};

const serializeServerSwitch = async (work: () => Promise<void>): Promise<void> => {
    const previous = serverSwitch;
    let release!: () => void;
    serverSwitch = new Promise<void>((resolve) => {
        release = resolve;
    });
    await previous;
    try {
        await work();
    } finally {
        release();
    }
};

const stopOtherServers = async (ctx: CapabilityCtx, id: string): Promise<void> => {
    const others = (await ctx.capabilities.list()).filter((capability) => capability.kind === "localmodel" && capability.id !== id);
    for (const other of others) {
        stopWatching(other.id);
        // oxlint-disable-next-line eslint/no-await-in-loop -- one GPU owner at a time is the invariant this loop establishes
        await ctx.panels.stop(localModelPanelKey(other.id));
        // A stopped endpoint must not stay routable just because its last catalog survived on disk.
        // oxlint-disable-next-line eslint/no-await-in-loop -- paired with the panel stop above
        await ctx.endpointModels.forget(other.id);
    }
};

// llama-server's own readiness: /health answers 503 while loading, 200 once serving. Short timeout, since status runs
// on the card's poll clock.
const serverHealthy = async (port: number): Promise<boolean> =>
    fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) }).then(
        (response) => response.ok,
        () => false,
    );

const startServer = async (ctx: CapabilityCtx, id: string, path: string, window: number): Promise<void> => {
    const key = localModelPanelKey(id);
    // Stop-then-start, not a no-op: the panel can't say which weights or window the running process has.
    await ctx.panels.stop(key);
    await ctx.panels.start(key, { command: serverCommand(path, localModelPort(id), window), cwd: ctx.workspace.root });
};

// Polls /health rather than awaiting the process: "up" and "loaded" differ by minutes, and only loaded lets the catalog
// publish. Ends on a dead panel too, or a 20-minute ceiling; false is a real answer, not a throw.
const SERVING_CEILING_MS = 20 * 60_000;
const SERVING_POLL_MS = 2_000;

const waitUntilServing = async (ctx: CapabilityCtx, id: string, signal: AbortSignal): Promise<boolean> => {
    const deadline = Date.now() + SERVING_CEILING_MS;
    const port = localModelPort(id);
    while (!signal.aborted && Date.now() < deadline) {
        if (await serverHealthy(port)) {
            return true;
        }
        if (!ctx.panels.running(localModelPanelKey(id))) {
            return false;
        }
        await delay(SERVING_POLL_MS, undefined, { signal }).catch(() => undefined);
    }
    return false;
};

// Held outside `jobs` on purpose: folding it in would block a second Update on the whole load via `jobs.has`.
const servings = new Map<string, AbortController>();

const syncWhenServing = (ctx: CapabilityCtx, id: string): void => {
    servings.get(id)?.abort();
    const abort = new AbortController();
    servings.set(id, abort);
    void waitUntilServing(ctx, id, abort.signal)
        .then(async (serving) => {
            if (serving && !abort.signal.aborted) {
                await ctx.syncEndpoints();
            }
        })
        .catch((error: unknown) => {
            ctx.logger.warn(`localmodel ${id}: ${errorMessage(error)}`);
        })
        .finally(() => {
            if (servings.get(id) === abort) {
                servings.delete(id);
            }
        });
};

// Stops the watcher for an entry going away; separate from the job's abort since the watcher outlives the job (runs
// until serving, not just spawning).
const stopWatching = (id: string): void => {
    servings.get(id)?.abort();
    servings.delete(id);
};

// Fetches, serves, then syncs the translator once actually serving: the route's sync ran too early to say so, and
// nothing else re-checks. Never throws; a second Update joins the job already in flight.
const startInBackground = (ctx: CapabilityCtx, id: string, source: LocalModelSource, destination: string, window: number): void => {
    // Most recently restored or updated entry owns the one model slot.
    selectedModelId = id;
    if (jobs.has(id)) {
        return;
    }
    failures.delete(id);
    const abort = new AbortController();
    const promise = (async () => {
        if (!(await weightsReady(destination))) {
            await ensureWeights(source, destination);
        }
        if (abort.signal.aborted) {
            return;
        }
        await serializeServerSwitch(async () => {
            // A newer selection while this download ran wins the GPU; the bytes stay cached regardless.
            if (selectedModelId !== id) {
                return;
            }
            await admitModel(destination, window);
            await stopOtherServers(ctx, id);
            await startServer(ctx, id, destination, window);
            syncWhenServing(ctx, id);
        });
    })()
        .catch((error: unknown) => {
            // An aborted job isn't a failure: the card that would show it is the one being removed.
            if (abort.signal.aborted) {
                return;
            }
            const message = errorMessage(error);
            failures.set(id, message);
            ctx.logger.warn(`localmodel ${id}: ${message}`);
        })
        .finally(() => {
            jobs.delete(id);
        });
    jobs.set(id, { promise, abort });
};

// Not an error: a small window is a deliberate trade, but silence would hide that every full turn then fails in
// context-budget.ts. Two lengths for two surfaces (a table cell vs the add's log line), not two different facts.
const windowNote = (window: number): string => (fitsAgentTurn(window) ? "" : ", quick jobs only");

const windowAdvice = (window: number): string =>
    fitsAgentTurn(window)
        ? ""
        : " — enough for the one-shot helper jobs (titles, commit messages), not for a full agent turn, whose tools and instructions fill a window this size on their own. Raise it on the card to chat with this model.";

// Same GPU sentences as the docker card, minus the toolkit clause (no nested runtime here): pending, error, or silent
// once the flag rode.
const gpuStatus = (config: unknown): CapabilityStatus | undefined => {
    if (!gpuAsked(config)) {
        return undefined;
    }
    const state = gpuState();
    if (state === undefined) {
        return { state: "pending", detail: "GPU access: rebuild required" };
    }
    if (state === "unsupported") {
        return { state: "error", detail: "GPU access: this host's Docker has no nvidia runtime, install nvidia-container-toolkit on it" };
    }
    return undefined;
};

// Whether another entry is fed by the same weights file, keyed on the resolved path; decides if removing this one may
// stop the download.
const sharesWeights = async (ctx: CapabilityCtx, id: string, destination: string): Promise<boolean> =>
    (await ctx.capabilities.list()).some((capability: Capability) => {
        if (capability.kind !== "localmodel" || capability.id === id) {
            return false;
        }
        const other = localModelSource(capability.config);
        return other !== undefined && weightsPath(ctx, other) === destination;
    });

export const localModelHandler: CapabilityHandler = {
    // Nothing here is a credential: weights are public bytes, the server answers loopback unauthenticated.
    echo: (config) => {
        const model = config as LocalModelConfig;
        return {
            model: model.model,
            gpu: gpuAsked(config),
            ...(model.url !== undefined ? { url: model.url } : {}),
            context: model.context,
            ...(model.contextTokens !== undefined ? { contextTokens: model.contextTokens } : {}),
        };
    },
    // Engine pack composes to nothing on a standard image (already baked), the install itself on a core image. The GPU
    // directive is present whenever asked: baking it records the grant, flips the state to rebuild-required.
    fragment: async (config) => {
        const engine = await packFragment("llamacpp");
        if (!gpuAsked(config)) {
            return engine;
        }
        const cuda = await packFragment("llamacpp-cuda");
        return [engine, cuda, GPU_DIRECTIVE].filter((part) => part !== undefined).join("\n");
    },
    async *apply(ctx, id, config) {
        const model = config as LocalModelConfig;
        const source = localModelSource(model);
        if (source === undefined) {
            throw new Error(
                model.model === "custom"
                    ? "A custom model needs its GGUF URL, fill in the link field on the card."
                    : `"${model.model}" doesn't name a Hugging Face file (owner/repo/file.gguf), pick a model from the list or use a custom URL.`,
            );
        }
        if (await serverMissing()) {
            yield existsSync("/opt/sandbox")
                ? {
                      kind: "log" as const,
                      message: `Stored ${id}, this image doesn't carry llama-server yet. Rebuild the sandbox from the Environment card; the model downloads and starts with the rebuild.`,
                  }
                : { kind: "log" as const, message: `Stored ${id}, no llama-server in this dev run; the model serves in a real sandbox container.` };
            return;
        }
        if (gpuAsked(model) && gpuState() === undefined) {
            yield { kind: "log", message: "GPU access needs a one-time rebuild (Environment card), serving on CPU until then." };
        }
        const path = weightsPath(ctx, source);
        const held = await weightsReady(path);
        const window = localModelWindow(model);
        startInBackground(ctx, id, source, path, window);
        // Named here, while fresh: the memory cost, the turn-fits check, and the silent "custom" fallback.
        yield { kind: "log", message: `Conversation window: ${localModelWindowLabel(window)} tokens${windowAdvice(window)}` };
        // Last line from apply; everything after this is `status`, the surface that survives a refresh.
        yield {
            kind: "log",
            message: held
                ? `Starting llama-server for ${localModelLabel(model)}; the connection's row says when it is serving, and its output is in the background processes list.`
                : `Downloading ${source.file} in the background. The connection's row shows how far along it is and starts serving when it lands, so you can leave this page.`,
        };
    },
    status: async (ctx, id, config) => {
        const model = config as LocalModelConfig;
        const source = localModelSource(model);
        if (source === undefined) {
            return { state: "error", detail: "no model named, edit the card" };
        }
        const path = weightsPath(ctx, source);
        // Progress first, by path: the download is the long pole, and the reason this card polls at all.
        const inFlight = downloads.get(path);
        if (inFlight !== undefined) {
            return { state: "pending", detail: inFlight.total > 0 ? `downloading ${gb(inFlight.received)} / ${gb(inFlight.total)}` : "downloading" };
        }
        // What the background job would have thrown, if the add were still listening.
        const failure = failures.get(id);
        if (failure !== undefined) {
            return { state: "error", detail: failure };
        }
        if (await serverMissing()) {
            return { state: "pending", detail: "rebuild required" };
        }
        if (await serverHealthy(localModelPort(id))) {
            // Window joins the model name: two rows on the same weights can be a working agent or a helper-only rung.
            const window = localModelWindow(model);
            return (
                gpuStatus(config) ?? {
                    state: "active",
                    detail: `${localModelLabel(model)} · ${localModelWindowLabel(window)} window${windowNote(window)}`,
                }
            );
        }
        const held = await weightsReady(path);
        // No progress yet means the connection hasn't opened; `held` says whether this is loading or still fetching.
        if (jobs.has(id) || ctx.panels.running(localModelPanelKey(id))) {
            return { state: "pending", detail: held ? "loading the model" : "fetching the model, gigabytes, leave it running" };
        }
        if (selectedModelId !== undefined && selectedModelId !== id) {
            return { state: "pending", detail: "standby; press Update to make this the active local model" };
        }
        if (!held) {
            return { state: "pending", detail: "weights not downloaded, press Update to fetch them" };
        }
        return { state: "error", detail: "llama-server not running, press Update to start it" };
    },
    // Weights and any part file stay, janitor's to clean; the catalog entry goes, so a re-added name doesn't inherit a
    // stale list. The job always stops; the download only if no other entry shares its file.
    remove: async (ctx, id, config) => {
        if (selectedModelId === id) {
            selectedModelId = undefined;
        }
        jobs.get(id)?.abort.abort();
        stopWatching(id);
        failures.delete(id);
        await ctx.panels.stop(localModelPanelKey(id));
        await ctx.endpointModels.forget(id);
        const source = localModelSource(config as LocalModelConfig);
        if (source === undefined) {
            return;
        }
        const path = weightsPath(ctx, source);
        if (!(await sharesWeights(ctx, id, path))) {
            fetches.get(path)?.abort.abort();
        }
    },
    // id keys the panel, port and catalog; weights key by file name and carry over untouched. Stops the old server and
    // catalog; re-apply starts the new.
    rename: {
        carry: async (ctx, from) => {
            jobs.get(from)?.abort.abort();
            stopWatching(from);
            failures.delete(from);
            await ctx.panels.stop(localModelPanelKey(from));
            await ctx.endpointModels.forget(from);
        },
    },
};

// Boot restore: the server dies with the container while manifest and weights survive on /work; every entry restarts,
// resuming an unfinished download from its last byte. Best-effort: failures surface on the card, never the boot path.
export const startLocalModelsIfEnabled = async (ctx: CapabilityCtx): Promise<void> => {
    const entries = (await ctx.capabilities.list()).flatMap((capability) => (capability.kind === "localmodel" ? [capability] : []));
    if (entries.length === 0 || (await serverMissing())) {
        return;
    }
    for (const entry of entries) {
        const source = localModelSource(entry.config);
        if (source === undefined || ctx.panels.running(localModelPanelKey(entry.id))) {
            continue;
        }
        startInBackground(ctx, entry.id, source, weightsPath(ctx, source), localModelWindow(entry.config));
    }
};
