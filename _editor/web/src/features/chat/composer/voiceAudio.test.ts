import { describe, expect, it } from "vitest";
import { createSegmenter, resampleTo16k, TARGET_RATE, wavOf16k } from "./voiceAudio";

// A frame of constant-amplitude 16kHz samples: RMS of a constant signal IS the amplitude, so the segmenter's
// thresholds can be exercised with plain numbers.
const frame = (ms: number, amplitude: number): Float32Array => new Float32Array((ms / 1000) * TARGET_RATE).fill(amplitude);

describe(`resampleTo16k`, () => {
    it(`passes 16kHz input through untouched and decimates 48kHz 3:1`, () => {
        const already = new Float32Array([0.1, 0.2]);
        expect(resampleTo16k(already, TARGET_RATE)).toBe(already);
        expect(resampleTo16k(new Float32Array(4800), 48_000).length).toBe(1600);
    });

    it(`interpolates between input samples rather than snapping`, () => {
        // 32kHz → 16kHz: every output sample sits exactly between two inputs of a ramp, so it must read the mean.
        const ramp = Float32Array.from({ length: 8 }, (_, i) => i);
        const out = resampleTo16k(ramp, 32_000);
        expect(out[1]).toBeCloseTo(2);
        expect(out[2]).toBeCloseTo(4);
    });
});

describe(`wavOf16k`, () => {
    it(`frames samples as a 16kHz mono s16le RIFF that clamps hot input`, () => {
        const wav = new DataView(wavOf16k(new Float32Array([0.5, 2, -2])));
        expect(wav.byteLength).toBe(44 + 6);
        expect(String.fromCharCode(wav.getUint8(0), wav.getUint8(1), wav.getUint8(2), wav.getUint8(3))).toBe(`RIFF`);
        expect(wav.getUint16(22, true)).toBe(1); // mono
        expect(wav.getUint32(24, true)).toBe(TARGET_RATE);
        expect(wav.getUint16(34, true)).toBe(16); // bits per sample
        expect(wav.getUint32(40, true)).toBe(6); // data bytes
        expect(wav.getInt16(44, true)).toBe(16_384); // 0.5 scaled
        expect(wav.getInt16(46, true)).toBe(32_767); // clamped, not wrapped
        expect(wav.getInt16(48, true)).toBe(-32_767);
    });
});

describe(`createSegmenter`, () => {
    it(`reports the frame's level and never opens a segment on room tone`, () => {
        const utterances: Float32Array[] = [];
        const segmenter = createSegmenter((samples) => utterances.push(samples));
        for (let i = 0; i < 50; i += 1) {
            expect(segmenter.push(frame(100, 0.001))).toBeCloseTo(0.001);
        }
        expect(utterances).toEqual([]);
    });

    it(`closes an utterance on the silence pause, with the pre-roll kept and the dead tail trimmed`, () => {
        const utterances: Float32Array[] = [];
        const segmenter = createSegmenter((samples) => utterances.push(samples));
        // Quiet room, then a sentence, then the "I'm done" pause.
        for (let i = 0; i < 4; i += 1) {
            segmenter.push(frame(100, 0.001));
        }
        for (let i = 0; i < 5; i += 1) {
            segmenter.push(frame(100, 0.1));
        }
        for (let i = 0; i < 15; i += 1) {
            segmenter.push(frame(100, 0.001));
        }
        expect(utterances.length).toBe(1);
        // 300ms pre-roll + 500ms speech + 250ms kept tail = 1050ms of audio; the other 1250ms of pause is gone.
        expect((utterances[0]?.length ?? 0) / TARGET_RATE).toBeCloseTo(1.05, 2);
    });

    it(`drops a blip shorter than real speech instead of feeding whisper a cough`, () => {
        const utterances: Float32Array[] = [];
        const segmenter = createSegmenter((samples) => utterances.push(samples));
        segmenter.push(frame(100, 0.1));
        for (let i = 0; i < 16; i += 1) {
            segmenter.push(frame(100, 0.001));
        }
        expect(utterances).toEqual([]);
    });

    it(`cuts a monologue at the hard cap rather than growing past what the daemon accepts`, () => {
        const utterances: Float32Array[] = [];
        const segmenter = createSegmenter((samples) => utterances.push(samples), { maxUtteranceMs: 2000 });
        for (let i = 0; i < 30; i += 1) {
            segmenter.push(frame(100, 0.1));
        }
        expect(utterances.length).toBe(1);
        expect((utterances[0]?.length ?? 0) / TARGET_RATE).toBeCloseTo(2, 1);
    });

    it(`discard drops the in-flight segment: a mic turned off mid-sentence sends nothing`, () => {
        const utterances: Float32Array[] = [];
        const segmenter = createSegmenter((samples) => utterances.push(samples));
        for (let i = 0; i < 10; i += 1) {
            segmenter.push(frame(100, 0.1));
        }
        segmenter.discard();
        for (let i = 0; i < 16; i += 1) {
            segmenter.push(frame(100, 0.001));
        }
        expect(utterances).toEqual([]);
    });
});
