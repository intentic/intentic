import {
    createSpeechQueue,
    createTranscriber,
    createUpsampler,
    DISCORD_FRAME_BYTES,
    discordFramesOf,
    type SayOutcome,
    type Speak,
    type Transcribe,
    to16kMonoPcm,
    wavOf,
} from "./audio.js";

// 48kHz stereo s16le frames of a constant sample value.
const stereoFrames = (frames: number, value: number): Buffer => {
    const buffer = Buffer.alloc(frames * 4);
    for (let i = 0; i < frames * 2; i += 1) {
        buffer.writeInt16LE(value, i * 2);
    }
    return buffer;
};

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

test("the transcriber hears one utterance at a time, drops blanks, reports lines live, and returns them in speech order", async () => {
    const outputs = ["second utterance", "  ", "first utterance"];
    let active = 0;
    let maxActive = 0;
    const transcribe: Transcribe = async (wav, language) => {
        // The daemon reads a 16 kHz mono WAV, in the connector's configured language.
        expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
        expect(wav.readUInt32LE(24)).toBe(16_000);
        expect(language).toBe("pl");
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 10));
        active -= 1;
        // SAFETY: three utterances are pushed below, one per output.
        return outputs.shift() as string;
    };
    const startedAt = 1_000_000;
    const errors: unknown[] = [];
    const onLineCalls: { sorted: string[]; newLine: string }[] = [];
    const transcriber = createTranscriber(
        transcribe,
        "pl",
        startedAt,
        async (sorted, newLine) => {
            onLineCalls.push({ sorted: sorted.map(({ line }) => line), newLine });
        },
        (error) => errors.push(error),
    );
    // Pushed out of speech order (utterance ends don't arrive chronologically): flush sorts by start.
    transcriber.push("bob", startedAt + 65_000, stereoFrames(6, 1));
    transcriber.push("alice", startedAt + 30_000, stereoFrames(6, 1));
    transcriber.push("alice", startedAt + 5_000, stereoFrames(6, 1));
    const lines = await transcriber.flush();
    expect(maxActive).toBe(1); // one utterance at a time
    expect(errors).toEqual([]);
    expect(lines.map(({ line }) => line)).toEqual(["[00:05] alice: first utterance", "[01:05] bob: second utterance"]);
    expect(transcriber.transcribed()).toBe(2);
    // onLine fires once per transcribed line (never for blanks) with the sorted-so-far transcript.
    expect(onLineCalls.map(({ newLine }) => newLine)).toEqual(["[01:05] bob: second utterance", "[00:05] alice: first utterance"]);
    expect(onLineCalls[1]?.sorted).toEqual(["[00:05] alice: first utterance", "[01:05] bob: second utterance"]);
});

test("the transcriber writes the bot's own words as lines nobody was heard saying, in speech order", async () => {
    const startedAt = 1_000_000;
    const calls: { newLine: string; heard: boolean }[] = [];
    const transcriber = createTranscriber(
        async () => "is the deploy done?",
        undefined,
        startedAt,
        async (_sorted, newLine, heard) => void calls.push({ newLine, heard }),
        (error) => {
            throw error;
        },
    );
    transcriber.push("alice", startedAt + 2_000, stereoFrames(6, 1));
    // An utterance's line breaks are the agent's, not the call's: one line per thing said.
    transcriber.record("intentic", startedAt + 4_000, "Yes,\n  it finished a minute ago. ");
    transcriber.record("intentic", startedAt + 5_000, "   ");
    const lines = await transcriber.flush();
    expect(lines.map(({ line }) => line)).toEqual(["[00:02] alice: is the deploy done?", "[00:04] intentic: Yes, it finished a minute ago."]);
    expect(calls.map(({ heard }) => heard)).toEqual([true, false]);
    // Status counts what the people in the call said, not the bot's answers.
    expect(transcriber.transcribed()).toBe(1);
});

/* SPEAKING INTO THE CALL: the daemon's mono s16le at its own rate, to Discord's 48 kHz stereo, chunk by chunk. */

const monoOf = (samples: readonly number[]): Buffer => {
    const buffer = Buffer.alloc(samples.length * 2);
    samples.forEach((sample, i) => buffer.writeInt16LE(sample, i * 2));
    return buffer;
};

// The left and right sample of every 48 kHz stereo frame.
const framesOf = (stereo: Buffer): [number, number][] =>
    Array.from({ length: stereo.length / 4 }, (_, i) => [stereo.readInt16LE(i * 4), stereo.readInt16LE(i * 4 + 2)]);

const upsampled = (rate: number, chunks: readonly Uint8Array[]): Buffer => {
    const upsampler = createUpsampler(rate);
    return Buffer.concat([...chunks.map((chunk) => upsampler.push(chunk)), upsampler.end()]);
};

// A second of speech-shaped samples, distinct enough that any misplaced byte shows.
const speechSamples = (count: number): number[] =>
    Array.from({ length: count }, (_, i) => Math.round(Math.sin(i / 7) * 9_000 + Math.sin(i / 31) * 4_000) - 37);

test("the upsampler makes 48 kHz from 24 kHz and 22.05 kHz voices, one second in, one second out", () => {
    expect(upsampled(24_000, [monoOf(speechSamples(24_000))]).length).toBe(48_000 * 4);
    expect(upsampled(22_050, [monoOf(speechSamples(22_050))]).length).toBe(48_000 * 4);
    // At 48 kHz already, every sample passes through as it was.
    const same = speechSamples(480);
    expect(framesOf(upsampled(48_000, [monoOf(same)])).map(([left]) => left)).toEqual(same);
});

test("the upsampler writes each sample to both channels, interpolating between them and holding the last", () => {
    const frames = framesOf(upsampled(24_000, [monoOf([0, 1000, -1000])]));
    expect(frames.map(([left]) => left)).toEqual([0, 500, 1000, 0, -1000, -1000]);
    expect(frames.every(([left, right]) => left === right)).toBe(true);
});

test("a chunk boundary anywhere, a split sample included, changes nothing in what comes out", () => {
    const input = monoOf(speechSamples(2_205));
    const whole = upsampled(22_050, [input]);
    // Cuts on odd bytes as well as even ones, and a chunk of a single byte.
    for (const cuts of [[1], [2, 3], [101, 102, 1_000, 3_333], [4_409]]) {
        const edges = [0, ...cuts, input.length];
        const chunks = edges.slice(1).map((end, i) => input.subarray(edges[i], end));
        expect(upsampled(22_050, chunks).equals(whole)).toBe(true);
    }
});

test("a byte that splits a sample waits for its other half, and one left at the end is dropped", () => {
    const upsampler = createUpsampler(48_000);
    // 1000 is 0xe8 0x03 little-endian, arriving a byte at a time.
    expect(upsampler.push(Uint8Array.of(0xe8)).length).toBe(0);
    expect(upsampler.push(Uint8Array.of(0x03, 0x18)).length).toBe(0);
    // -1000 is 0x18 0xfc: its first byte came with the chunk before.
    const out = Buffer.concat([upsampler.push(Uint8Array.of(0xfc, 0x7f)), upsampler.end()]);
    expect(framesOf(out)).toEqual([
        [1000, 1000],
        [-1000, -1000],
    ]);
});

test("discordFramesOf hands the player whole 20 ms frames, the last padded with silence", async () => {
    async function* chunks(): AsyncGenerator<Uint8Array> {
        // 30 ms at 24 kHz, in uneven pieces.
        const input = monoOf(Array.from({ length: 720 }, () => 1_200));
        yield input.subarray(0, 333);
        yield input.subarray(333);
    }
    const frames: Buffer[] = [];
    for await (const frame of discordFramesOf(chunks(), 24_000)) {
        frames.push(Buffer.from(frame));
    }
    expect(frames.map((frame) => frame.length)).toEqual([DISCORD_FRAME_BYTES, DISCORD_FRAME_BYTES]);
    const last = framesOf(frames[1] ?? Buffer.alloc(0));
    // 30 ms is a frame and a half: the second half of the last frame is silence.
    expect(last.slice(0, 480).every(([left, right]) => left === 1_200 && right === 1_200)).toBe(true);
    expect(last.slice(480).every(([left, right]) => left === 0 && right === 0)).toBe(true);
});

/* THE SPEECH QUEUE: one utterance at a time, in order; a stop cuts the one sounding and drops the rest. */

// A speak that sounds at once and lasts until `finish` is called for it, or its signal is aborted.
const heldSpeak = () => {
    const said: string[] = [];
    const finishers = new Map<string, () => void>();
    const speak: Speak = async (text, signal, started) => {
        said.push(text);
        started();
        const { promise, resolve } = Promise.withResolvers<void>();
        finishers.set(text, resolve);
        signal.addEventListener("abort", () => resolve(), { once: true });
        await promise;
    };
    return { speak, said, finish: (text: string) => finishers.get(text)?.() };
};

test("the speech queue says one utterance at a time, in the order asked", async () => {
    const held = heldSpeak();
    const queue = createSpeechQueue(held.speak, (error) => {
        throw error;
    });
    const first = queue.say("one");
    const second = queue.say("two");
    expect([first.ahead, second.ahead]).toEqual([0, 1]);
    expect(await first.begun).toEqual({ kind: "speaking" });
    // "two" waits until "one" has been said.
    expect(held.said).toEqual(["one"]);
    expect(queue.size()).toBe(2);
    held.finish("one");
    expect(await second.begun).toEqual({ kind: "speaking" });
    expect(held.said).toEqual(["one", "two"]);
    held.finish("two");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(queue.size()).toBe(0);
});

test("stop cuts the utterance sounding and drops the ones waiting, which are never said", async () => {
    const held = heldSpeak();
    const queue = createSpeechQueue(held.speak, (error) => {
        throw error;
    });
    queue.say("one");
    const waiting = [queue.say("two"), queue.say("three")];
    expect(queue.stop()).toBe(3);
    const outcomes: SayOutcome[] = await Promise.all(waiting.map(({ begun }) => begun));
    expect(outcomes).toEqual([{ kind: "stopped" }, { kind: "stopped" }]);
    // The next utterance is said once the cut one has wound down, and nothing dropped comes back.
    expect(await queue.say("four").begun).toEqual({ kind: "speaking" });
    expect(held.said).toEqual(["one", "four"]);
});

test("an utterance with nothing to say, or one the voice refused, says why it never sounded", async () => {
    const errors: Error[] = [];
    const queue = createSpeechQueue(async (text) => {
        if (text === "refused") {
            throw new Error("/speech/say returned 501: no speech runtime");
        }
    }, (error) => void errors.push(error));
    expect(await queue.say("```").begun).toEqual({ kind: "silent" });
    expect(await queue.say("refused").begun).toEqual({ kind: "failed", reason: "/speech/say returned 501: no speech runtime" });
    expect(errors.map(({ message }) => message)).toEqual(["/speech/say returned 501: no speech runtime"]);
});
