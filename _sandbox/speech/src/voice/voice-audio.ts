import { sleep } from "@intentic/base/async";
import type { VoiceChunk } from "./cloud-voices.js";

// What a voice's audio becomes on its way out: 16-bit little-endian PCM, one rate for a whole stream, and never further
// ahead of the listener than they could want. Shared by the editor's socket and the HTTP door Discord reads.

/** Float samples as mono s16le bytes. */
export const pcm16 = (samples: Float32Array): Uint8Array<ArrayBuffer> => {
    const bytes = new Uint8Array(samples.length * 2);
    const view = new DataView(bytes.buffer);
    for (let index = 0; index < samples.length; index += 1) {
        const sample = Math.max(-1, Math.min(1, samples[index]!));
        view.setInt16(index * 2, Math.round(sample * 32_767), true);
    }
    return bytes;
};

/** Samples at `from` Hz as `to` Hz, by straight-line interpolation: enough for speech, which is all this carries. */
export const resampled = (samples: Float32Array, from: number, to: number): Float32Array => {
    if (from === to || samples.length === 0) {
        return samples;
    }
    const out = new Float32Array(Math.max(1, Math.round((samples.length * to) / from)));
    const step = from / to;
    for (let index = 0; index < out.length; index += 1) {
        const at = index * step;
        const left = Math.floor(at);
        const right = Math.min(samples.length - 1, left + 1);
        const weight = at - left;
        out[index] = samples[Math.min(left, samples.length - 1)]! * (1 - weight) + samples[right]! * weight;
    }
    return out;
};

// How far audio may run ahead of the clock it would play by. A long reply read aloud is tens of minutes of audio; made
// all at once, it would hold the box's cores for minutes and the listener's memory for a hundred megabytes, for speech
// that a stop would throw away.
const LEAD_SECONDS = 20;

/** The chunks as they come, held back once they are LEAD_SECONDS ahead of playback started at the first one. */
export async function* paced(chunks: AsyncIterable<VoiceChunk>, signal: AbortSignal, lead = LEAD_SECONDS): AsyncGenerator<VoiceChunk> {
    let startedAt: number | undefined;
    let sent = 0;
    for await (const chunk of chunks) {
        startedAt ??= Date.now();
        const ahead = sent - (Date.now() - startedAt) / 1000;
        if (ahead > lead) {
            await sleep((ahead - lead) * 1000, { signal });
        }
        if (signal.aborted) {
            return;
        }
        sent += chunk.samples.length / chunk.sampleRate;
        yield chunk;
    }
}
