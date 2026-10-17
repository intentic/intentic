import { createRequire } from "node:module";
import { framedOpus } from "@intentic/sandbox-contract/schemas/voice";
import type { OpusEncoder } from "mediaplex";
import { resampled } from "./voice/voice-audio.js";
import { pcm16Samples } from "./wav.js";

// Opus for the voice sockets (schemas/voice.ts): the microphone's phrases decoded as they arrive, a voice's chunks
// encoded on their way out. About a tenth of PCM's bytes, measured with this binding: 16 kHz speech at 24 kbit/s against
// 256, 24 kHz at 33 against 384, a few milliseconds of one core per second of audio. libopus through mediaplex, a
// prebuilt napi binding with no install script. Loaded on first use and never required: a platform it has no binary
// for answers false from opusAvailable, the hello names no codec, and every socket stays PCM.

// The rates Opus takes; a voice at any other (a Piper model's 22050 Hz) is resampled to OUT_RATE first.
const OPUS_RATES: ReadonlySet<number> = new Set([8000, 12_000, 16_000, 24_000, 48_000]);
const OUT_RATE = 24_000;
// One packet per 20 ms, Opus's own default and what WebCodecs encodes the microphone in.
const FRAMES_PER_SECOND = 50;
// For a voice heard through a laptop's speaker: speech stays clear, and it is still a twelfth of the PCM.
const SAY_BITRATE = 32_000;

let binding: typeof import("mediaplex") | null | undefined;

const mediaplex = (): typeof import("mediaplex") | null => {
    if (binding === undefined) {
        try {
            // SAFETY: the module's own type is what `typeof import` names; require returns that module.
            binding = createRequire(import.meta.url)("mediaplex") as typeof import("mediaplex");
        } catch {
            // allow(silent-catch): no binary for this platform is an answer (PCM), not a failure
            binding = null;
        }
    }
    return binding;
};

const codec = (rate: number): OpusEncoder => {
    const loaded = mediaplex();
    if (loaded === null) {
        throw new Error("Opus is not available on this sandbox");
    }
    return new loaded.OpusEncoder(rate, 1);
};

/** Whether this sandbox speaks Opus: what the hello's `voiceCodecs` says. */
export const opusAvailable = (): boolean => mediaplex() !== null;

/** The codings the voice sockets speak besides PCM, for the hello. */
export const voiceCodecs = (): string[] => (opusAvailable() ? ["opus"] : []);

// The samples per channel a packet holds at `rate`, from its TOC byte (RFC 6716, section 3.1): the frame duration its
// configuration names, times the frames its code says it carries. The binding's decode answers a buffer sized for two
// channels whatever it decoded into, so this is how much of it is audio.
const packetSamples = (packet: Uint8Array, rate: number): number => {
    const toc = packet[0] ?? 0;
    const config = toc >> 3;
    const durationMs = config < 12 ? [10, 20, 40, 60][config % 4]! : config < 16 ? [10, 20][config % 2]! : [2.5, 5, 10, 20][config % 4]!;
    const code = toc & 3;
    const frames = code === 0 ? 1 : code === 3 ? (packet[1] ?? 0) & 0x3f : 2;
    return Math.round((frames * durationMs * rate) / 1000);
};

/** One phrase's decoder: each packet the microphone sent, as samples at `rate`. */
export const opusDecoder = (rate: number): ((packet: Uint8Array) => Float32Array) => {
    const decoder = codec(rate);
    return (packet) => {
        const pcm = decoder.decode(Buffer.from(packet.buffer, packet.byteOffset, packet.byteLength));
        return pcm16Samples(pcm.subarray(0, Math.min(pcm.byteLength, packetSamples(packet, rate) * 2)));
    };
};

export interface OpusChunk {
    readonly sampleRate: number;
    // The samples it carries before the last packet was padded out to 20 ms.
    readonly samples: number;
    // Its packets as one frame (framedOpus).
    readonly frame: Uint8Array<ArrayBuffer>;
}

/**
 * One utterance's encoder: each chunk of a voice's samples as Opus packets, one stream per sample rate so a reply that
 * falls back to another voice mid-way starts a fresh one. The last packet of a chunk is padded with silence to a whole
 * 20 ms, a gap no listener hears between two sentences.
 */
export const opusEncoder = (): ((samples: Float32Array, sampleRate: number) => OpusChunk) => {
    let current: { readonly rate: number; readonly encoder: OpusEncoder } | undefined;
    return (samples, sampleRate) => {
        const rate = OPUS_RATES.has(sampleRate) ? sampleRate : OUT_RATE;
        if (current?.rate !== rate) {
            const encoder = codec(rate);
            encoder.setBitrate(SAY_BITRATE);
            current = { rate, encoder };
        }
        const pcm = resampled(samples, sampleRate, rate);
        const frame = rate / FRAMES_PER_SECOND;
        const packets: Uint8Array[] = [];
        for (let at = 0; at < pcm.length; at += frame) {
            const block = Buffer.alloc(frame * 2);
            const part = pcm.subarray(at, at + frame);
            for (let index = 0; index < part.length; index += 1) {
                block.writeInt16LE(Math.round(Math.max(-1, Math.min(1, part[index]!)) * 32_767), index * 2);
            }
            packets.push(current.encoder.encode(block));
        }
        return { sampleRate: rate, samples: pcm.length, frame: framedOpus(packets) };
    };
};
