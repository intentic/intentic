import assert from "node:assert/strict";
import { test } from "node:test";
import { frameStats, lostBetweenPolls, median, mergePresents, parseLatency } from "./frames.ts";

const MS = 1e6;

test("reads presents and drops pending and empty slots", () => {
    const latency = parseLatency(`16666666\n\n0\t0\t0\n100\t${200 * MS}\t90\n100\t9223372036854775807\t90\n`);
    assert.equal(latency.refreshNs, 16_666_666);
    assert.deepEqual(latency.presents, [200 * MS]);
});

test("merges overlapping polls into one ordered run", () => {
    assert.deepEqual(mergePresents([{ refreshNs: 1, presents: [3, 1] }, { refreshNs: 1, presents: [2, 3] }]), [1, 2, 3]);
});

test("counts a late frame as jank and a standstill as neither", () => {
    // Four frames on time, one shown two refreshes late, then two seconds of nothing moving, then one more frame.
    const presents = [0, 16.7, 33.4, 50.1, 83.5, 2083.5, 2100.2].map((ms) => ms * MS);
    const stats = frameStats(presents, 16.7 * MS);
    assert.equal(stats.frames, 5);
    assert.equal(stats.janky, 1);
    assert.equal(stats.maxMs, 33.4);
    assert.equal(stats.jankPct, 20);
});

test("lets a streamed turn's quiet stretches pass when told how long they run", () => {
    // A tool call: nothing to draw for 50ms, which ends three or four refreshes later, then on time again.
    const presents = [0, 16.7, 83.5, 100.2].map((ms) => ms * MS);
    assert.equal(frameStats(presents, 16.7 * MS).janky, 1);
    assert.equal(frameStats(presents, 16.7 * MS, { lateAfter: 4.5 }).janky, 0);
    assert.equal(frameStats([...presents, 200.4 * MS], 16.7 * MS, { lateAfter: 4.5 }).janky, 1);
});

test("tells polls that overlap from polls a full history slipped between", () => {
    const history = (from: number): number[] => Array.from({ length: 128 }, (_, index) => (from + index * 16.7) * MS);
    const overlapping = [history(0), history(1000)].map((presents) => ({ refreshNs: 16.7 * MS, presents }));
    const apart = [history(0), history(3000)].map((presents) => ({ refreshNs: 16.7 * MS, presents }));
    assert.equal(lostBetweenPolls(overlapping), 0);
    assert.equal(lostBetweenPolls(apart), 1);
});

test("keeps to the window it is given", () => {
    const presents = [0, 16, 32, 48, 64].map((ms) => ms * MS);
    assert.equal(frameStats(presents, 16.7 * MS, { fromNs: 32 * MS }).frames, 2);
});

test("takes the middle of an even run as the mean of its two middles", () => {
    assert.equal(median([4, 1, 3, 2]), 2.5);
    assert.ok(Number.isNaN(median([])));
});
