/* oxlint-disable unicorn/require-post-message-target-origin -- a worklet's MessagePort has no target origin */
import { type AudioReport, AudioRing } from "./audioRing";

// The AudioWorklet that plays a media socket's sound: AudioRing on the audio thread, fed decoded PCM straight from the
// decode worker over a MessagePort of their own, so no sound passes through the page's main thread. Shipped as source
// text through a Blob URL (as the voice capture's worklet is): a worklet module is fetched by URL, and a bundler's
// worker build is no help for a worklet. AudioRing and the processor below are written to stand alone for that.

export const PROCESSOR_NAME = `intentic-media-audio`;

// What the page posts to the processor: the decode worker's end of a channel, or "drop what you hold".
export type ToProcessor = { readonly port: MessagePort } | { readonly flush: true };
// What the decode worker posts on that channel: one decoded packet, planar, one array per channel.
export interface PcmPacket {
    readonly planes: readonly Float32Array[];
}

interface ProcessorPort {
    readonly addEventListener: (type: `message`, listener: (event: MessageEvent<ToProcessor>) => void) => void;
    readonly postMessage: (message: AudioReport) => void;
    readonly start: () => void;
}

interface ProcessorBase {
    readonly port: ProcessorPort;
}

interface ProcessorOptions {
    readonly processorOptions: { readonly channels: number; readonly sampleRate: number };
}

/** The processor as registered: its ring, and the audio thread's call for every 128 frames. */
export interface RingProcessorLike extends ProcessorBase {
    readonly ring: AudioRing;
    process(inputs: readonly Float32Array[][], outputs: Float32Array[][]): boolean;
}

// Run inside AudioWorkletGlobalScope: `Base` is AudioWorkletProcessor, `now` reads its `currentTime`, `register` is
// registerProcessor. Everything it touches arrives as an argument, since its text is all that crosses.
export const defineRingProcessor = (
    Base: new () => ProcessorBase,
    Ring: typeof AudioRing,
    now: () => number,
    register: (name: string, processor: new (options: ProcessorOptions) => RingProcessorLike) => void,
    name: string,
): void => {
    class RingProcessor extends Base implements RingProcessorLike {
        readonly ring: AudioRing;
        reportedAt: number;
        constructor(options: ProcessorOptions) {
            super();
            this.ring = new Ring(options.processorOptions.channels, options.processorOptions.sampleRate);
            this.reportedAt = 0;
            this.port.addEventListener(`message`, (event) => {
                const data = event.data;
                if (`port` in data) {
                    data.port.addEventListener(`message`, (packet: MessageEvent<PcmPacket>) => {
                        const planes = packet.data.planes;
                        this.ring.arrived(now(), planes[0]?.length ?? 0);
                        this.ring.write(planes);
                    });
                    // A port listened to with addEventListener delivers nothing until started.
                    data.port.start();
                } else {
                    this.ring.flush();
                }
            });
            this.port.start();
        }
        process(_inputs: readonly Float32Array[][], outputs: Float32Array[][]): boolean {
            const out = outputs[0];
            if (out !== undefined && out[0] !== undefined) {
                this.ring.read(out, out[0].length);
            }
            if (now() - this.reportedAt >= 0.5) {
                this.reportedAt = now();
                this.port.postMessage(this.ring.report());
            }
            return true;
        }
    }
    register(name, RingProcessor);
};

/** The worklet module's source: the ring, the processor, and the call that registers it. */
export const workletSource = (): string =>
    `(${defineRingProcessor.toString()})(AudioWorkletProcessor, ${AudioRing.toString()}, () => currentTime, registerProcessor, ${JSON.stringify(PROCESSOR_NAME)});`;
