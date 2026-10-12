import { Readable } from "node:stream";
import { createAudioResource, StreamType } from "@discordjs/voice";
import { OpusEncoder } from "mediaplex";
import { discordFramesOf, to16kMonoPcm } from "./audio.js";

// Pins the Opus decoder contract voice.ts assumes: `new OpusEncoder(48000, 2)` and `decode(packet)` returning 48kHz
// stereo s16le Buffers. A native-dependency assumption that breaks silently on an upgrade, not on an edit.

// 20ms at 48kHz stereo: the frame Discord actually sends, and what the receiver hands us packet by packet.
const FRAME_SAMPLES = 960;
const FRAME_BYTES = FRAME_SAMPLES * 2 * 2;

const speechish = (): Buffer => {
    const buffer = Buffer.alloc(FRAME_BYTES);
    for (let i = 0; i < FRAME_SAMPLES; i += 1) {
        for (let channel = 0; channel < 2; channel += 1) {
            // Voiced-vowel shape (fundamental plus two odd harmonics); silence and pure tones a codec handles best.
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

test("decoded frames survive the transcription downmix at the sample rate voice.ts assumes", () => {
    const decoder = new OpusEncoder(48_000, 2);
    const source = packet();
    const pcm = Buffer.concat([decoder.decode(source), decoder.decode(source)]);
    // 48kHz stereo in, 16kHz mono out: two 960-sample stereo frames become 640 mono samples.
    expect(to16kMonoPcm(pcm).length).toBe(640 * 2);
});

test("a corrupt packet throws, which is what voice.ts catches per frame", () => {
    const decoder = new OpusEncoder(48_000, 2);
    // Garbage, not a valid TOC byte; voice.ts's try/catch relies on this throwing rather than returning silence.
    expect(() => decoder.decode(Buffer.from([0xff, 0x00, 0x13]))).toThrow();
});

test("a corrupt frame costs one frame, never the rest of the utterance", () => {
    const decoder = new OpusEncoder(48_000, 2);
    const source = packet();
    expect(decoder.decode(source).length).toBe(FRAME_BYTES);
    try {
        decoder.decode(Buffer.from([0xff, 0x00, 0x13]));
    } catch {
        // Mirrors voice.ts's own catch: the error is swallowed, same as production.
    }
    // Decoder must stay usable after a caught corrupt frame.
    expect(decoder.decode(source).length).toBe(FRAME_BYTES);
});

test("a frame of the bot's speech encodes to one packet that decodes back to a 20ms frame", async () => {
    // Half a second of a 24 kHz voice, as the daemon streams it, to the packets voice.ts plays into the call.
    async function* voice(): AsyncGenerator<Uint8Array> {
        const mono = Buffer.alloc(12_000 * 2);
        for (let i = 0; i < 12_000; i += 1) {
            mono.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 180 * i) / 24_000) * 8_000), i * 2);
        }
        yield mono;
    }
    const encoder = new OpusEncoder(48_000, 2);
    const decoder = new OpusEncoder(48_000, 2);
    const packets: Buffer[] = [];
    for await (const frame of discordFramesOf(voice(), 24_000)) {
        packets.push(encoder.encode(frame));
    }
    expect(packets.length).toBe(25);
    expect(packets.every((encoded) => decoder.decode(encoded).length === FRAME_BYTES)).toBe(true);
});

// voice.ts encodes the bot's speech itself because @discordjs/voice's raw-PCM path reaches for an Opus package
// (@discordjs/opus, opusscript) this tree leaves out; Opus packets go to the player as they are, through no codec.
test("the player takes the bot's Opus packets as they are, with no codec of its own between", () => {
    const resource = createAudioResource(Readable.from([packet()]), { inputType: StreamType.Opus });
    expect(resource.edges).toEqual([]);
});
