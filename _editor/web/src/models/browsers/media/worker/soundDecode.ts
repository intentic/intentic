import { type AudioDecoderLike, closeCodec, type DecodeSeams } from "./decodeSeams";
import type { MediaHello } from "../mediaMessages";

// THE SOUND, IN THE DECODE WORKER: castd's Opus packets through WebCodecs' AudioDecoder, and each decoded packet
// posted, planar float, straight to the audio thread over the port the page handed over (audioWorklet.ts). Nothing is
// decoded while there is no port: the page has not started sound (no gesture yet, muted, or out of sight). A browser
// that refuses the codec outright is not asked again until the next `hello`: castd sends fifty packets a second.

export interface SoundDecode {
    // A `hello`: the sound castd will send, if any; a decoder is built for it at its first packet.
    readonly start: (audio: MediaHello[`audio`]) => void;
    readonly port: (port: MessagePort | undefined) => void;
    readonly push: (payload: Uint8Array) => void;
    readonly close: () => void;
}

// Opus packets are 20 ms or less; a chunk's timestamp only has to rise.
const PACKET_US = 20_000;

export const soundDecode = (seams: Pick<DecodeSeams, `audioDecoder` | `audioChunk`>): SoundDecode => {
    let audio: MediaHello[`audio`];
    let port: MessagePort | undefined;
    let decoder: AudioDecoderLike | undefined;
    let stamp = 0;
    let refused = false;

    const close = (): void => {
        closeCodec(decoder);
        decoder = undefined;
    };
    const failed = (error: DOMException): void => {
        refused ||= error.name === `NotSupportedError`;
        close();
    };

    const pcm = (data: AudioData): void => {
        try {
            if (port === undefined) {
                return;
            }
            const planes: Float32Array<ArrayBuffer>[] = [];
            for (let channel = 0; channel < data.numberOfChannels; channel += 1) {
                const plane = new Float32Array(data.numberOfFrames);
                data.copyTo(plane, { planeIndex: channel, format: `f32-planar` });
                planes.push(plane);
            }
            port.postMessage(
                { planes },
                planes.map((plane) => plane.buffer),
            );
        } finally {
            data.close();
        }
    };

    const ready = (): AudioDecoderLike | undefined => {
        if (decoder !== undefined && decoder.state !== `closed`) {
            return decoder;
        }
        if (audio === undefined || refused) {
            return undefined;
        }
        decoder = seams.audioDecoder({ output: pcm, error: failed });
        decoder?.configure({ codec: audio.codec, sampleRate: audio.sampleRate, numberOfChannels: audio.channels });
        stamp = 0;
        return decoder;
    };

    return {
        start: (next) => {
            close();
            audio = next;
            refused = false;
        },
        port: (next) => {
            port = next;
            if (next === undefined) {
                close();
            }
        },
        push: (payload) => {
            const built = port === undefined ? undefined : ready();
            if (built?.state !== `configured`) {
                return;
            }
            stamp += PACKET_US;
            try {
                built.decode(seams.audioChunk({ type: `key`, timestamp: stamp, data: payload }));
            } catch {
                // A packet refused closes the decoder; the next packet builds another.
                close();
            }
        },
        close,
    };
};
