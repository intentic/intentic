import { expect, test } from "vitest";
import { cleanTranscription, createTranscriber, type ExecFn, to16kMonoPcm, wavOf, WHISPER_MISSING, whisperCliMissing } from "./audio.js";

// 48kHz stereo s16le frames of a constant sample value.
const stereoFrames = (frames: number, value: number): Buffer => {
    const buffer = Buffer.alloc(frames * 4);
    for (let i = 0; i < frames * 2; i += 1) {
        buffer.writeInt16LE(value, i * 2);
    }
    return buffer;
};

const enoent: ExecFn = () => Promise.reject(Object.assign(new Error("spawn whisper-cli ENOENT"), { code: "ENOENT" }));
const present: ExecFn = () => Promise.resolve({ stdout: "usage: whisper-cli" });
const cranky: ExecFn = () => Promise.reject(Object.assign(new Error("exit 1"), { code: 1 }));

test("whisperCliMissing: only a spawn ENOENT means the binary is absent", async () => {
    expect(await whisperCliMissing(enoent)).toBe(true);
    expect(await whisperCliMissing(present)).toBe(false);
    // A non-zero exit still proves the binary exists.
    expect(await whisperCliMissing(cranky)).toBe(false);
    // The guidance routes the agent to the owner-run rebuild (the fragment is already composed) instead of
    // proposing an overlay itself.
    expect(WHISPER_MISSING).toContain("Environment card");
    expect(WHISPER_MISSING).toContain("rebuild");
});

test("to16kMonoPcm downmixes stereo and decimates 3:1", () => {
    const pcm = to16kMonoPcm(stereoFrames(6, 1000));
    expect(pcm.length).toBe(4); // 6 input frames → 2 mono samples
    expect(pcm.readInt16LE(0)).toBe(1000);
    expect(pcm.readInt16LE(2)).toBe(1000);
    // A trailing partial group is dropped, not misread.
    expect(to16kMonoPcm(stereoFrames(7, 1)).length).toBe(4);
});

test("wavOf emits a valid 16kHz mono s16le RIFF header", () => {
    const data = Buffer.alloc(3200);
    const wav = wavOf(data);
    expect(wav.length).toBe(44 + data.length);
    expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
    expect(wav.toString("ascii", 8, 12)).toBe("WAVE");
    expect(wav.readUInt16LE(22)).toBe(1); // mono
    expect(wav.readUInt32LE(24)).toBe(16_000);
    expect(wav.readUInt16LE(34)).toBe(16); // bits per sample
    expect(wav.readUInt32LE(40)).toBe(data.length);
});

test("cleanTranscription flattens whisper output and drops noise-only annotations", () => {
    expect(cleanTranscription(" Hello there.\n General Kenobi.\n")).toBe("Hello there. General Kenobi.");
    expect(cleanTranscription(" [BLANK_AUDIO]\n")).toBeUndefined();
    expect(cleanTranscription("(wind blowing)")).toBeUndefined();
    expect(cleanTranscription("")).toBeUndefined();
    expect(cleanTranscription("[music] \nreal words")).toBe("real words");
});

test("the transcriber serializes whisper runs, drops blanks, reports lines live, and returns them in speech order", async () => {
    const outputs = ["second utterance", "[BLANK_AUDIO]", "first utterance"];
    let active = 0;
    let maxActive = 0;
    const exec: ExecFn = async (command, args) => {
        expect(command).toBe("whisper-cli");
        expect(args.slice(0, 2)).toEqual(["-m", "/model.bin"]);
        // whisper-cli defaults to -l en: the language must always be passed explicitly.
        expect(args.slice(4, 6)).toEqual(["-l", "pl"]);
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 10));
        active -= 1;
        return { stdout: outputs.shift() as string };
    };
    const startedAt = 1_000_000;
    const errors: unknown[] = [];
    const onLineCalls: { sorted: string[]; newLine: string }[] = [];
    const transcriber = createTranscriber(
        "/model.bin",
        "pl",
        startedAt,
        async (sorted, newLine) => {
            onLineCalls.push({ sorted: sorted.map(({ line }) => line), newLine });
        },
        (error) => errors.push(error),
        exec,
    );
    // Pushed out of speech order (utterance ends don't arrive chronologically): flush sorts by start.
    transcriber.push("bob", startedAt + 65_000, stereoFrames(6, 1));
    transcriber.push("alice", startedAt + 30_000, stereoFrames(6, 1));
    transcriber.push("alice", startedAt + 5_000, stereoFrames(6, 1));
    const lines = await transcriber.flush();
    expect(maxActive).toBe(1); // one whisper-cli at a time
    expect(errors).toEqual([]);
    expect(lines.map(({ line }) => line)).toEqual(["[00:05] alice: first utterance", "[01:05] bob: second utterance"]);
    expect(transcriber.transcribed()).toBe(2);
    // onLine fires once per transcribed line (never for blanks) with the sorted-so-far transcript.
    expect(onLineCalls.map(({ newLine }) => newLine)).toEqual(["[01:05] bob: second utterance", "[00:05] alice: first utterance"]);
    expect(onLineCalls[1]?.sorted).toEqual(["[00:05] alice: first utterance", "[01:05] bob: second utterance"]);
});
