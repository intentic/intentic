import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { waitFor } from "@intentic/testing/bun";
import { runWhisper, storeWhisperModel, type WhisperExec, whisperCliMissing } from "./whisper.js";

const enoent: WhisperExec = () => Promise.reject(Object.assign(new Error("spawn whisper-cli ENOENT"), { code: "ENOENT" }));
const present: WhisperExec = () => Promise.resolve({ stdout: "usage: whisper-cli" });
const cranky: WhisperExec = () => Promise.reject(Object.assign(new Error("exit 1"), { code: 1 }));

// Model bytes arrive under the test's control, as a real download's do: the fetch answers at once, the stream flows for minutes.
const streamingModel = (): { blob: Blob; push: (bytes: number) => void; finish: () => void; fail: () => void } => {
    let controller: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({ start: (c) => void (controller = c) });
    return {
        blob: { stream: () => stream } as unknown as Blob,
        push: (bytes) => controller.enqueue(new Uint8Array(bytes)),
        finish: () => controller.close(),
        fail: () => controller.error(new Error("connection reset")),
    };
};

test("whisperCliMissing: only a spawn ENOENT means the binary is absent", async () => {
    expect(await whisperCliMissing(enoent)).toBe(true);
    expect(await whisperCliMissing(present)).toBe(false);
    // A non-zero exit still proves the binary exists.
    expect(await whisperCliMissing(cranky)).toBe(false);
});

test("runWhisper hands whisper-cli the model, a private copy of the WAV and the language, and answers its stdout as printed", async () => {
    const seen: { args: string[]; wav: string; mode: number }[] = [];
    const exec: WhisperExec = async (command, args) => {
        expect(command).toBe("whisper-cli");
        const wavPath = args[args.indexOf("-f") + 1] ?? "";
        seen.push({ args, wav: readFileSync(wavPath, "utf8"), mode: statSync(wavPath).mode & 0o777 });
        return { stdout: " [BLANK_AUDIO]\n" };
    };

    expect(await runWhisper(Buffer.from("RIFF1"), { model: "/models/ggml-medium.bin", language: "pl", exec })).toBe(" [BLANK_AUDIO]\n");
    await runWhisper(Buffer.from("RIFF2"), { model: "/models/ggml-medium.bin", language: "auto", threads: 4, exec });

    const [first, second] = seen;
    expect(first?.args).toEqual(["-m", "/models/ggml-medium.bin", "-f", expect.any(String), "-l", "pl", "--no-timestamps", "--no-prints"]);
    expect(second?.args).toEqual([
        "-m",
        "/models/ggml-medium.bin",
        "-f",
        expect.any(String),
        "-l",
        "auto",
        "-t",
        "4",
        "--no-timestamps",
        "--no-prints",
    ]);
    expect(seen.map(({ wav, mode }) => [wav, mode])).toEqual([
        ["RIFF1", 0o600],
        ["RIFF2", 0o600],
    ]);
    // Each run gets a directory of its own, and none outlives its run.
    const dirs = seen.map(({ args }) => dirname(args[3] ?? ""));
    expect(new Set(dirs).size).toBe(2);
    expect(dirs.filter((dir) => existsSync(dir))).toEqual([]);
});

test("runWhisper removes the WAV when whisper-cli fails, and passes the failure on", async () => {
    let wavPath = "";
    const exec: WhisperExec = async (_command, args) => {
        wavPath = args[args.indexOf("-f") + 1] ?? "";
        throw new Error("whisper-cli crashed");
    };

    await expect(runWhisper(Buffer.from("RIFF"), { model: "/m.bin", language: "en", exec })).rejects.toThrow("whisper-cli crashed");
    expect(basename(wavPath)).toBe("utterance.wav");
    expect(existsSync(dirname(wavPath))).toBe(false);
});

test("storeWhisperModel puts the model in place only once it is whole", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "whisper-")), "cache", "ggml-tiny.bin");
    const { blob, push, finish } = streamingModel();

    const stored = storeWhisperModel(path, blob);
    push(4096);
    await waitFor(() => expect(readdirSync(dirname(path)).filter((name) => name.endsWith(".part"))).toHaveLength(1));
    expect(existsSync(path)).toBe(false);

    finish();
    await stored;
    expect(statSync(path).size).toBe(4096);
    expect(readdirSync(dirname(path))).toEqual(["ggml-tiny.bin"]);
});

test("storeWhisperModel leaves nothing behind when the download breaks off", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "whisper-")), "ggml-tiny.bin");
    const { blob, push, fail } = streamingModel();

    const stored = storeWhisperModel(path, blob);
    push(1024);
    await waitFor(() => expect(readdirSync(dirname(path))).toHaveLength(1));
    fail();

    await expect(stored).rejects.toThrow("connection reset");
    expect(readdirSync(dirname(path))).toEqual([]);
});
