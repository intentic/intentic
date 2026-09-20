import { createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { once } from "node:events";
import { dirname } from "node:path";
import { downloadFile } from "@huggingface/hub";
import { errorMessage } from "@intentic/base/errors";
import { type Capability, LOCAL_MODEL_INSTANT, LOCAL_MODEL_WINDOW_DEFAULT, type LocalModelPrefetch } from "@intentic/sandbox-contract";
import { type LocalModelSource, localModelSource, localModelWeightsPath } from "./local-model.js";

// The weights cache: fetching a GGUF into it, resuming an interrupted fetch, and reporting what is in flight. Lives
// with the endpoint rather than with the capability handler that started this, because a download is about a file in a
// shared cache, not about one card's lifecycle — and because the connect view's prefetch writes here before any card
// exists. One direction of dependency falls out of that: capabilities reach into endpoints, never the reverse.

export const weightsGb = (bytes: number): string => `${(bytes / 1024 ** 3).toFixed(1)} GB`;

// Deterministic, not a fresh name per attempt: this file is the resume point the next attempt looks for.
const stagedPath = (destination: string): string => `${destination}.part`;

export const fileSize = async (path: string): Promise<number> =>
    stat(path).then(
        (info) => info.size,
        () => 0,
    );

export const weightsReady = async (path: string): Promise<boolean> =>
    stat(path).then(
        () => true,
        () => false,
    );

// Both keyed by destination path, not by whoever asked: two cards naming the same model, and the prefetch that ran
// before either existed, are one transfer.
const downloads = new Map<string, { received: number; total: number }>();
const fetches = new Map<string, { readonly promise: Promise<void>; readonly abort: AbortController }>();

/** Bytes moved so far for this destination, or nothing when no transfer is open on it. */
export const weightsProgress = (destination: string): { received: number; total: number } | undefined => downloads.get(destination);

/** Whether a transfer is open on this destination, progress or not: between the call and the first chunk there is one. */
export const weightsFetching = (destination: string): boolean => fetches.has(destination);

/** Stops the transfer on this destination, leaving the part file so the next attempt resumes from it. */
export const abortWeights = (destination: string): void => {
    fetches.get(destination)?.abort.abort();
};

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

/** One download per destination, however many cards — or a prefetch nobody asked for — are waiting on it. */
export const ensureWeights = (source: LocalModelSource, destination: string): Promise<void> => {
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

// Weights fetched before anybody has asked for them, so the connect view's local lane can be taken up without a
// download in front of it. Same destination path and same `.part` resume point the handler uses, so adding the card
// afterwards finds the file or joins the transfer rather than starting a second one.
const INSTANT_SOURCE = localModelSource({ model: LOCAL_MODEL_INSTANT.id, gpu: "off", context: LOCAL_MODEL_WINDOW_DEFAULT });
// A prefetch nobody is streaming has no error frame to throw; this is where its failure waits to be read.
let prefetchFailure: string | undefined;

// Whether a card already names these weights: the stop must not cancel a download that card is waiting on.
const instantInUse = (capabilities: readonly Capability[]): boolean =>
    capabilities.some((capability) => capability.kind === "localmodel" && capability.config.model === LOCAL_MODEL_INSTANT.id);

export const localModelPrefetchStatus = async (root: string): Promise<LocalModelPrefetch> => {
    if (INSTANT_SOURCE === undefined) {
        // Unreachable for a curated row, and a loud answer rather than a silent idle if one is ever mistyped.
        return { model: LOCAL_MODEL_INSTANT.id, state: "failed", receivedBytes: 0, totalBytes: 0, detail: "not a Hugging Face path" };
    }
    const destination = localModelWeightsPath(root, INSTANT_SOURCE);
    const inFlight = weightsProgress(destination);
    if (inFlight !== undefined) {
        return { model: LOCAL_MODEL_INSTANT.id, state: "downloading", receivedBytes: inFlight.received, totalBytes: inFlight.total };
    }
    if (await weightsReady(destination)) {
        const size = await fileSize(destination);
        return { model: LOCAL_MODEL_INSTANT.id, state: "held", receivedBytes: size, totalBytes: size };
    }
    // Between the call and the first chunk there is a transfer with no progress yet; idle would read as "never started".
    if (weightsFetching(destination)) {
        return { model: LOCAL_MODEL_INSTANT.id, state: "downloading", receivedBytes: 0, totalBytes: 0 };
    }
    if (prefetchFailure !== undefined) {
        return { model: LOCAL_MODEL_INSTANT.id, state: "failed", receivedBytes: 0, totalBytes: 0, detail: prefetchFailure };
    }
    return { model: LOCAL_MODEL_INSTANT.id, state: "idle", receivedBytes: 0, totalBytes: 0 };
};

export const localModelPrefetch = async (
    root: string,
    action: "start" | "stop",
    capabilities: readonly Capability[],
): Promise<LocalModelPrefetch> => {
    if (INSTANT_SOURCE === undefined) {
        return localModelPrefetchStatus(root);
    }
    const destination = localModelWeightsPath(root, INSTANT_SOURCE);
    if (action === "stop") {
        // The part file stays either way: a later start resumes from where this one stopped.
        if (!instantInUse(capabilities)) {
            abortWeights(destination);
        }
        return localModelPrefetchStatus(root);
    }
    if (!(await weightsReady(destination))) {
        prefetchFailure = undefined;
        // Not awaited: the whole point is that the reader carries on while it runs. ensureWeights dedupes by
        // destination, so pressing start twice joins one transfer.
        void ensureWeights(INSTANT_SOURCE, destination).catch((error: unknown) => {
            prefetchFailure = errorMessage(error);
        });
    }
    return localModelPrefetchStatus(root);
};
