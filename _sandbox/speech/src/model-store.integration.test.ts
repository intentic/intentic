import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { waitFor } from "@intentic/testing/bun";
import { createModelStore, type FetchLike } from "./model-store.js";
import type { SpeechModel } from "./speech-models.js";

/* The speech model store over a real disk and a fake Hugging Face: the baked copy wins, a fetch counts its bytes, an
   interrupted one resumes where it stopped, a corrupt one never takes its final name, and many askers share one fetch. */

const sha = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text);

const ENCODER = bytesOf("encoder weights ".repeat(64));
const TOKENS = bytesOf("tokens");

const MODEL: SpeechModel = {
    engine: "parakeet",
    repo: "example/model",
    revision: "abc",
    files: [
        { path: "encoder.int8.onnx", size: ENCODER.length, sha256: sha(ENCODER) },
        { path: "tokens.txt", size: TOKENS.length, sha256: sha(TOKENS) },
    ],
    partials: true,
    attribution: "a test model",
};

const SERVED: Record<string, Uint8Array> = { "encoder.int8.onnx": ENCODER, "tokens.txt": TOKENS };

interface Asked {
    readonly file: string;
    readonly range?: string;
}

// Hugging Face as far as the store reads it: the file at its pinned revision, a range request answered 206.
const huggingFace =
    (asked: Asked[], serve: (file: string) => Uint8Array = (file) => SERVED[file] ?? new Uint8Array()): FetchLike =>
    async (url, init) => {
        const file = url.split("/").at(-1) ?? "";
        expect(url).toBe(`https://huggingface.co/example/model/resolve/abc/${file}`);
        const range = init.headers["range"];
        asked.push({ file, ...(range === undefined ? {} : { range }) });
        const body = serve(file);
        const from = range === undefined ? 0 : Number(/bytes=(\d+)-/u.exec(range)?.[1] ?? 0);
        return new Response(body.slice(from), { status: range === undefined ? 200 : 206 });
    };

const dirs = () => {
    const root = mkdtempSync(join(tmpdir(), "speech-models-"));
    return { bakedDir: join(root, "baked"), cacheDir: join(root, "cache") };
};

test("a baked model is found where the image put it, and nothing is fetched", async () => {
    const { bakedDir, cacheDir } = dirs();
    mkdirSync(join(bakedDir, "parakeet"), { recursive: true });
    writeFileSync(join(bakedDir, "parakeet", "encoder.int8.onnx"), ENCODER);
    writeFileSync(join(bakedDir, "parakeet", "tokens.txt"), TOKENS);
    const asked: Asked[] = [];
    const store = createModelStore({ bakedDir, cacheDir, fetch: huggingFace(asked), log: () => {} });
    expect(await store.state(MODEL)).toEqual({ state: "ready", dir: join(bakedDir, "parakeet") });
    expect(await store.ensure(MODEL)).toBe(join(bakedDir, "parakeet"));
    expect(asked).toEqual([]);
});

test("an absent model is fetched once however many ask, counted while it arrives, and ready after", async () => {
    const { bakedDir, cacheDir } = dirs();
    const asked: Asked[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const fetchGated: FetchLike = async (url, init) => {
        await gate;
        return huggingFace(asked)(url, init);
    };
    const store = createModelStore({ bakedDir, cacheDir, fetch: fetchGated, log: () => {} });
    expect(await store.state(MODEL)).toEqual({ state: "absent" });
    const first = store.ensure(MODEL);
    const second = store.ensure(MODEL);
    await waitFor(async () => expect((await store.state(MODEL)).state).toBe("downloading"));
    expect(await store.state(MODEL)).toEqual({ state: "downloading", received: 0, total: ENCODER.length + TOKENS.length });
    release();
    expect(await first).toBe(join(cacheDir, "parakeet"));
    expect(await second).toBe(join(cacheDir, "parakeet"));
    expect(asked.map(({ file }) => file)).toEqual(["encoder.int8.onnx", "tokens.txt"]);
    expect(await store.state(MODEL)).toEqual({ state: "ready", dir: join(cacheDir, "parakeet") });
    expect(readFileSync(join(cacheDir, "parakeet", "encoder.int8.onnx"))).toEqual(Buffer.from(ENCODER));
});

test("an interrupted fetch resumes from the bytes it already has", async () => {
    const { bakedDir, cacheDir } = dirs();
    mkdirSync(join(cacheDir, "parakeet"), { recursive: true });
    const half = ENCODER.length / 2;
    writeFileSync(join(cacheDir, "parakeet", "encoder.int8.onnx.part"), ENCODER.slice(0, half));
    const asked: Asked[] = [];
    const store = createModelStore({ bakedDir, cacheDir, fetch: huggingFace(asked), log: () => {} });
    await store.ensure(MODEL);
    expect(asked[0]).toEqual({ file: "encoder.int8.onnx", range: `bytes=${half}-` });
    expect(readFileSync(join(cacheDir, "parakeet", "encoder.int8.onnx"))).toEqual(Buffer.from(ENCODER));
    expect(existsSync(join(cacheDir, "parakeet", "encoder.int8.onnx.part"))).toBe(false);
});

test("a corrupt file never takes its final name, the failure is reported, and the next ask fetches again", async () => {
    const { bakedDir, cacheDir } = dirs();
    const asked: Asked[] = [];
    let corrupt = true;
    const store = createModelStore({
        bakedDir,
        cacheDir,
        fetch: huggingFace(asked, (file) => (corrupt && file === "tokens.txt" ? bytesOf("tokenz") : (SERVED[file] ?? new Uint8Array()))),
        log: () => {},
    });
    await expect(store.ensure(MODEL)).rejects.toThrow("tokens.txt arrived corrupt");
    expect(existsSync(join(cacheDir, "parakeet", "tokens.txt"))).toBe(false);
    expect(existsSync(join(cacheDir, "parakeet", "tokens.txt.part"))).toBe(false);
    const failed = await store.state(MODEL);
    expect(failed.state).toBe("failed");

    corrupt = false;
    expect(await store.ensure(MODEL)).toBe(join(cacheDir, "parakeet"));
    // The encoder that already arrived whole is not fetched a second time.
    expect(asked.map(({ file }) => file)).toEqual(["encoder.int8.onnx", "tokens.txt", "tokens.txt"]);
});

test("a refusal from Hugging Face is a failure with its status, not an empty model", async () => {
    const { bakedDir, cacheDir } = dirs();
    const store = createModelStore({ bakedDir, cacheDir, fetch: async () => new Response("no", { status: 403 }), log: () => {} });
    await expect(store.ensure(MODEL)).rejects.toThrow("Hugging Face answered 403");
    expect(await store.state(MODEL)).toEqual({ state: "failed", error: "encoder.int8.onnx: Hugging Face answered 403" });
});
