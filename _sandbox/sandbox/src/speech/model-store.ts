import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { errorMessage } from "@intentic/base/errors";
import type { SpeechEngine } from "@intentic/sandbox-contract";
import { modelBytes, modelFileUrl, type SpeechModel, type SpeechModelFile } from "./speech-models.js";

// Where a speech model's files are, and getting them there when they are not: the image's baked copy first, else the
// workspace cache, fetched once with its progress counted, resumed after an interruption, and checked against its pinned
// sha256 before it is used. A file only ever takes its final name after its digest matched, so finding all of them at
// their sizes is finding the model.

export type ModelState =
    | { readonly state: "absent" }
    | { readonly state: "downloading"; readonly received: number; readonly total: number }
    | { readonly state: "ready"; readonly dir: string }
    | { readonly state: "failed"; readonly error: string };

export type FetchLike = (url: string, init: { readonly headers: Record<string, string>; readonly signal?: AbortSignal }) => Promise<Response>;

export interface ModelStoreDeps {
    // The image's baked models, one directory per engine; read-only.
    readonly bakedDir: string;
    // The workspace cache the rest are fetched into, one directory per engine.
    readonly cacheDir: string;
    readonly fetch?: FetchLike;
    readonly log: (message: string) => void;
    // Told whenever a model's state moves; download progress at most every PROGRESS_EVERY_MS.
    readonly onChange?: (engine: SpeechEngine) => void;
}

export interface ModelStore {
    // The model's state as of now, without touching the network: ready when its files are on disk.
    readonly state: (model: SpeechModel) => Promise<ModelState>;
    // Its directory, fetching it first when it is not on disk; one fetch however many ask.
    readonly ensure: (model: SpeechModel) => Promise<string>;
}

const PROGRESS_EVERY_MS = 250;

const sizeOf = (path: string): Promise<number | undefined> =>
    stat(path).then(
        (found) => (found.isFile() ? found.size : undefined),
        () => undefined,
    );

// Every file present at its pinned size. The size alone is enough: a fetched file is renamed into place only after its
// digest matched, and a baked one was checked when the image was built.
const complete = async (dir: string, model: SpeechModel): Promise<boolean> => {
    const sizes = await Promise.all(model.files.map((file) => sizeOf(join(dir, file.path))));
    return sizes.every((size, index) => size === model.files[index]?.size);
};

const hashInto = (hash: ReturnType<typeof createHash>, path: string): Promise<void> =>
    new Promise((resolve, reject) => {
        createReadStream(path)
            .on("data", (chunk) => hash.update(chunk))
            .on("end", resolve)
            .on("error", reject);
    });

export const createModelStore = ({ bakedDir, cacheDir, fetch: fetchFile = fetch, log, onChange }: ModelStoreDeps): ModelStore => {
    const downloads = new Map<SpeechEngine, { received: number; readonly total: number; readonly done: Promise<string> }>();
    const failures = new Map<SpeechEngine, string>();

    const locate = async (model: SpeechModel): Promise<string | undefined> => {
        for (const dir of [join(bakedDir, model.engine), join(cacheDir, model.engine)]) {
            if (await complete(dir, model)) {
                return dir;
            }
        }
        return undefined;
    };

    // One file into `dir`: resumes a `.part` left by an interrupted fetch with a range request, counts every byte into
    // `progress`, and renames it into place only when its size and sha256 are the pinned ones.
    const fetchOne = async (model: SpeechModel, file: SpeechModelFile, dir: string, progress: (bytes: number) => void): Promise<void> => {
        const target = join(dir, file.path);
        if ((await sizeOf(target)) === file.size) {
            progress(file.size);
            return;
        }
        const part = `${target}.part`;
        let have = (await sizeOf(part)) ?? 0;
        if (have > file.size) {
            await rm(part, { force: true });
            have = 0;
        }
        const response = await fetchFile(modelFileUrl(model, file), { headers: have > 0 ? { range: `bytes=${have}-` } : {} });
        if (response.status !== 200 && response.status !== 206) {
            await response.body?.cancel();
            throw new Error(`${file.path}: Hugging Face answered ${response.status}`);
        }
        // A 200 to a range request is the whole file again: start over rather than append it to what is there.
        const resumed = response.status === 206 && have > 0;
        const hash = createHash("sha256");
        if (resumed) {
            await hashInto(hash, part);
            progress(have);
        }
        const handle = await open(part, resumed ? "a" : "w");
        let written = resumed ? have : 0;
        try {
            const body = (response.body ?? []) as AsyncIterable<Uint8Array>;
            for await (const bytes of body) {
                await handle.write(bytes);
                hash.update(bytes);
                written += bytes.byteLength;
                progress(bytes.byteLength);
            }
        } finally {
            await handle.close();
        }
        const digest = hash.digest("hex");
        if (written !== file.size || digest !== file.sha256) {
            await rm(part, { force: true });
            throw new Error(`${file.path} arrived corrupt (${written} of ${file.size} bytes, sha256 ${digest.slice(0, 12)}…)`);
        }
        await rename(part, target);
    };

    const download = (model: SpeechModel): Promise<string> => {
        const running = downloads.get(model.engine);
        if (running !== undefined) {
            return running.done;
        }
        const dir = join(cacheDir, model.engine);
        const entry = { received: 0, total: modelBytes(model), done: Promise.resolve(dir) };
        let toldAt = 0;
        const progress = (bytes: number): void => {
            entry.received += bytes;
            if (Date.now() - toldAt >= PROGRESS_EVERY_MS) {
                toldAt = Date.now();
                onChange?.(model.engine);
            }
        };
        entry.done = (async () => {
            failures.delete(model.engine);
            log(`fetching the ${model.engine} speech model (${Math.round(entry.total / 1_048_576)} MB)`);
            await mkdir(dir, { recursive: true });
            for (const file of model.files) {
                await fetchOne(model, file, dir, progress);
            }
            log(`the ${model.engine} speech model is ready`);
            return dir;
        })()
            .catch((error: unknown) => {
                failures.set(model.engine, errorMessage(error));
                log(`fetching the ${model.engine} speech model failed: ${errorMessage(error)}`);
                throw error;
            })
            .finally(() => {
                downloads.delete(model.engine);
                onChange?.(model.engine);
            });
        downloads.set(model.engine, entry);
        onChange?.(model.engine);
        return entry.done;
    };

    return {
        state: async (model) => {
            const running = downloads.get(model.engine);
            if (running !== undefined) {
                return { state: "downloading", received: running.received, total: running.total };
            }
            const dir = await locate(model);
            if (dir !== undefined) {
                return { state: "ready", dir };
            }
            const error = failures.get(model.engine);
            return error === undefined ? { state: "absent" } : { state: "failed", error };
        },
        ensure: async (model) => (await locate(model)) ?? download(model),
    };
};
