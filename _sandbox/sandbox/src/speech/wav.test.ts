import { pcm16Samples, resampleTo16k, WavFormatError, wavSamples } from "./wav.js";

/* Reading a WAV utterance into the samples a model hears. */

const wavOf = ({
    rate,
    channels,
    frames,
    bits = 16,
    extraChunk = false,
}: {
    rate: number;
    channels: number;
    frames: number[][];
    bits?: number;
    extraChunk?: boolean;
}): Buffer => {
    const data = Buffer.alloc(frames.length * channels * 2);
    frames.forEach((frame, index) => frame.forEach((sample, channel) => data.writeInt16LE(sample, (index * channels + channel) * 2)));
    const format = Buffer.alloc(24);
    format.write("fmt ", 0);
    format.writeUInt32LE(16, 4);
    format.writeUInt16LE(1, 8);
    format.writeUInt16LE(channels, 10);
    format.writeUInt32LE(rate, 12);
    format.writeUInt32LE(rate * channels * 2, 16);
    format.writeUInt16LE(channels * 2, 20);
    format.writeUInt16LE(bits, 22);
    // A LIST chunk of odd length before the data, as some encoders write: skipped, with its pad byte.
    const list = extraChunk ? Buffer.concat([Buffer.from("LIST"), Buffer.from([3, 0, 0, 0]), Buffer.from("abc"), Buffer.from([0])]) : Buffer.alloc(0);
    const dataHeader = Buffer.alloc(8);
    dataHeader.write("data", 0);
    dataHeader.writeUInt32LE(data.length, 4);
    const body = Buffer.concat([Buffer.from("WAVE"), format, list, dataHeader, data]);
    const riff = Buffer.alloc(8);
    riff.write("RIFF", 0);
    riff.writeUInt32LE(body.length, 4);
    return Buffer.concat([riff, body]);
};

test("16 kHz mono s16le reads straight through, past any chunk before the data", () => {
    const samples = wavSamples(wavOf({ rate: 16_000, channels: 1, frames: [[0], [16_384], [-32_768]], extraChunk: true }));
    expect([...samples]).toEqual([0, 0.5, -1]);
});

test("stereo is downmixed and another rate resampled to 16 kHz", () => {
    const frames = Array.from({ length: 48 }, () => [16_384, 0]);
    const samples = wavSamples(wavOf({ rate: 48_000, channels: 2, frames }));
    expect(samples).toHaveLength(16);
    expect([...samples].every((sample) => sample === 0.25)).toBe(true);
});

test("anything but 16-bit PCM WAV is refused by name", () => {
    expect(() => wavSamples(Buffer.from("OggS not a wav"))).toThrow(WavFormatError);
    expect(() => wavSamples(wavOf({ rate: 16_000, channels: 1, frames: [[0]], bits: 8 }))).toThrow("only 16-bit PCM");
});

test("the stream's s16le frames read as samples, and 16 kHz needs no resampling", () => {
    const pcm = Buffer.alloc(4);
    pcm.writeInt16LE(-16_384, 0);
    pcm.writeInt16LE(8_192, 2);
    expect([...pcm16Samples(pcm)]).toEqual([-0.5, 0.25]);
    const same = new Float32Array([1, 2]);
    expect(resampleTo16k(same, 16_000)).toBe(same);
});
