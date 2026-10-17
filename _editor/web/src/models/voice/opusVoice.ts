import { opusPackets } from "@intentic/sandbox-contract/schemas/voice";
import { daemonSpeaksOpus } from "../../client/sandbox/daemon/voiceCodecs";

// Opus on the voice sockets (schemas/voice.ts), through the browser's own codec (WebCodecs): the microphone's phrases
// leave as 20 ms packets at 24 kbit/s instead of 256 kbit/s of PCM, and a reply read aloud arrives at a twelfth of its
// PCM. Only where both ends can: the daemon's hello names opus (voiceCodecs), and this browser encodes and decodes it
// (WebKit's WebCodecs audio is recent and partial, so it is asked, never assumed). Anywhere else the sockets stay PCM.

// The microphone's audio is resampled to 16 kHz before it gets here (voiceAudio.ts), which is what the daemon hears at.
const MIC_RATE = 16_000;
const MIC_CONFIG = { codec: `opus`, sampleRate: MIC_RATE, numberOfChannels: 1, bitrate: 24_000 } satisfies AudioEncoderConfig;
// What the daemon's voices mostly arrive at; a decoder for another rate is configured when one comes.
const SAY_RATE = 24_000;
// The 20 ms each packet holds, on the timestamps WebCodecs wants; Opus's own clock is in its packets.
const PACKET_US = 20_000;

let probed: Promise<boolean> | undefined;

/** Whether this browser encodes the microphone's and decodes a voice's Opus, as the sockets use it. */
const opusInBrowser = (): Promise<boolean> => {
    probed ??= (async () => {
        if (!(`AudioEncoder` in globalThis) || !(`AudioDecoder` in globalThis)) {
            return false;
        }
        try {
            const [encoding, decoding] = await Promise.all([
                AudioEncoder.isConfigSupported(MIC_CONFIG),
                AudioDecoder.isConfigSupported({ codec: `opus`, sampleRate: SAY_RATE, numberOfChannels: 1 }),
            ]);
            return encoding.supported === true && decoding.supported === true;
        } catch {
            // allow(silent-catch): a config the browser cannot even judge is one it cannot run; the sockets stay PCM
            return false;
        }
    })();
    return probed;
};

/** Whether the voice sockets should ask for Opus: both ends speak it. */
export const voiceOpus = async (): Promise<boolean> => daemonSpeaksOpus() && (await opusInBrowser());

/** One phrase's encoder. Packets are held until `start`, so a phrase's audio never leaves before its `begin`. */
export interface PhraseEncoder {
    readonly push: (samples: Float32Array) => void;
    readonly start: () => void;
    /** Every packet of what was pushed has been handed to `send`. */
    readonly finish: () => Promise<void>;
    readonly close: () => void;
}

export const phraseEncoder = (send: (packet: ArrayBuffer) => void): PhraseEncoder => {
    const held: ArrayBuffer[] = [];
    let started = false;
    let timestamp = 0;
    const encoder = new AudioEncoder({
        output: (chunk) => {
            const packet = new ArrayBuffer(chunk.byteLength);
            chunk.copyTo(packet);
            if (started) {
                send(packet);
            } else {
                held.push(packet);
            }
        },
        // A phrase whose encoding fails ends short: what reached the daemon is heard, and its final says what that was.
        error: () => undefined,
    });
    encoder.configure(MIC_CONFIG);
    return {
        push: (samples) => {
            if (encoder.state !== `configured` || samples.length === 0) {
                return;
            }
            // A copy: AudioData takes a buffer of its own, and the segmenter's frames may be views into a shared one.
            const data = new AudioData({
                format: `f32`,
                sampleRate: MIC_RATE,
                numberOfFrames: samples.length,
                numberOfChannels: 1,
                timestamp,
                data: new Float32Array(samples),
            });
            timestamp += (samples.length * 1_000_000) / MIC_RATE;
            encoder.encode(data);
            data.close();
        },
        start: () => {
            started = true;
            for (const packet of held.splice(0)) {
                send(packet);
            }
        },
        finish: async () => {
            if (encoder.state === `configured`) {
                await encoder.flush();
                encoder.close();
            }
        },
        close: () => {
            if (encoder.state !== `closed`) {
                encoder.close();
            }
        },
    };
};

/** One utterance's decoder: each chunk's frame of packets as samples, a fresh stream when the rate changes. */
export interface UtteranceDecoder {
    readonly decode: (frame: Uint8Array, sampleRate: number) => Promise<{ readonly samples: Float32Array; readonly sampleRate: number }>;
    readonly close: () => void;
}

export const utteranceDecoder = (): UtteranceDecoder => {
    let decoder: AudioDecoder | undefined;
    let rate = 0;
    let timestamp = 0;
    const decoded: AudioData[] = [];
    const close = (): void => {
        if (decoder !== undefined && decoder.state !== `closed`) {
            decoder.close();
        }
        for (const data of decoded.splice(0)) {
            data.close();
        }
    };
    const opened = (sampleRate: number): AudioDecoder => {
        if (decoder !== undefined && decoder.state === `configured` && rate === sampleRate) {
            return decoder;
        }
        close();
        rate = sampleRate;
        const next = new AudioDecoder({ output: (data) => decoded.push(data), error: () => undefined });
        next.configure({ codec: `opus`, sampleRate, numberOfChannels: 1 });
        decoder = next;
        return next;
    };
    return {
        decode: async (frame, sampleRate) => {
            const into = opened(sampleRate);
            for (const packet of opusPackets(frame)) {
                into.decode(new EncodedAudioChunk({ type: `key`, timestamp, data: packet }));
                timestamp += PACKET_US;
            }
            await into.flush();
            const parts = decoded.splice(0);
            const samples = new Float32Array(parts.reduce((total, data) => total + data.numberOfFrames, 0));
            let at = 0;
            let outRate = sampleRate;
            for (const data of parts) {
                const part = new Float32Array(data.numberOfFrames);
                data.copyTo(part, { planeIndex: 0, format: `f32-planar` });
                samples.set(part, at);
                at += part.length;
                outRate = data.sampleRate;
                data.close();
            }
            return { samples, sampleRate: outRate };
        },
        close,
    };
};
