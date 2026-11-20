// The sound's jitter buffer, as the audio thread plays it: silent until it holds its target, then every sample exactly
// as written while it stays near the target, a little faster when it runs long, a jump back when it is far behind,
// silence and a fresh priming when it runs dry; and its own source text, which is all that reaches the AudioWorklet.
import { AudioRing } from "./audioRing";
import { defineRingProcessor, PROCESSOR_NAME, type RingProcessorLike, workletSource } from "./audioWorklet";

// 1 kHz keeps the arithmetic readable: a frame is a millisecond.
const RATE = 1000;
const ramp = (from: number, length: number): Float32Array => Float32Array.from({ length }, (_, at) => from + at);
const read = (ring: AudioRing, frames: number, channels = 1): Float32Array[] => {
    const out = Array.from({ length: channels }, () => new Float32Array(frames));
    ring.read(out, frames);
    return out;
};

it("plays silence until it holds its target, then every sample as written", () => {
    const ring = new AudioRing(1, RATE);
    expect(ring.targetMs()).toBe(40);
    ring.write([ramp(1, 30)]);
    expect([...read(ring, 10)[0]!]).toEqual(Array.from({ length: 10 }, () => 0));
    ring.write([ramp(31, 20)]);
    expect([...read(ring, 10)[0]!]).toEqual([...ramp(1, 10)]);
    expect([...read(ring, 10)[0]!]).toEqual([...ramp(11, 10)]);
    expect(ring.fillMs()).toBe(30);
});

it("goes silent and primes again when it runs dry, and counts it", () => {
    const ring = new AudioRing(1, RATE);
    ring.write([ramp(1, 45)]);
    read(ring, 40);
    expect([...read(ring, 10)[0]!]).toEqual(Array.from({ length: 10 }, () => 0));
    expect(ring.underruns).toBe(1);
    expect(ring.playing).toBe(false);
});

it("plays a little faster while it holds well over its target", () => {
    const ring = new AudioRing(1, RATE);
    ring.write([ramp(0, 90)]);
    expect(ring.ratio()).toBe(1.02);
    const out = read(ring, 50)[0]!;
    // 50 samples read at 2% fast consume 51 frames, interpolated between their neighbours.
    expect(ring.fillMs()).toBe(39);
    expect(out[49]).toBeCloseTo(49 * 1.02, 5);
});

it("jumps back to its target when it is far behind, rather than lagging the picture", () => {
    const ring = new AudioRing(1, RATE);
    ring.write([ramp(0, 300)]);
    read(ring, 1);
    expect(ring.drops).toBe(1);
    // 300 held, 260 over the 40 ms target skipped, then one sample read at the faster pace.
    expect(ring.fillMs()).toBe(39);
});

it("wraps around its capacity without losing a sample, and repeats a mono channel into stereo", () => {
    const ring = new AudioRing(1, RATE);
    ring.write([ramp(0, 900)]);
    ring.skip(860);
    ring.write([ramp(900, 200)]);
    const [left, right] = read(ring, 10, 2);
    // The jump back from 240 ms held drops to the target first: 200 skipped.
    expect([...left!]).toEqual([...right!]);
    expect(ring.count).toBeGreaterThan(0);
    expect(left![0]).toBe(1060);
});

it("raises its target as arrivals turn jittery, and keeps it under its ceiling", () => {
    const ring = new AudioRing(1, 48_000);
    let at = 0;
    for (let packet = 0; packet < 200; packet += 1) {
        // 20 ms packets arriving 40 ms apart then together: 20 ms of jitter each.
        at += packet % 2 === 0 ? 0.04 : 0;
        ring.arrived(at, 960);
    }
    expect(ring.jitterMs).toBeCloseTo(20, 0);
    expect(ring.targetMs()).toBeCloseTo(80, 0);
    for (let packet = 0; packet < 200; packet += 1) {
        at += packet % 2 === 0 ? 0.2 : 0;
        ring.arrived(at, 960);
    }
    expect(ring.targetMs()).toBe(120);
});

it("stands alone as the worklet's source: registered and playing with nothing from this module", () => {
    const registered = new Map<string, unknown>();
    class FakeBase {
        readonly port = { addEventListener: () => undefined, postMessage: () => undefined, start: () => undefined };
    }
    // The worklet runs exactly this text; the test runs it the same way.
    new Function(`AudioWorkletProcessor`, `currentTime`, `registerProcessor`, workletSource())(FakeBase, 0, (name: string, processor: unknown) =>
        registered.set(name, processor),
    );
    expect([...registered.keys()]).toEqual([PROCESSOR_NAME]);
    // And the same factory, run directly, plays what it is fed.
    let made: RingProcessorLike | undefined;
    defineRingProcessor(
        FakeBase,
        AudioRing,
        () => 0,
        (_name, Processor) => {
            made = new Processor({ processorOptions: { channels: 1, sampleRate: RATE } });
        },
        PROCESSOR_NAME,
    );
    made!.ring.write([ramp(1, 50)]);
    const out = [[new Float32Array(4)]];
    expect(made!.process([], out)).toBe(true);
    expect([...out[0]![0]!]).toEqual([1, 2, 3, 4]);
});
