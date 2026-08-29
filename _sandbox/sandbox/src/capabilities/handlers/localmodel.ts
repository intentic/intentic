import { execFile } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { downloadFile } from "@huggingface/hub";
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
import { statePath } from "../../workspace/state-paths.js";
import type { CapabilityCtx, CapabilityHandler } from "../capability.js";

/* A MODEL THE SANDBOX RUNS ITSELF. The user picks weights on the card; this handler downloads them into the
 * workspace cache (the whisper precedent: re-downloadable by content, so under `.intentic/local/cache/`, which
 * exports skip and the janitor may clear) and serves them with the image's bundled llama-server on the entry's
 * derived loopback port (endpoints/local-model.ts). From there the entry IS an endpoint: the translator routes
 * turns at it, the picker lists its model, quick-model pins hold, all through the same seams a user-added
 * endpoint rides, and none of that code knows this kind exists.
 *
 * ONE OF THOSE SEAMS HAD TO LEARN A NEW MOMENT, and it is the only place this kind is not simply an endpoint.
 * The translator's routing table is synced by the capability route, from the endpoint's live catalog, at
 * add/update/rename/remove. For a user-added endpoint that IS the truth: the server it names is already
 * running. For this kind the add happens minutes before the entry can serve anything, so that sync writes an
 * empty model list and the entry then routes nothing, forever. So the background job re-syncs when the server
 * actually begins serving (syncWhenServing), and that is what makes a fresh add drivable at all.
 *
 * THE ADD DOES NOT WAIT FOR THE WEIGHTS, and this is the one thing about this kind that could not be borrowed
 * from the handlers around it. Every other apply is seconds of work with a terminal to watch; this one is tens
 * of gigabytes over somebody's home connection, and an apply that streamed to the end of it held the add form's
 * spinner for forty minutes, said nothing while it did (a stream of log frames has no surface on that form: the
 * progress surface there is a tmux pane, and an in-process download has no pane), and threw the whole download
 * away if the reader closed the tab, because the manifest entry is not written until apply returns. So apply
 * STARTS the work and returns: the entry lands immediately, and the card's own status is the progress surface,
 * on the poll clock the connections list already runs for anything pending. Refreshing the page, or coming back
 * to it tomorrow, reads the same live answer, because the progress lives in the daemon rather than in a stream
 * only one browser tab was holding.
 *
 * THE ADD IS SOFT EVERYWHERE THE MACHINE ISN'T READY YET, the endpoint/docker precedent: a core image without
 * the llamacpp pack stores the entry and asks for the rebuild; a GPU ask on a container that predates its
 * directive serves on CPU until the rebuild lands. Refusing any of those would throw away a configuration the
 * user just chose to punish them for the order they did things in. The one hard refusal is a card that cannot
 * name which bytes to fetch (localModelSource undefined): storing it would gesture at a download nothing can
 * perform.
 *
 * GPU IS THE DOCKER CARD'S OPTION WITH ONE LAYER FEWER. The same allowlisted `--gpus=all` directive asks the
 * runner for the devices and driver libraries, and the same SANDBOX_GPU stamp reports what became of the ask,
 * but llama-server runs directly in this container, so there is no nested engine to register a runtime with,
 * no toolkit, no daemon.json merge. The directive plus a CUDA build of the binary is the whole grant. */

const exec = promisify(execFile);

// The tmux session one entry's llama-server runs in (`panel-model-<id>`), classified as a background process
// (kind "process") by the terminals list so it sits with extension gateways and dockerd rather than as a
// visible panel tab. Its output is still attachable when the card says something is wrong.
export const LOCAL_MODEL_PREFIX = "model-";
export const localModelPanelKey = (id: string): string => `${LOCAL_MODEL_PREFIX}${id}`;

// The GPU half of the fragment (config.gpu === "on"): the CUDA build of llama-server (overlay-only, hundreds of
// MB of CUDA runtime, which is why it is never baked) plus the directive that asks the runner for the devices.
// The directive line is the docker capability's own spelling, so the executors' allowlist covers it unchanged.
const GPU_DIRECTIVE = `# local model capability, gpu option: the host's NVIDIA GPUs for llama-server.
# intentic:runtime --gpus=all`;

// The ASK is the config; what became of it is the runner's SANDBOX_GPU stamp (all/unsupported/absent), read
// per call for the reason the docker handler gives.
const gpuAsked = (config: unknown): boolean => (config as LocalModelConfig | undefined)?.gpu === "on";
const gpuState = (): string | undefined => process.env["SANDBOX_GPU"];

// A bare dev run (`tsx watch` outside the image) has no llama-server and /opt/sandbox is the in-image sentinel,
// the docker handler's exact split between "rebuild adds it" and "a real sandbox has it".
const serverMissing = async (): Promise<boolean> =>
    exec("llama-server", ["--version"]).then(
        () => false,
        (error) => (error as NodeJS.ErrnoException).code === "ENOENT",
    );

// Weights are cached by FILE NAME, shared across entries on purpose: two cards naming the same model download
// it once, exactly as the whisper model is shared between voice and Discord.
const weightsPath = (ctx: CapabilityCtx, source: LocalModelSource): string =>
    statePath(ctx.workspace.root, ".intentic/local/cache/", "models", source.file);

// Where a download in progress accumulates. Deterministic, NOT a fresh name per attempt: this file is the
// resume point, so the name has to be the one the next attempt looks for.
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

/* THE WORK RUNNING BEHIND THE CARDS, and why there are this many maps rather than one (`servings`, the fourth,
 * is declared beside the watcher it belongs to).
 *
 * `downloads` is keyed by the DESTINATION PATH because that is what is actually shared: weights are cached by
 * file name, so two entries naming the same model must watch one download rather than start a second onto the
 * same bytes, and both their cards should show its progress. `fetches` holds that one download, with the handle
 * to stop it. `jobs` is keyed by the ENTRY ID, because download-then-serve is per entry: the second card wants
 * its own llama-server on its own port once the shared file lands.
 *
 * `failures` exists because a background job has no stream to throw down. What would have been an error frame
 * on the add is recorded here instead and read back by `status`, which is the only place the reader is looking.
 * Cleared whenever a fresh job for that entry starts, so Update genuinely retries rather than re-reading the
 * last complaint. All of it is module state and all of it is derived: a daemon restart clears it, and the boot
 * restore below re-reads the disk and picks the download back up. */
const downloads = new Map<string, { received: number; total: number }>();
const fetches = new Map<string, { readonly promise: Promise<void>; readonly abort: AbortController }>();
const jobs = new Map<string, { readonly promise: Promise<void>; readonly abort: AbortController }>();
const failures = new Map<string, string>();
let selectedModelId: string | undefined;
let serverSwitch = Promise.resolve();

const gb = (bytes: number): string => `${(bytes / 1e9).toFixed(1)} GB`;

/* WHERE THE NEXT BYTE COMES FROM, asked with what is already on disk. Both sources answer a range: HF through
 * the hub blob's own slice (a WebBlob re-fetches with a Range header, a XetBlob reconstructs from that offset),
 * a custom URL through a plain Range request. A server that ignores the ask answers 200 with the whole file,
 * and `appending: false` is how the caller is told to truncate rather than write the file twice.
 *
 * The abort signal is threaded into hub's fetch rather than only the plain one, because removing a card
 * mid-download has to actually stop the bytes, and for the HF path the only fetch that exists is hub's. */
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
    // A server that answers 206 without a length leaves the total UNKNOWN, which is zero here, never `from`:
    // a total that happened to equal what is already on disk would call a half-finished file complete and
    // rename it into place for llama-server to choke on.
    const length = Number(response.headers.get("content-length") ?? 0);
    const appending = response.status === 206;
    return { body: response.body, total: length > 0 ? (appending ? from + length : length) : 0, appending };
};

/* ONE ENTRY'S WEIGHTS, RESUMED. Streamed straight to disk beside their final name and renamed into place whole,
 * the transcribe.ts pattern and for its reason: readiness is a stat, so a file growing in place reads as
 * "ready" the moment it exists.
 *
 * A part file that is already the full size is a download that finished into a rename that didn't; one LARGER
 * than the file it claims to be is not this file at all (the repo moved the weights under the same name), and
 * the only honest thing to do with it is throw it away. Everything in between is a resume. A failure mid-flight
 * KEEPS the part: that is the entire point of the deterministic name, and the next attempt continues from it. */
const downloadWeights = async (source: LocalModelSource, destination: string, signal: AbortSignal): Promise<void> => {
    await mkdir(dirname(destination), { recursive: true });
    const staged = stagedPath(destination);
    // Read once and hand the same number to both the range request and the arithmetic below: one download per
    // destination (ensureWeights) is what makes that safe, and re-stating would be a second opinion.
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

// The shared half of the job: one download per destination, however many cards are waiting on it.
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

/* THE CONTEXT WINDOW IS THE OWNER'S CHOICE, BOUNDED, AND NEVER THE MODEL'S NATIVE ONE. Two bugs are locked out
 * here and they pull in opposite directions, which is why neither a flat number nor an open one is right.
 *
 * THE FIRST was --ctx-size 0, "read the model's native context length from the GGUF", which sounds generous and
 * made every number on the card a lie. A modern instruct model advertises 128K-256K native, and the KV cache
 * for a window that wide dwarfs the weights it serves: measured off the GGUF metadata of the models this card
 * curates, a 3B at its native 131072 wants 14.0 GB of f16 KV on top of 1.9 GB of weights (card label: "~4 GB"),
 * and a 30B at 262144 wants 24.0 GB on top of 17.3 GB (card label: "~24 GB"). The honest outcomes were
 * "allocation fails and the model never serves" and "it serves after eating the machine", and which one you got
 * depended on hardware the card never asked about.
 *
 * THE SECOND was the fix for the first: a flat 32768 for every entry, chosen as the smallest window that holds
 * a real agent turn. It is not. The loop's own fixed cost, its instructions plus one schema per exposed tool,
 * times every capability the owner has connected, is tens of thousands of tokens before the user types anything,
 * and the first report was a 27B model whose opening message died on `36216 tokens exceeds 32768` after
 * seventeen gigabytes of download. A cap that cannot hold one turn does not make the labels true; it makes the
 * whole entry decorative.
 *
 * SO THE NUMBER IS ASKED FOR, on the card, in rungs, defaulting to the smallest one a full turn fits in
 * (contract: LOCAL_MODEL_WINDOW_DEFAULT holds that argument, the card holds what each rung costs in memory).
 * That the memory moves with the choice is the whole point: it is the one trade only the owner can make, they
 * are the one who knows what the machine has, and the card is what tells them the rate (~2 GB of quantized
 * cache per 32k). Still NOT per-model: the KV cost per token varies about 2x across the curated list, which one
 * rate absorbs, where a number on every catalog row is arithmetic somebody redoes by hand on every model added.
 *
 * q8_0 for both halves of the cache roughly halves what any rung costs, for a quality cost the local-model
 * community treats as free at 8 bits, and it is the pairing people actually run these weights with. It is not
 * optional and not on the card: it buys a doubling of the window at no visible cost, so the choice it would
 * offer is between a number and the same number twice. Flash attention is left at its own default (`auto`)
 * rather than forced on: upstream auto-enables it when the V cache is quantized and errors only if it was
 * explicitly disabled, so the default is the safe spelling and forcing it would take on the failure modes
 * (Grok, tensor split) that the auto path handles.
 *
 * ONE SLOT, AND THIS IS WHERE THREE QUARTERS OF THE MEMORY WENT. `--parallel` defaults to auto, and auto on
 * this image is FOUR server slots, each given the full --ctx-size: measured on a live entry, `/slots` reported
 * four slots of 32,768 against a card that had priced one. So the cache reservation was 131,072 tokens wide, 4x
 * what every label on this card claimed, and a conversation could use exactly one quarter of it, because a slot
 * is per in-flight request and this server has one caller. Nothing was gained for it. Pinned to 1, the flag on
 * the card and the bytes on the machine are the same number again, and the same memory buys four times the
 * conversation, which is the resource that was actually scarce. Concurrent turns on one entry queue instead of
 * batching, which is the right trade on hardware where four simultaneous decodes are each four times slower.
 *
 * The one thing this can refuse that --ctx-size 0 could not: q8_0 blocks are 32 wide, and upstream rejects a
 * quantized cache whose head dimension does not divide by that. Every model on the curated list is 128, so
 * this is reachable only through the custom-GGUF field, where it fails loudly at startup with that exact
 * sentence in the entry's panel rather than serving something wrong.
 *
 * --jinja because the modern instruct models the card curates carry their chat/tool template in the GGUF and
 * serve tool calls only through it. GPU layers stay on llama.cpp's auto fitter exactly when the GPU actually
 * rode (the stamp, not the ask), so an oversized model spills layers to host memory instead of blindly claiming
 * every layer and aborting the fit. */
export const serverCommand = (path: string, port: number, window: number): string => {
    const gpuFit = gpuState() === "all" ? " --gpu-layers auto --fit on" : "";
    return `llama-server -m '${path}' --host 127.0.0.1 --port ${port} --ctx-size ${window} --parallel 1 --cache-type-k q8_0 --cache-type-v q8_0 --jinja${gpuFit}`;
};

/* A CHEAP ADMISSION ESTIMATE, before llama.cpp commits the machine. The card already prices q8 KV at about
 * 2 GB per 32k; the GGUF's own byte size is the other large term, and one gigabyte covers graph/scratch/runtime
 * allocations. GPU and container memory are one effective pool here because auto-fit moves layers between
 * them. The 20% reserve belongs to the daemon, compiler, browser and the host page cache: a model that fits
 * only by consuming those is exactly the workload this gate exists to refuse.
 *
 * It is deliberately conservative rather than pretending to decode every architecture's GGUF metadata. The
 * upstream fitter remains the exact per-device authority; this gate catches the order-of-magnitude mistake
 * before it can push the whole WSL VM into swap. */
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
    /* AN UNREADABLE ANSWER IS "NO GPU MEMORY", never a throw. This runs inside the background download job, so
     * anything raised here is caught two frames up, written to the log as one line, and swallowed: the weights
     * finish arriving and the server is simply never started, on a card that goes on saying it is downloading.
     * A probe that cannot answer has no business being the reason a model does not serve, and the budget it
     * feeds already treats 0 as "size against host memory alone", which is the honest reading of not knowing. */
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
        // A stopped local endpoint must not remain routable merely because its last catalog survived on disk.
        // oxlint-disable-next-line eslint/no-await-in-loop -- paired with the panel stop above
        await ctx.endpointModels.forget(other.id);
    }
};

// llama-server's own readiness: /health answers 503 while the model loads, 200 once it serves. Short timeout:
// status runs on the card's poll clock.
const serverHealthy = async (port: number): Promise<boolean> =>
    fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) }).then(
        (response) => response.ok,
        () => false,
    );

const startServer = async (ctx: CapabilityCtx, id: string, path: string, window: number): Promise<void> => {
    const key = localModelPanelKey(id);
    // Stop-then-start rather than the docker no-op: an apply may be changing WHICH model this entry serves or
    // how much conversation it holds, and the panel cannot say which weights the running process loaded or what
    // it reserved for them.
    await ctx.panels.stop(key);
    await ctx.panels.start(key, { command: serverCommand(path, localModelPort(id), window), cwd: ctx.workspace.root });
};

/* THE MOMENT THE ENTRY BECOMES ROUTABLE, which is neither the moment it was added nor the moment the process
 * spawned: llama-server publishes nothing until the weights are mapped and the model is loaded, and the
 * catalog read that feeds the translator's routing table is exactly that publication (endpoint-catalog.ts).
 * Every read before it answers an empty list, and an entry routing an empty list refuses every turn.
 *
 * Polled rather than awaited on the process, because "the process is up" and "the model is loaded" are minutes
 * apart for a large model and only the second is the readiness anything downstream cares about. /health is
 * llama-server's own answer to that question: 503 loading, 200 serving.
 *
 * Ends on a DEAD PANEL as readily as on the ceiling: a server that exited during its load will never publish,
 * and the card's own status says so far better than a watcher still counting down would.
 *
 * BOUNDED, and false is a real answer rather than a timeout to throw on. A model still not serving twenty
 * minutes in has something wrong with it that the panel terminal is already reporting, and the next Update
 * starts a fresh watcher anyway. */
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

/* THE WATCHER THAT MAKES A LOCAL MODEL DRIVABLE, held OUTSIDE `jobs` on purpose.
 *
 * Folding it into the job would hold that job open for the whole load, and `jobs.has` is what makes a second
 * Update a no-op, so a user watching a model that is stuck loading would press Update, be told the server is
 * starting, and get nothing. The download job's shape stays exactly what it was; this rides alongside it.
 *
 * One watcher per entry, and a fresh start CANCELS the last: the only caller runs right after a server was
 * (re)started, so an older watcher is counting down on a process that no longer exists. */
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
            ctx.logger.warn(`localmodel ${id}: ${error instanceof Error ? error.message : String(error)}`);
        })
        .finally(() => {
            if (servings.get(id) === abort) {
                servings.delete(id);
            }
        });
};

// Stop watching an entry that is going away, the removal and rename halves of the map above. Separate from the
// job's abort because the two have different lifetimes: the job is done once the server is spawned, the
// watcher runs until it serves.
const stopWatching = (id: string): void => {
    servings.get(id)?.abort();
    servings.delete(id);
};

/* WHAT THE ADD HANDS OFF TO. Fetch the weights if they aren't here, serve them, and tell the translator the
 * moment they are actually being served; never throws, because nothing is holding it, and what went wrong
 * belongs on the card rather than in an unhandled rejection.
 *
 * THE SYNC AT THE END IS THE HALF THAT MAKES THE ENTRY DRIVABLE, and it has to be here rather than on the
 * route that added it. The route's sync ran while the weights were still arriving, so it wrote the truth of
 * that moment, an endpoint publishing no models, and nothing else in the daemon is watching for the moment
 * that stops being true. This job IS that watcher: it is the only code that knows a download finished and a
 * server came up for this entry. Without it the card reads "active", the server answers on loopback, and every
 * turn is refused with "unknown provider for model" because the routing table still says the endpoint serves
 * nothing (ctx.syncEndpoints has the whole argument).
 *
 * Idempotent per entry: a second Update while the first is still downloading joins the job in flight rather
 * than racing a second writer onto the same part file. The abort check before the server starts is the removal
 * case, a card deleted while its weights were arriving must not leave a process serving it. */
const startInBackground = (ctx: CapabilityCtx, id: string, source: LocalModelSource, destination: string, window: number): void => {
    // The most recently restored or explicitly updated entry owns the one local-model slot. On boot the
    // manifest order makes this deterministic; on Update it makes the card the owner just touched active.
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
            // Another entry was selected while these weights were arriving. Keep the bytes cached, but never
            // let a late download steal the GPU from the newer choice.
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
            // A job stopped on purpose is not a fault to report: the card that would have shown it is the one
            // being removed, and recording it would leave a complaint keyed to an entry nobody can see.
            if (abort.signal.aborted) {
                return;
            }
            const message = error instanceof Error ? error.message : String(error);
            failures.set(id, message);
            ctx.logger.warn(`localmodel ${id}: ${message}`);
        })
        .finally(() => {
            jobs.delete(id);
        });
    jobs.set(id, { promise, abort });
};

/* WHAT A WINDOW UNDER THE AGENT FLOOR HAS TO SAY, and it is said on both surfaces that quote the number.
 *
 * Not an error and not a warning state: the entry does exactly what it was configured to do, and a red row for
 * an owner who deliberately traded conversation for a gigabyte of RAM would be the card second-guessing a choice
 * it asked for. What it must not do is stay silent, because the consequence is invisible from the row otherwise:
 * the model serves, the picker lists it, and every full turn is refused by the arithmetic in
 * agent/context-budget.ts.
 *
 * Two lengths because there are two surfaces, not because there are two facts: the connections row is a table
 * cell with a model name already in it, the add's log line has a paragraph and the reader's attention while the
 * choice is still fresh, so that is where the way out belongs. */
const windowNote = (window: number): string => (fitsAgentTurn(window) ? "" : ", quick jobs only");

const windowAdvice = (window: number): string =>
    fitsAgentTurn(window)
        ? ""
        : " — enough for the quick-model jobs (titles, commit messages), not for a full agent turn, whose tools and instructions fill a window this size on their own. Raise it on the card to chat with this model.";

// What the GPU option has to say, the docker card's sentences with the toolkit clause dropped (there is no
// nested runtime here to configure): pending until the directive's rebuild, an error a rebuild can't fix when
// the host has no nvidia runtime, silence when the flag rode.
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

// Whether another entry is fed by the same weights file, which is what decides if removing this one may stop
// the download. Keyed on the resolved path, the same answer weightsPath gives the entries themselves.
const sharesWeights = async (ctx: CapabilityCtx, id: string, destination: string): Promise<boolean> =>
    (await ctx.capabilities.list()).some((capability: Capability) => {
        if (capability.kind !== "localmodel" || capability.id === id) {
            return false;
        }
        const other = localModelSource(capability.config);
        return other !== undefined && weightsPath(ctx, other) === destination;
    });

export const localModelHandler: CapabilityHandler = {
    // Nothing here is a credential: the weights are public bytes and the server answers loopback unauthenticated.
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
    /* The engine pack resolves to nothing on the standard image (it bakes llama-server), which is what makes
     * the CPU add rebuild-free; on a core image it is the install itself. The GPU option adds the CUDA build
     * and the directive, and the directive is present whenever asked, the docker precedent: baking it into the
     * overlay is what records the grant and flips the derived state to "rebuild required". */
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
        /* THE WINDOW IS SAID OUT LOUD HERE, and it is the one line on this card worth a sentence of argument.
         * It is the setting that decides whether the entry can run a turn at all, it is the setting whose memory
         * the person is about to find out about, and "custom" with nothing typed silently lands on the default.
         * Naming the number the server is actually being started with makes all three visible at the moment the
         * choice is still fresh, rather than after a download and a refused message. */
        yield { kind: "log", message: `Conversation window: ${localModelWindowLabel(window)} tokens${windowAdvice(window)}` };
        // The one line the add has to leave behind: what is happening now, and where the rest of it will be
        // said. Everything after this point is reported by `status` on the card, which is the surface that
        // survives a page refresh.
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
        // Progress first, and by path: the download is the long pole and the reason this card polls at all.
        const inFlight = downloads.get(path);
        if (inFlight !== undefined) {
            return { state: "pending", detail: inFlight.total > 0 ? `downloading ${gb(inFlight.received)} / ${gb(inFlight.total)}` : "downloading" };
        }
        // What the background job would have thrown at an add that was still listening.
        const failure = failures.get(id);
        if (failure !== undefined) {
            return { state: "error", detail: failure };
        }
        if (await serverMissing()) {
            return { state: "pending", detail: "rebuild required" };
        }
        if (await serverHealthy(localModelPort(id))) {
            /* The server is the headline; the GPU caveat only matters on a card that would otherwise read clean.
             * The WINDOW joins the model name because it is the other half of what this entry is: two rows naming
             * the same weights can be a working agent and a quick-model-only rung, and nothing else on the page
             * says which one you are looking at. */
            const window = localModelWindow(model);
            return (
                gpuStatus(config) ?? {
                    state: "active",
                    detail: `${localModelLabel(model)} · ${localModelWindowLabel(window)} window${windowNote(window)}`,
                }
            );
        }
        const held = await weightsReady(path);
        /* A job with no progress yet is the second or two before the first byte, and "loading the model" there
         * is a lie about a download that hasn't opened its connection: what the weights say is which of the two
         * this actually is. */
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
    /* The weights STAY, deliberately: they are multi-gigabyte, shared by name with any other entry naming the
     * same model, and live under the cache root the janitor already owns. Deleting gigabytes should be its own
     * deliberate act, which the agent can do on request. A half-finished part file stays for the same reason and
     * one more: it is the resume point if this model is ever added again. The catalog entry goes with the
     * capability for the endpoint handler's reason: a stale list is what the next entry under this name would
     * inherit.
     *
     * What must NOT survive the removal is work still running for it. The job is stopped in every case; the
     * download only when no other card is fed by the same file. */
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
    // The id keys the panel session, the derived port and the persisted catalog; the weights are keyed by file
    // name and carry over untouched. Stop the old server and drop the old catalog, the re-apply starts the new.
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

/* Boot restore, beside startDockerdIfEnabled: the server dies with the container while the manifest and the
 * weights survive on /work, bring every entry back without waiting on loads. An entry whose weights never
 * finished arriving is picked back up here too, from the byte it stopped at, which is what makes a restart in
 * the middle of a twenty-gigabyte download cost seconds rather than the whole download.
 *
 * Best-effort by construction: the job never throws, a failure lands in the panel terminal and the card's
 * status, never the boot path. */
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
