import { execFile } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { downloadFile } from "@huggingface/hub";
import type { CapabilityStatus, IntenticLine, LocalModelConfig } from "@intentic/sandbox-contract";
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

const weightsReady = async (path: string): Promise<boolean> =>
    stat(path).then(
        () => true,
        () => false,
    );

/* WHAT A DOWNLOAD IN FLIGHT LOOKS LIKE TO STATUS, module state keyed by entry id: apply owns the download and
 * streams its progress as log lines, but the card polls `status` on its own clock and "pending · 2.1 / 4.6 GB"
 * is the difference between a working download and a card that just says pending for ten minutes. Cleared on
 * every exit path; a daemon restart clears it by construction and the re-probe reads the file instead. */
const downloads = new Map<string, { received: number; total: number }>();

const gb = (bytes: number): string => `${(bytes / 1e9).toFixed(1)} GB`;

// One entry's weights, streamed straight to disk beside their final name and renamed into place whole, the
// transcribe.ts pattern and for its reason: readiness is a stat, so a file growing in place reads as "ready"
// the moment it exists. HF paths go through hub's downloadFile (anonymous plain-HTTP fetches of HF weights
// 403 on the Xet bridge); a custom URL is fetched plainly.
const downloadWeights = async function* (id: string, source: LocalModelSource, destination: string): AsyncGenerator<IntenticLine> {
    const stream = await (async (): Promise<{ body: ReadableStream<Uint8Array>; total: number }> => {
        if (source.repo !== undefined && source.path !== undefined) {
            const blob = await downloadFile({ repo: source.repo, path: source.path });
            if (blob === null) {
                throw new Error(`${source.repo} has no ${source.path}, check the model path on the card.`);
            }
            return { body: blob.stream() as unknown as ReadableStream<Uint8Array>, total: blob.size };
        }
        const response = await fetch(source.url ?? "");
        if (!response.ok || response.body === null) {
            throw new Error(`the model URL answered ${response.status}, check it serves a GGUF file.`);
        }
        return { body: response.body, total: Number(response.headers.get("content-length") ?? 0) };
    })();
    yield { kind: "log", message: `Downloading ${source.file}${stream.total > 0 ? ` (${gb(stream.total)})` : ""}, served from this sandbox once it lands.` };
    await mkdir(dirname(destination), { recursive: true });
    const staged = `${destination}.${randomUUID()}.part`;
    const file = createWriteStream(staged);
    const reader = stream.body.getReader();
    downloads.set(id, { received: 0, total: stream.total });
    try {
        let received = 0;
        let reported = 0;
        for (;;) {
            const chunk = await reader.read();
            if (chunk.done) {
                break;
            }
            received += chunk.value.byteLength;
            downloads.set(id, { received, total: stream.total });
            if (!file.write(chunk.value)) {
                await once(file, "drain");
            }
            // A log line per ~decile, not per chunk: the apply stream is a terminal, not a progress bar.
            if (stream.total > 0 && received - reported >= stream.total / 10) {
                reported = received;
                yield { kind: "log", message: `${gb(received)} of ${gb(stream.total)}…` };
            }
        }
        file.end();
        await once(file, "close");
        await rename(staged, destination);
    } catch (error) {
        file.destroy();
        await rm(staged, { force: true });
        throw error;
    } finally {
        downloads.delete(id);
    }
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
        const path = weightsPath(ctx, source);
        if (!(await weightsReady(path))) {
            yield* downloadWeights(id, source, path);
        }
        if (gpuAsked(model) && gpuState() === undefined) {
            yield { kind: "log", message: "GPU access needs a one-time rebuild (Environment card), serving on CPU until then." };
        }
        yield { kind: "log", message: `Starting llama-server (its output is in the panel-${localModelPanelKey(id)} terminal)…` };
        await startServer(ctx, id, path);
        const port = localModelPort(id);
        for (let attempt = 0; attempt < 90; attempt++) {
            await delay(1000);
            if (await serverHealthy(port)) {
                yield {
                    kind: "log",
                    message: `${localModelLabel(model)} is serving, it appears as its own provider in the chat's model picker. Pin it as the quick model in Settings and commit messages run on it for free.`,
                };
                return;
            }
            if (!ctx.panels.running(localModelPanelKey(id))) {
                yield {
                    kind: "log",
                    message: `llama-server exited while loading, its output is in the panel-${localModelPanelKey(id)} terminal. Out of memory is the usual cause; pick a smaller model.`,
                };
                return;
            }
        }
        yield { kind: "log", message: "Still loading after 90s, the card re-probes, and the load's progress is in the panel terminal." };
    },
    status: async (ctx, id, config) => {
        const inFlight = downloads.get(id);
        if (inFlight !== undefined) {
            return { state: "pending", detail: inFlight.total > 0 ? `downloading ${gb(inFlight.received)} / ${gb(inFlight.total)}` : "downloading" };
        }
        const model = config as LocalModelConfig;
        const source = localModelSource(model);
        if (source === undefined) {
            return { state: "error", detail: "no model named, edit the card" };
        }
        if (await serverMissing()) {
            return { state: "pending", detail: "rebuild required" };
        }
        if (await serverHealthy(localModelPort(id))) {
            // The server is the headline; the GPU caveat only matters on a card that would otherwise read clean.
            return gpuStatus(config) ?? { state: "active", detail: localModelLabel(model) };
        }
        if (ctx.panels.running(localModelPanelKey(id))) {
            return { state: "pending", detail: "loading the model" };
        }
        if (!(await weightsReady(weightsPath(ctx, source)))) {
            return { state: "pending", detail: "weights not downloaded, press Update to fetch them" };
        }
        return { state: "error", detail: "llama-server not running, press Update to start it" };
    },
    /* The weights STAY, deliberately: they are multi-gigabyte, shared by name with any other entry naming the
     * same model, and live under the cache root the janitor already owns. Deleting gigabytes should be its own
     * deliberate act, which the agent can do on request. The catalog entry goes with the capability for the
     * endpoint handler's reason: a stale list is what the next entry under this name would inherit. */
    remove: async (ctx, id) => {
        await ctx.panels.stop(localModelPanelKey(id));
        await ctx.endpointModels.forget(id);
    },
    // The id keys the panel session, the derived port and the persisted catalog; the weights are keyed by file
    // name and carry over untouched. Stop the old server and drop the old catalog, the re-apply starts the new.
    rename: {
        carry: async (ctx, from) => {
            await ctx.panels.stop(localModelPanelKey(from));
            await ctx.endpointModels.forget(from);
        },
    },
};

// Boot restore, beside startDockerdIfEnabled: the server dies with the container while the manifest and the
// weights survive on /work, bring every ready entry back without waiting on loads. Best-effort: a failure
// lands in the panel terminal and the card's status, never the boot path.
export const startLocalModelsIfEnabled = async (ctx: CapabilityCtx): Promise<void> => {
    const entries = (await ctx.capabilities.list()).flatMap((capability) => (capability.kind === "localmodel" ? [capability] : []));
    if (entries.length === 0 || (await serverMissing())) {
        return;
    }
    for (const entry of entries) {
        const source = localModelSource(entry.config);
        if (source === undefined || ctx.panels.running(localModelPanelKey(entry.id)) || !(await weightsReady(weightsPath(ctx, source)))) {
            continue;
        }
        await ctx.panels.start(localModelPanelKey(entry.id), {
            command: serverCommand(weightsPath(ctx, source), localModelPort(entry.id)),
            cwd: ctx.workspace.root,
        });
    }
};
