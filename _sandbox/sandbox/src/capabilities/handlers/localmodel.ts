import { execFile } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { once } from "node:events";
import { promisify } from "node:util";
import { downloadFile } from "@huggingface/hub";
import type { Capability, CapabilityStatus, LocalModelConfig } from "@intentic/sandbox-contract";
import { packFragment } from "../../environment/packs.js";
import { localModelLabel, localModelPort, localModelSource, type LocalModelSource } from "../../endpoints/local-model.js";
import { statePath } from "../../workspace/state-paths.js";
import type { CapabilityCtx, CapabilityHandler } from "../capability.js";

/* A MODEL THE SANDBOX RUNS ITSELF. The user picks weights on the card; this handler downloads them into the
 * workspace cache (the whisper precedent: re-downloadable by content, so under `.intentic/local/cache/`, which
 * exports skip and the janitor may clear) and serves them with the image's bundled llama-server on the entry's
 * derived loopback port (endpoints/local-model.ts). From there the entry IS an endpoint: the translator routes
 * turns at it, the picker lists its model, quick-model pins hold, all through the same seams a user-added
 * endpoint rides, and none of that code knows this kind exists.
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

// The visible tmux session one entry's llama-server runs in (`panel-model-<id>`), where its load/serve output
// lives and where a user goes when the card says something is wrong.
export const localModelPanelKey = (id: string): string => `model-${id}`;

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

/* THE WORK RUNNING BEHIND THE CARDS, and why there are three maps rather than one.
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

// llama-server, one process per entry, one model per process. --jinja because the modern instruct models the
// card curates carry their chat/tool template in the GGUF and serve tool calls only through it; the context
// size is a conservative fixed default (per-entry knobs are a decision the card deliberately doesn't offer);
// -ngl offloads every layer exactly when the GPU actually rode (the stamp, not the ask).
const serverCommand = (path: string, port: number): string => {
    const layers = gpuState() === "all" ? " -ngl 999" : "";
    return `llama-server -m '${path}' --host 127.0.0.1 --port ${port} --ctx-size 16384 --jinja${layers}`;
};

// llama-server's own readiness: /health answers 503 while the model loads, 200 once it serves. Short timeout:
// status runs on the card's poll clock.
const serverHealthy = async (port: number): Promise<boolean> =>
    fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) }).then(
        (response) => response.ok,
        () => false,
    );

const startServer = async (ctx: CapabilityCtx, id: string, path: string): Promise<void> => {
    const key = localModelPanelKey(id);
    // Stop-then-start rather than the docker no-op: an apply may be changing WHICH model this entry serves,
    // and the panel cannot say which weights the running process loaded.
    await ctx.panels.stop(key);
    await ctx.panels.start(key, { command: serverCommand(path, localModelPort(id)), cwd: ctx.workspace.root });
};

/* WHAT THE ADD HANDS OFF TO. Fetch the weights if they aren't here, then serve them; never throws, because
 * nothing is holding it, and what went wrong belongs on the card rather than in an unhandled rejection.
 *
 * Idempotent per entry: a second Update while the first is still downloading joins the job in flight rather
 * than racing a second writer onto the same part file. The abort check before the server starts is the removal
 * case, a card deleted while its weights were arriving must not leave a process serving it. */
const startInBackground = (ctx: CapabilityCtx, id: string, source: LocalModelSource, destination: string): void => {
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
        await startServer(ctx, id, destination);
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
        return { model: model.model, gpu: gpuAsked(config), ...(model.url !== undefined ? { url: model.url } : {}) };
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
    apply: async function* (ctx, id, config) {
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
        startInBackground(ctx, id, source, path);
        // The one line the add has to leave behind: what is happening now, and where the rest of it will be
        // said. Everything after this point is reported by `status` on the card, which is the surface that
        // survives a page refresh.
        yield {
            kind: "log",
            message: held
                ? `Starting llama-server for ${localModelLabel(model)}; the connection's row says when it is serving, and its output is in the panel-${localModelPanelKey(id)} terminal.`
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
            // The server is the headline; the GPU caveat only matters on a card that would otherwise read clean.
            return gpuStatus(config) ?? { state: "active", detail: localModelLabel(model) };
        }
        const held = await weightsReady(path);
        /* A job with no progress yet is the second or two before the first byte, and "loading the model" there
         * is a lie about a download that hasn't opened its connection: what the weights say is which of the two
         * this actually is. */
        if (jobs.has(id) || ctx.panels.running(localModelPanelKey(id))) {
            return { state: "pending", detail: held ? "loading the model" : "fetching the model, gigabytes, leave it running" };
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
        jobs.get(id)?.abort.abort();
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
        startInBackground(ctx, entry.id, source, weightsPath(ctx, source));
    }
};
