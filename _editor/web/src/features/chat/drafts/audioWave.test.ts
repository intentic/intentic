// The waveform reduction on its own: what the chip draws for a clip is decided here, and a browser AudioContext is
// not needed to say whether it is right.
import { expect, it } from "vitest";
import { barsFrom, WAVE_BARS } from "./audioWave";

// A ramp whose loudest sample sits in the last window, so normalization has something to scale against.
const ramp = (length: number): Float32Array => Float32Array.from({ length }, (_, at) => at / length);

it("draws one bar per asked-for bar, whatever the sample count", () => {
    expect(barsFrom(ramp(10_000), WAVE_BARS)).toHaveLength(WAVE_BARS);
    expect(barsFrom(ramp(3), WAVE_BARS)).toHaveLength(WAVE_BARS);
    expect(barsFrom(new Float32Array(0), WAVE_BARS)).toHaveLength(WAVE_BARS);
});

// The peak, not the mean: a waveform of speech averages to near-silence in every window and draws as a flat line,
// which is the exact failure this reduction exists to avoid. One loud sample in an otherwise quiet window must
// reach the top of the bar.
it("takes the loudest sample in a window rather than its average", () => {
    const samples = new Float32Array(400);
    samples[397] = 1;

    const bars = barsFrom(samples, 4);

    expect(bars).toEqual([0, 0, 0, 1]);
});

// A voice note recorded quietly is still a voice note; at true amplitude it draws as a flat line and tells the
// reader nothing. The loudest bar is pinned to the top and the rest keep their ratios to it.
it("scales the shape so the loudest bar fills the chip", () => {
    const samples = Float32Array.from([0.01, 0.01, 0.02, 0.02, 0.04, 0.04]);

    expect(barsFrom(samples, 3)).toEqual([0.25, 0.5, 1]);
});

// Both halves of a signal carry the same shape; a reduction reading raw values would draw a trough as silence.
it("reads a bar's depth as well as its height", () => {
    expect(barsFrom(Float32Array.from([-1, -0.5]), 2)).toEqual([1, 0.5]);
});

// Dividing by a zero loudest would make every bar NaN, and a NaN height draws no bar at all — a silent clip must
// still render its track, flat.
it("draws digital silence flat instead of drawing nothing", () => {
    expect(barsFrom(new Float32Array(500), 4)).toEqual([0, 0, 0, 0]);
});

// A clip shorter than the bar count has fewer samples than bars; each bar still claims one rather than the tail of
// them collapsing to zeros past the end of the buffer.
it("spreads a clip shorter than the bar count over every bar", () => {
    expect(barsFrom(Float32Array.from([1, 0.5]), 4)).toEqual([1, 1, 0.5, 0.5]);
});

it("asks for no bars and gets none", () => {
    expect(barsFrom(ramp(100), 0)).toEqual([]);
});
