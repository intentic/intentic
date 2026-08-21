import { OpusEncoder } from "mediaplex";
import { expect, test } from "vitest";
import { to16kMonoPcm } from "./audio.js";

/* The Opus decoder contract voice.ts depends on, pinned here because nothing else does.
 *
 * voice.ts uses exactly two things from the binding: `new OpusEncoder(48_000, 2)` and `decode(packet)`, and
 * feeds the result straight into Buffer.concat and then to16kMonoPcm, which reads it as 48kHz stereo s16le. All
 * three of those are assumptions about a native dependency rather than about our own code, so they break on an
 * upgrade rather than on an edit, and they break in the one place we have no test coverage: a live voice call.
 * That is what this file is for. It replaced @discordjs/opus, whose installer compiled or unpacked a binary at
 * install time; the receive path is identical, and these are the properties that had to stay identical with it. */

// 20ms at 48kHz stereo: the frame Discord actually sends, and what the receiver hands us packet by packet.
const FRAME_SAMPLES = 960;
const FRAME_BYTES = FRAME_SAMPLES * 2 * 2;

const speechish = (): Buffer => {
    const buffer = Buffer.alloc(FRAME_BYTES);
    for (let i = 0; i < FRAME_SAMPLES; i += 1) {
        for (let channel = 0; channel < 2; channel += 1) {
            // A voiced-vowel shape (fundamental plus two odd harmonics) rather than a tone: silence and pure
            // sines are the two inputs a codec is least likely to get wrong.
            const value =
                (Math.sin((2 * Math.PI * 130 * i) / 48_000) * 0.6 +
                    Math.sin((2 * Math.PI * 390 * i) / 48_000) * 0.25 +
                    Math.sin((2 * Math.PI * 650 * i) / 48_000) * 0.15) *
                11_000;
            buffer.writeInt16LE(Math.round(value), (i * 2 + channel) * 2);
        }
    }
    return buffer;
};

const packet = (): Buffer => new OpusEncoder(48_000, 2).encode(speechish());

test("decode returns one 20ms 48kHz stereo PCM frame as a Buffer", () => {
    const pcm = new OpusEncoder(48_000, 2).decode(packet());
    // Buffer, not Uint8Array: voice.ts collects these with Buffer.concat.
    expect(Buffer.isBuffer(pcm)).toBe(true);
    expect(pcm.length).toBe(FRAME_BYTES);
});

test("decoded frames survive the whisper downmix at the sample rate voice.ts assumes", () => {
    const decoder = new OpusEncoder(48_000, 2);
    const source = packet();
    const pcm = Buffer.concat([decoder.decode(source), decoder.decode(source)]);
    // 48kHz stereo in, 16kHz mono out: two frames of 960 stereo samples become 640 mono samples.
    expect(to16kMonoPcm(pcm).length).toBe(640 * 2);
});

test("a corrupt packet throws, which is what voice.ts catches per frame", () => {
    const decoder = new OpusEncoder(48_000, 2);
    // Garbage that is not a valid TOC byte. voice.ts wraps decode in try/catch precisely for this, so if the
    // binding ever started returning silence instead of throwing, a corrupt frame would go in as real audio.
    expect(() => decoder.decode(Buffer.from([0xff, 0x00, 0x13]))).toThrow();
});

test("a corrupt frame costs one frame, never the rest of the utterance", () => {
    const decoder = new OpusEncoder(48_000, 2);
    const source = packet();
    expect(decoder.decode(source).length).toBe(FRAME_BYTES);
    try {
        decoder.decode(Buffer.from([0xff, 0x00, 0x13]));
    } catch {
        // Exactly what voice.ts does with it.
    }
    // The decoder is still usable afterwards: the claim the comment in voice.ts makes.
    expect(decoder.decode(source).length).toBe(FRAME_BYTES);
});
