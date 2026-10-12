import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { errorMessage } from "@intentic/base/errors";
import { forkedExec } from "@intentic/base/git";
import type { FetchLike } from "../model-store.js";
import { type LocalVoiceModel, voiceModelUrl } from "./voice-models.js";

// Where a voice model is, and getting it there when it is not: an image's baked copy first, else the workspace cache,
// fetched once as its release archive with its progress counted, resumed after an interruption, checked against its
// pinned sha256, and unpacked. A model directory only ever takes its final name after its archive matched and unpacked
// whole, with a `.complete` mark written last, so finding the mark is finding the model.

export type VoiceModelState =
    | { readonly state: "absent" }
    | { readonly state: "downloading"; readonly received: number; readonly total: number }
    | { readonly state: "ready"; readonly dir: string }
    | { readonly state: "failed"; readonly error: string };

export interface VoiceModelStoreDeps {
    // Baked models, one directory per model id; read-only, and absent on every image today.
    readonly bakedDir?: string;
    // The workspace cache the rest are fetched into, one directory per model id.
    readonly cacheDir: string;
    readonly fetch?: FetchLike;
    // Unpacks a verified archive into an empty directory; `tar -xjf` unless a test hands it another.
    readonly unpack?: (archive: string, into: string) => Promise<void>;
    readonly log: (message: string) => void;
    // Told whenever a model's state moves; download progress at most every PROGRESS_EVERY_MS.
    readonly onChange?: (model: string) => void;
}

export interface VoiceModelStore {
    readonly state: (model: LocalVoiceModel) => Promise<VoiceModelState>;
    // Its directory, fetching it first when it is not on disk; one fetch however many ask.
    readonly ensure: (model: LocalVoiceModel) => Promise<string>;
}

const PROGRESS_EVERY_MS = 250;
const COMPLETE = ".complete";

const sizeOf = (path: string): Promise<number | undefined> =>
    stat(path).then(
        (found) => (found.isFile() ? found.size : undefined),
        () => undefined,
    );

const hashInto = (hash: ReturnType<typeof createHash>, path: string): Promise<void> =>
    new Promise((resolve, reject) => {
        createReadStream(path)
            .on("data", (chunk) => hash.update(chunk))
            .on("end", resolve)
            .on("error", reject);
    });

// The base image carries bzip2 (Dockerfile's toolbox line), which is all tar needs for the release's archives.
const tarUnpack = async (archive: string, into: string): Promise<void> => {
    // Kokoro's 350 MB unpacks in well under a minute even on a busy box; past ten, tar is stuck rather than slow.
    await forkedExec("tar", ["-xjf", archive, "-C", into], { maxBuffer: 4 * 1024 * 1024, timeout: 10 * 60_000 });
};

export const createVoiceModelStore = ({ bakedDir, cacheDir, fetch: fetchFile = fetch, unpack = tarUnpack, log, onChange }: VoiceModelStoreDeps): VoiceModelStore => {
    const downloads = new Map<string, { received: number; readonly total: number; readonly done: Promise<string> }>();
    const failures = new Map<string, string>();

    const locate = async (model: LocalVoiceModel): Promise<string | undefined> => {
        for (const root of bakedDir === undefined ? [cacheDir] : [bakedDir, cacheDir]) {
            const dir = join(root, model.id);
            if ((await sizeOf(join(dir, COMPLETE))) !== undefined) {
                return dir;
            }
        }
        return undefined;
    };

    // The archive into `<cacheDir>/<id>.tar.bz2`: resumes a `.part` an interrupted fetch left with a range request,
    // counts every byte into `progress`, and takes the final name only at its pinned size and sha256.
    const fetchArchive = async (model: LocalVoiceModel, progress: (bytes: number) => void): Promise<string> => {
        const target = join(cacheDir, `${model.id}.tar.bz2`);
        const part = `${target}.part`;
        let have = (await sizeOf(part)) ?? 0;
        if (have > model.bytes) {
            await rm(part, { force: true });
            have = 0;
        }
        const response = await fetchFile(voiceModelUrl(model), { headers: have > 0 ? { range: `bytes=${have}-` } : {} });
        if (response.status !== 200 && response.status !== 206) {
            await response.body?.cancel();
            throw new Error(`${model.id}: the release answered ${response.status}`);
        }
        // A 200 to a range request is the whole archive again: start over rather than append it.
        const resumed = response.status === 206 && have > 0;
        const hash = createHash("sha256");
        if (resumed) {
            await hashInto(hash, part);
            progress(have);
        }
        const handle = await open(part, resumed ? "a" : "w");
        let written = resumed ? have : 0;
        try {
            // SAFETY: a fetch Response body is a ReadableStream of Uint8Array chunks, which Node streams async-iterably.
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
        if (written !== model.bytes || digest !== model.sha256) {
            await rm(part, { force: true });
            throw new Error(`${model.id} arrived corrupt (${written} of ${model.bytes} bytes, sha256 ${digest.slice(0, 12)}…)`);
        }
        await rename(part, target);
        return target;
    };

    // Unpacked beside its final place and renamed in whole, so a half-unpacked model is never found.
    const install = async (model: LocalVoiceModel, archive: string): Promise<string> => {
        const staging = join(cacheDir, `.${model.id}.unpacking`);
        const dir = join(cacheDir, model.id);
        await rm(staging, { recursive: true, force: true });
        await mkdir(staging, { recursive: true });
        try {
            await unpack(archive, staging);
            // The release's archives hold one directory named after themselves; take whatever single one is there.
            const entries = await readdir(staging, { withFileTypes: true });
            const top = entries.length === 1 && entries[0]!.isDirectory() ? join(staging, entries[0]!.name) : staging;
            await writeFile(join(top, "NOTICE"), `${model.attribution}\n${voiceModelUrl(model)}\n`);
            await writeFile(join(top, COMPLETE), `${model.sha256}\n`);
            await rm(dir, { recursive: true, force: true });
            await rename(top, dir);
        } finally {
            await rm(staging, { recursive: true, force: true });
            await rm(archive, { force: true });
        }
        return dir;
    };

    const download = (model: LocalVoiceModel): Promise<string> => {
        const running = downloads.get(model.id);
        if (running !== undefined) {
            return running.done;
        }
        const entry = { received: 0, total: model.bytes, done: Promise.resolve("") };
        let toldAt = 0;
        const progress = (bytes: number): void => {
            entry.received += bytes;
            if (Date.now() - toldAt >= PROGRESS_EVERY_MS) {
                toldAt = Date.now();
                onChange?.(model.id);
            }
        };
        entry.done = (async () => {
            failures.delete(model.id);
            log(`fetching the voice model ${model.id} (${Math.round(model.bytes / 1_048_576)} MB)`);
            await mkdir(cacheDir, { recursive: true });
            const dir = await install(model, await fetchArchive(model, progress));
            log(`the voice model ${model.id} is ready`);
            return dir;
        })()
            .catch((error: Error) => {
                failures.set(model.id, errorMessage(error));
                log(`fetching the voice model ${model.id} failed: ${errorMessage(error)}`);
                throw error;
            })
            .finally(() => {
                downloads.delete(model.id);
                onChange?.(model.id);
            });
        downloads.set(model.id, entry);
        onChange?.(model.id);
        return entry.done;
    };

    return {
        state: async (model) => {
            const running = downloads.get(model.id);
            if (running !== undefined) {
                return { state: "downloading", received: running.received, total: running.total };
            }
            const dir = await locate(model);
            if (dir !== undefined) {
                return { state: "ready", dir };
            }
            const error = failures.get(model.id);
            return error === undefined ? { state: "absent" } : { state: "failed", error };
        },
        ensure: async (model) => (await locate(model)) ?? download(model),
    };
};
