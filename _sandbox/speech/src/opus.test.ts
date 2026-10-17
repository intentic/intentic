import { opusPackets } from "@intentic/sandbox-contract/schemas/voice";
import { opusAvailable, opusChunks, opusDecoder, opusEncoder, voiceCodecs } from "./opus.js";

// A voice's chunks out as Opus packets and the microphone's packets in, through libopus: about a tenth of the PCM's
// bytes, back to audio that is the same speech.

const tone = (rate: number, seconds: number): Float32Array =>
    Float32Array.from(
        { length: rate * seconds },
        (_, index) => 0.3 * Math.sin((2 * Math.PI * 220 * index) / rate) * (0.6 + 0.4 * Math.sin(index / rate)),
    );

const energy = (samples: Float32Array): number => Math.sqrt(samples.reduce((sum, sample) => sum + sample * sample, 0) / Math.max(1, samples.length));

test("the hello names opus, since this sandbox has the binding", () => {
    expect(opusAvailable()).toBe(true);
    expect(voiceCodecs()).toEqual(["opus"]);
});

test("a 24 kHz chunk leaves as 20 ms packets at about a twelfth of its PCM, and decodes to the same speech", () => {
    const encode = opusEncoder();
    const samples = tone(24_000, 2);
    const chunk = encode(samples, 24_000);
    expect(chunk.sampleRate).toBe(24_000);
    expect(chunk.samples).toBe(samples.length);
    const packets = opusPackets(chunk.frame);
    expect(packets).toHaveLength(100);
    expect(chunk.frame.byteLength).toBeLessThan((samples.length * 2) / 8);
    const decode = opusDecoder(24_000);
    const decoded = Float32Array.from(packets.flatMap((packet) => [...decode(packet)]));
    expect(decoded.length).toBe(samples.length);
    expect(Math.abs(energy(decoded) - energy(samples)) / energy(samples)).toBeLessThan(0.15);
});

test("a voice at a rate Opus does not take is resampled to 24 kHz, and a chunk short of a packet is padded to one", () => {
    const encode = opusEncoder();
    const chunk = encode(tone(22_050, 2).subarray(0, 22_050 + 100), 22_050);
    expect(chunk.sampleRate).toBe(24_000);
    // 1 s and a bit at 24 kHz: 50 whole packets and one padded.
    expect(opusPackets(chunk.frame)).toHaveLength(51);
});

test("streaming chunks leave as soon as a packet is whole, and the final partial packet is sent", async () => {
    const samples = tone(24_000, 1);
    let received = 0;
    async function* source() {
        for (const part of [samples.subarray(0, 100), samples.subarray(100, 480), samples.subarray(480, 481)]) {
            received += 1;
            yield { samples: part, sampleRate: 24_000 };
        }
    }
    const chunks = opusChunks(source());
    const first = await chunks.next();
    if (first.done) {
        throw new Error("the full packet was never sent");
    }
    expect(received).toBe(2);
    expect(first.value.samples).toBe(480);
    expect(first.value.sampleRate).toBe(24_000);
    const last = await chunks.next();
    if (last.done) {
        throw new Error("the partial packet was never sent");
    }
    expect(last.value.samples).toBe(1);
    expect(last.value.sampleRate).toBe(24_000);
    const decode = opusDecoder(24_000);
    expect(opusPackets(first.value.frame).reduce((total, packet) => total + decode(packet).length, 0)).toBe(480);
    expect(opusPackets(last.value.frame).reduce((total, packet) => total + decode(packet).length, 0)).toBe(480);
    expect((await chunks.next()).done).toBe(true);
});

test("a rate change sends the previous voice's partial packet before the new voice's audio", async () => {
    async function* source() {
        yield { samples: tone(24_000, 1).subarray(0, 100), sampleRate: 24_000 };
        yield { samples: tone(16_000, 1).subarray(0, 320), sampleRate: 16_000 };
    }
    const chunks = [];
    for await (const chunk of opusChunks(source())) {
        chunks.push({ sampleRate: chunk.sampleRate, samples: chunk.samples, packets: opusPackets(chunk.frame).length });
    }
    expect(chunks).toEqual([
        { sampleRate: 24_000, samples: 100, packets: 1 },
        { sampleRate: 16_000, samples: 320, packets: 1 },
    ]);
});
