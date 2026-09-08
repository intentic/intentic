import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { STATE_DIR } from "@intentic/constants";
import { expect, test } from "vitest";
import { createSpeech, type ExecFn, SpeechModelNotReadyError, SpeechUnprovisionedError, whisperLanguage } from "./transcribe.js";

// Speech engine over its two injected seams (exec, model fetch); the same shape the Discord voice transcriber pins its
// whisper conventions with (_extensions/discord/src/audio.test.ts).

const enoent: ExecFn = () => Promise.reject(Object.assign(new Error("spawn whisper-cli ENOENT"), { code: "ENOENT" }));

// A workspace root, with or without the model already on disk.
const rootWith = (model: boolean): string => {
    const root = mkdtempSync(join(tmpdir(), "speech-test-"));
    if (model) {
        mkdirSync(join(root, STATE_DIR, "local", "cache", "whisper"), { recursive: true });
        writeFileSync(join(root, STATE_DIR, "local", "cache", "whisper", "ggml-large-v3-turbo.bin"), "model bytes");
    }
    return root;
};

const noFetch = (): Promise<Blob | null> => Promise.reject(new Error("must not download"));

// Model bytes arrive under the test's control, mirroring the real download: the fetch resolves quickly, then the stream
// flows for minutes. A Blob handing over all its bytes at once can't show what the browser sees during that window.
const streamingModel = (): { blob: Blob; push: (bytes: number) => void; finish: () => void } => {
    let controller: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({ start: (c) => void (controller = c) });
    return {
        blob: { stream: () => stream } as unknown as Blob,
        push: (bytes) => controller.enqueue(new Uint8Array(bytes)),
        finish: () => controller.close(),
    };
};

// What's on disk in the model's directory, by name: the staged download and the finished model are told apart the same
// way `stat` does in the engine.
const modelDir = (root: string): string => join(root, STATE_DIR, "local", "cache", "whisper");
const bytesOnDisk = (root: string, name: string): number => {
    const found = readdirSync(modelDir(root)).filter((entry) => (name === "model" ? entry === "ggml-large-v3-turbo.bin" : entry.endsWith(".part")));
    return found.reduce((total, entry) => total + statSync(join(modelDir(root), entry)).size, 0);
};

test("whisperLanguage extracts the primary subtag and falls back to auto-detection", () => {
    expect(whisperLanguage("en-US")).toBe("en");
    expect(whisperLanguage("pl")).toBe("pl");
    expect(whisperLanguage("zh-Hans-CN")).toBe("zh");
    // Anything whisper-cli would choke on becomes `auto`, never an accidental English default.
    expect(whisperLanguage(undefined)).toBe("auto");
    expect(whisperLanguage("")).toBe("auto");
    expect(whisperLanguage("x!")).toBe("auto");
});

test("an image without whisper-cli reads unprovisioned and refuses to transcribe", async () => {
    const speech = createSpeech({ workspaceRoot: rootWith(true), log: () => {}, exec: enoent, fetchModel: noFetch });
    expect(await speech.status()).toEqual({ provisioned: false, model: "absent" });
    await expect(speech.transcribe(Buffer.from("RIFF"), "en")).rejects.toBeInstanceOf(SpeechUnprovisionedError);
});

test("a status poll on an absent model starts ONE download and reports ready once it lands", async () => {
    let fetches = 0;
    let release: (blob: Blob | null) => void = () => {};
    const gate = new Promise<Blob | null>((resolve) => (release = resolve));
    const speech = createSpeech({
        workspaceRoot: rootWith(false),
        log: () => {},
        exec: () => Promise.resolve({ stdout: "usage: whisper-cli" }),
        fetchModel: () => {
            fetches += 1;
            return gate;
        },
    });
    // The latch keeps concurrent polls to one download, not one per poll.
    expect(await speech.status()).toEqual({ provisioned: true, model: "downloading" });
    expect(await speech.status()).toEqual({ provisioned: true, model: "downloading" });
    expect(fetches).toBe(1);
    // Transcribing mid-download is answered as "wait," not held open for minutes.
    await expect(speech.transcribe(Buffer.from("RIFF"), "en")).rejects.toBeInstanceOf(SpeechModelNotReadyError);
    release(new Blob(["model bytes"]));
    await expect.poll(async () => (await speech.status()).model).toBe("ready");
});

test("a model still streaming in never reads ready: it takes its place only once whole", async () => {
    const root = rootWith(false);
    const { blob, push, finish } = streamingModel();
    const speech = createSpeech({
        workspaceRoot: root,
        log: () => {},
        exec: () => Promise.resolve({ stdout: "usage: whisper-cli" }),
        fetchModel: () => Promise.resolve(blob),
    });
    expect(await speech.status()).toEqual({ provisioned: true, model: "downloading" });

    // Grown in place, the file would exist from the download's first byte and read as ready, letting the browser record
    // against a half-written model it can only report as "try again".
    push(4096);
    await expect.poll(() => bytesOnDisk(root, "staged")).toBeGreaterThan(0);
    expect(bytesOnDisk(root, "model")).toBe(0);
    expect(await speech.status()).toEqual({ provisioned: true, model: "downloading" });
    await expect(speech.transcribe(Buffer.from("RIFF"), "en")).rejects.toBeInstanceOf(SpeechModelNotReadyError);

    finish();
    await expect.poll(async () => (await speech.status()).model).toBe("ready");
    expect(bytesOnDisk(root, "model")).toBe(4096);
    expect(bytesOnDisk(root, "staged")).toBe(0);
});

test("a failed download does not poison later polls: the next status retries it", async () => {
    let fetches = 0;
    const speech = createSpeech({
        workspaceRoot: rootWith(false),
        log: () => {},
        exec: () => Promise.resolve({ stdout: "usage: whisper-cli" }),
        fetchModel: () => {
            fetches += 1;
            return fetches === 1 ? Promise.reject(new Error("network down")) : Promise.resolve(new Blob(["model bytes"]));
        },
    });
    expect((await speech.status()).model).toBe("downloading");
    await expect.poll(() => fetches).toBe(1);
    await expect.poll(async () => (await speech.status()).model, { timeout: 5000 }).toBe("ready");
    expect(fetches).toBe(2);
});

test("transcribe serializes whisper runs, passes the language explicitly, and answers silence as empty text", async () => {
    // Outputs are keyed by each utterance's own bytes, not call order, since which of two ready calls enters the queue
    // first is the scheduler's call and flips under load. This also pins that each caller gets its own utterance's
    // text, not whichever run finished in its place.
    const outputs: Record<string, string> = { RIFF1: "first words", RIFF2: "[BLANK_AUDIO]" };
    const wavPaths: string[] = [];
    const wavBytes: string[] = [];
    let active = 0;
    let maxActive = 0;
    const exec: ExecFn = async (command, args) => {
        if (args[0] === "--help") {
            return { stdout: "usage: whisper-cli" };
        }
        expect(command).toBe("whisper-cli");
        // whisper-cli defaults to `-l en`; the language must always be passed explicitly.
        expect(args).toContain("-l");
        expect(args[args.indexOf("-l") + 1]).toBe("pl");
        const wavPath = args[args.indexOf("-f") + 1];
        if (wavPath === undefined) {
            throw new Error("whisper-cli was not given an utterance path");
        }
        wavPaths.push(wavPath);
        const spoken = readFileSync(wavPath, "utf8");
        wavBytes.push(spoken);
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 10));
        active -= 1;
        return { stdout: outputs[spoken] as string };
    };
    const speech = createSpeech({ workspaceRoot: rootWith(true), log: () => {}, exec, fetchModel: noFetch });
    const [first, second] = await Promise.all([speech.transcribe(Buffer.from("RIFF1"), "pl-PL"), speech.transcribe(Buffer.from("RIFF2"), "pl-PL")]);
    expect(maxActive).toBe(1);
    expect(first).toBe("first words");
    expect(second).toBe(""); // Noise-only output is "nothing said," not an error.
    expect(wavBytes.toSorted()).toEqual(["RIFF1", "RIFF2"]);
    expect(new Set(wavPaths.map(dirname)).size).toBe(2);
    expect(wavPaths.every((path) => !existsSync(dirname(path)))).toBe(true);
});
