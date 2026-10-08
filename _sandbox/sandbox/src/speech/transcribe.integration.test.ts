import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STATE_DIR } from "@intentic/constants";
import { waitFor } from "@intentic/testing/bun";
import type { SpeechEngine } from "@intentic/sandbox-contract";
import type { FetchLike } from "./model-store.js";
import type { SpeechProcess } from "./speech-engine.js";
import type { RecognizerSpec } from "./speech-recognizers.js";
import { SPEECH_MODELS } from "./speech-models.js";
import { createSpeech, type SpeechDeps, SpeechModelNotReadyError, SpeechUnprovisionedError, spokenText } from "./transcribe.js";

/* The dictation facade over its seams: a fake speech process standing in for the models, a fake Hugging Face, and a
   real disk. What it pins is the routing (which model hears which locale), where a model is looked for, how its
   readiness is told, and what of a model's output counts as words. */

// A process that "hears" whatever its test says, and records what it was asked with.
const fakeProcess = (heard: (spec: RecognizerSpec, samples: Float32Array) => string = () => "words") => {
    const asked: { readonly kind: "load" | "decode"; readonly spec: RecognizerSpec }[] = [];
    const inMemory = new Set<SpeechEngine>();
    const make = (onChange: () => void): SpeechProcess => ({
        load: async (spec) => {
            asked.push({ kind: "load", spec });
            inMemory.add(spec.engine);
            onChange();
        },
        decode: async (spec, samples) => {
            asked.push({ kind: "decode", spec });
            inMemory.add(spec.engine);
            return heard(spec, samples);
        },
        loaded: (engine) => inMemory.has(engine),
        busy: () => false,
        close: () => inMemory.clear(),
    });
    return { asked, make };
};

// A baked image directory holding the named engines' files, at their pinned sizes (the store checks only size there).
const bakedWith = (...engines: SpeechEngine[]): string => {
    const dir = mkdtempSync(join(tmpdir(), "speech-baked-"));
    for (const engine of engines) {
        mkdirSync(join(dir, engine), { recursive: true });
        for (const file of SPEECH_MODELS[engine].files) {
            writeFileSync(join(dir, engine, file.path), Buffer.alloc(file.size));
        }
    }
    return dir;
};

const noFetch: FetchLike = () => Promise.reject(new Error("must not download"));

const speechWith = (overrides: Partial<SpeechDeps> & { readonly process: NonNullable<SpeechDeps["process"]> }) =>
    createSpeech({
        workspaceRoot: mkdtempSync(join(tmpdir(), "speech-root-")),
        log: () => {},
        bakedDir: bakedWith("parakeet"),
        fetch: noFetch,
        provisioned: () => true,
        ...overrides,
    });

// A minimal 16 kHz mono s16le WAV of `samples` silent samples.
const wav = (samples: number): Buffer => {
    const header = Buffer.alloc(44);
    header.write("RIFF", 0);
    header.writeUInt32LE(36 + samples * 2, 4);
    header.write("WAVE", 8);
    header.write("fmt ", 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(1, 22);
    header.writeUInt32LE(16_000, 24);
    header.writeUInt32LE(32_000, 28);
    header.writeUInt16LE(2, 32);
    header.writeUInt16LE(16, 34);
    header.write("data", 36);
    header.writeUInt32LE(samples * 2, 40);
    return Buffer.concat([header, Buffer.alloc(samples * 2)]);
};

test("Parakeet hears its 25 languages and anything unreadable; Whisper hears the rest, held to the asked language", async () => {
    const fake = fakeProcess();
    const speech = speechWith({ process: fake.make, bakedDir: bakedWith("parakeet", "whisper") });
    for (const locale of ["pl-PL", "en-US", "de", "uk-UA", undefined, "", "*"]) {
        await speech.hear(new Float32Array(16), locale);
    }
    await speech.hear(new Float32Array(16), "ja-JP");
    await speech.hear(new Float32Array(16), "zh-Hans-CN");
    expect(fake.asked.map(({ spec }) => [spec.engine, spec.language])).toEqual([
        ...Array.from({ length: 7 }, () => ["parakeet", undefined]),
        ["whisper", "ja"],
        ["whisper", "zh"],
    ]);
    // Each from its own baked directory, on a bounded share of the cores.
    expect(fake.asked[0]?.spec.dir.endsWith("/parakeet")).toBe(true);
    expect(fake.asked[7]?.spec.dir.endsWith("/whisper")).toBe(true);
    expect(fake.asked.every(({ spec }) => spec.threads >= 1 && spec.threads <= 4)).toBe(true);
});

test("a baked model is ready at once, and loaded only once something asked for it", async () => {
    const fake = fakeProcess();
    const speech = speechWith({ process: fake.make });
    expect(await speech.status("pl-PL")).toEqual({ provisioned: true, model: "ready", engine: "parakeet", loaded: false });
    expect(await speech.prepare("pl-PL")).toMatchObject({ model: "ready", engine: "parakeet" });
    await waitFor(() => expect(fake.asked).toEqual([{ kind: "load", spec: expect.objectContaining({ engine: "parakeet" }) }]));
    expect(await speech.status("pl-PL")).toMatchObject({ model: "ready", loaded: true });
});

test("an absent model starts fetching on the first status, tells its progress, and the transcribe door says wait meanwhile", async () => {
    const tokens = Buffer.from("t");
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    // Whisper is not baked: its files come from a Hugging Face that holds the answer until the test lets it go, and
    // answers bytes the digest check will refuse, which is fine here: the test is about the waiting.
    const fetchHeld: FetchLike = async () => {
        await gate;
        return new Response(tokens, { status: 200 });
    };
    const fake = fakeProcess();
    const speech = speechWith({ process: fake.make, fetch: fetchHeld });
    const changes: number[] = [];
    speech.subscribe(() => changes.push(Date.now()));
    expect(await speech.status("ja")).toMatchObject({ model: "downloading", engine: "whisper", received: 0, total: expect.any(Number) });
    await waitFor(async () => expect(await speech.status("ja")).toMatchObject({ model: "downloading", received: 0 }));
    await expect(speech.transcribe(wav(160), "ja")).rejects.toBeInstanceOf(SpeechModelNotReadyError);
    release();
    await waitFor(async () => expect((await speech.status("ja")).model).toBe("failed"));
    expect((await speech.status("ja")).error).toContain("arrived corrupt");
    expect(changes.length).toBeGreaterThan(0);
    // A failed fetch is not re-armed by every poll: retrying is the person's call (prepare), not a loop.
    expect((await speech.status("ja")).model).toBe("failed");
});

test("the WAV door reads the utterance's samples and answers the model's words", async () => {
    let heardSamples = 0;
    const fake = fakeProcess((_spec, samples) => {
        heardSamples = samples.length;
        return "  dzień   dobry ";
    });
    const speech = speechWith({ process: fake.make });
    expect(await speech.transcribe(wav(1600), "pl")).toBe("dzień dobry");
    expect(heardSamples).toBe(1600);
});

test("a machine sherpa-onnx ships no binary for is unprovisioned, said on status and refused on transcribe", async () => {
    const fake = fakeProcess();
    const speech = speechWith({ process: fake.make, provisioned: () => false });
    expect(await speech.status("en")).toEqual({ provisioned: false, model: "absent", engine: "parakeet" });
    await expect(speech.transcribe(wav(16), "en")).rejects.toBeInstanceOf(SpeechUnprovisionedError);
    expect(fake.asked).toEqual([]);
});

test("whisper.cpp's retired model directory is cleared away", async () => {
    const root = mkdtempSync(join(tmpdir(), "speech-root-"));
    const old = join(root, STATE_DIR, "local", "cache", "whisper");
    mkdirSync(old, { recursive: true });
    writeFileSync(join(old, "ggml-large-v3-turbo.bin"), "old model");
    createSpeech({
        workspaceRoot: root,
        log: () => {},
        bakedDir: bakedWith("parakeet"),
        fetch: noFetch,
        provisioned: () => true,
        process: fakeProcess().make,
    });
    await waitFor(() => expect(existsSync(old)).toBe(false));
});

test("words are what the model wrote, less Whisper's narration of silence and its phantom sign-offs", () => {
    expect(spokenText("parakeet", "  Dodaj   test. ")).toBe("Dodaj test.");
    // Parakeet writes no narration, so a bracket from it is something the person said.
    expect(spokenText("parakeet", "[uwaga]")).toBe("[uwaga]");
    expect(spokenText("whisper", "[BLANK_AUDIO]")).toBe("");
    expect(spokenText("whisper", " (music) ")).toBe("");
    expect(spokenText("whisper", "Dziękuje za oglądanie.")).toBe("");
    expect(spokenText("whisper", "Thanks for watching!")).toBe("");
    expect(spokenText("whisper", "(music) Hello there")).toBe("Hello there");
    expect(spokenText("whisper", "Thanks for watching the build, it passed")).toBe("Thanks for watching the build, it passed");
});

test("the pinned model files are the ones the recognizer config names", () => {
    const names = (engine: SpeechEngine) => SPEECH_MODELS[engine].files.map((file) => file.path).toSorted();
    expect(names("parakeet")).toEqual(["decoder.int8.onnx", "encoder.int8.onnx", "joiner.int8.onnx", "tokens.txt"]);
    expect(names("whisper")).toEqual(["turbo-decoder.int8.onnx", "turbo-encoder.int8.onnx", "turbo-tokens.txt"]);
    for (const model of Object.values(SPEECH_MODELS)) {
        expect(model.revision).toMatch(/^[0-9a-f]{40}$/u);
        expect(model.files.every((file) => /^[0-9a-f]{64}$/u.test(file.sha256))).toBe(true);
    }
    expect(createHash("sha256").update("").digest("hex")).not.toBe(SPEECH_MODELS.parakeet.files[0]?.sha256);
});
