import { framedOpus } from "@intentic/sandbox-contract/schemas/voice";
import { phraseEncoder, utteranceDecoder } from "./opusVoice";

/* The WebCodecs end of Opus on the voice sockets, against stand-ins for the browser's codec that answer later, as the
   real one does: a phrase's packets wait for its begin and are all out by `finish`; an utterance's frame decodes to one
   run of samples at the rate the decoder gave. */

// Each encode answers one packet of a tenth of the samples' count in bytes, a tick later; flush waits for them all.
class FakeEncoder {
    static last: FakeEncoder | undefined;
    state = `unconfigured`;
    private pending: Promise<void> = Promise.resolve();
    constructor(private readonly init: { output: (chunk: { byteLength: number; copyTo: (into: ArrayBuffer) => void }) => void }) {
        FakeEncoder.last = this;
    }
    // Every packet asked for so far is out, without ending the stream as flush would.
    async answered(): Promise<void> {
        await this.pending;
    }
    configure(): void {
        this.state = `configured`;
    }
    encode(data: { numberOfFrames: number }): void {
        const bytes = Math.ceil(data.numberOfFrames / 10);
        this.pending = this.pending.then(async () => {
            await new Promise((resolve) => setTimeout(resolve, 1));
            this.init.output({ byteLength: bytes, copyTo: () => undefined });
        });
    }
    async flush(): Promise<void> {
        await this.pending;
    }
    close(): void {
        this.state = `closed`;
    }
}

// Each packet decodes to 480 samples at 48 kHz, as Chrome's decoder answers whatever rate it was configured at.
class FakeDecoder {
    state = `unconfigured`;
    private queued = 0;
    constructor(private readonly init: { output: (data: object) => void }) {}
    configure(): void {
        this.state = `configured`;
    }
    decode(): void {
        this.queued += 1;
    }
    async flush(): Promise<void> {
        for (; this.queued > 0; this.queued -= 1) {
            this.init.output({ numberOfFrames: 480, sampleRate: 48_000, copyTo: (into: Float32Array) => into.fill(0.25), close: () => undefined });
        }
    }
    close(): void {
        this.state = `closed`;
    }
}

beforeAll(() => {
    Object.assign(globalThis, {
        AudioEncoder: FakeEncoder,
        AudioDecoder: FakeDecoder,
        AudioData: class {
            readonly numberOfFrames: number;
            constructor(init: { numberOfFrames: number }) {
                this.numberOfFrames = init.numberOfFrames;
            }
            close(): void {}
        },
        // What the decoder is handed is the packet; the stand-in reads nothing of it.
        EncodedAudioChunk: class {
            constructor(readonly init: object) {}
        },
    });
});

describe(`a phrase's encoder`, () => {
    it(`holds its packets until its begin is out, then sends them in order, and has sent them all by finish`, async () => {
        const sent: number[] = [];
        const encoder = phraseEncoder((packet) => sent.push(packet.byteLength));
        encoder.push(new Float32Array(3200));
        encoder.push(new Float32Array(1600));
        // Both packets are out of the codec before the begin, however slow the machine: a fixed wait raced them on CI.
        await FakeEncoder.last?.answered();
        expect(sent).toEqual([]);
        encoder.start();
        expect(sent).toEqual([320, 160]);
        encoder.push(new Float32Array(800));
        await encoder.finish();
        expect(sent).toEqual([320, 160, 80]);
    });
});

describe(`an utterance's decoder`, () => {
    it(`recovers from a failed chunk and discards its partial audio before decoding the next`, async () => {
        const original = globalThis.AudioDecoder;
        let fail = true;
        class FailingDecoder extends FakeDecoder {
            override async flush(): Promise<void> {
                await super.flush();
                if (fail) {
                    fail = false;
                    this.state = `closed`;
                    throw new Error(`decoding failed`);
                }
            }
            override close(): void {
                if (this.state === `closed`) {
                    throw new Error(`already closed`);
                }
                super.close();
            }
        }
        Object.assign(globalThis, { AudioDecoder: FailingDecoder });
        const decoder = utteranceDecoder();
        try {
            const frame = framedOpus([new Uint8Array(40)]);
            await expect(decoder.decode(frame, 24_000)).rejects.toThrow(`decoding failed`);
            const decoded = await decoder.decode(frame, 24_000);
            expect(decoded.sampleRate).toBe(48_000);
            expect(decoded.samples.length).toBe(480);
            expect(decoded.samples.every((sample) => sample === 0.25)).toBe(true);
        } finally {
            decoder.close();
            Object.assign(globalThis, { AudioDecoder: original });
        }
    });

    it(`decodes a chunk's packets to one run of samples, at the rate the decoder gave`, async () => {
        const decoder = utteranceDecoder();
        const frame = framedOpus([new Uint8Array(40), new Uint8Array(38), new Uint8Array(41)]);
        const decoded = await decoder.decode(frame, 24_000);
        expect(decoded.sampleRate).toBe(48_000);
        expect(decoded.samples.length).toBe(3 * 480);
        expect(decoded.samples.every((sample) => sample === 0.25)).toBe(true);
        decoder.close();
    });
});
