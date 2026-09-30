import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UpdateOutcome } from "@intentic/sandbox-contract";
import { PREPARING_FRESH_MS, preparingUpdate, stagedUpdate, updateOutcome } from "./staged-update.js";

// The staged-update marker: every failure to read it (missing, malformed, unversioned) falls back to "nothing is known
// to be waiting".

const withMarker = async (contents?: string, name = "update-staged.json"): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), "staged-"));
    if (contents !== undefined) {
        await writeFile(join(dir, name), contents);
    }
    return dir;
};

test("a marker the host wrote is read back whole", async () => {
    const dir = await withMarker(JSON.stringify({ version: "1.4.2", channel: "stable", at: 1_755_500_000_000 }));
    expect(await stagedUpdate(dir)).toEqual({ version: "1.4.2", channel: "stable", at: 1_755_500_000_000 });
});

test("an update staged by an image that would not name its version is still an update that is staged", async () => {
    const dir = await withMarker(JSON.stringify({ channel: "beta", at: 1 }));
    expect(await stagedUpdate(dir)).toEqual({ channel: "beta", at: 1 });
});

test("no marker at all is the ordinary case, not an error", async () => {
    expect(await stagedUpdate(await withMarker())).toBeUndefined();
});

test("a marker that cannot be understood reads as nothing staged", async () => {
    // Covers a crash mid-write, a hand-edit, and a shape a newer `ic` writes that this build doesn't parse.
    expect(await stagedUpdate(await withMarker("not json at all"))).toBeUndefined();
    expect(await stagedUpdate(await withMarker(JSON.stringify({ version: "1.4.2" })))).toBeUndefined();
    expect(await stagedUpdate(await withMarker(JSON.stringify({ channel: "stable", at: "soon" })))).toBeUndefined();
    expect(await stagedUpdate(await withMarker(JSON.stringify([1, 2, 3])))).toBeUndefined();
});

test("a history root that is not there does not throw on the info path", async () => {
    expect(await stagedUpdate(join(tmpdir(), "intentic-no-such-history-root"))).toBeUndefined();
});

// The host's word on what it last did about the version, which `ic` writes after a swap and after its probation.
const withOutcome = (contents?: string): Promise<string> => withMarker(contents, "update-outcome.json");

test("an outcome the host wrote is read back whole", async () => {
    const rolledBack: UpdateOutcome = {
        result: "rolled-back",
        verb: "probation",
        at: 1_790_000_000_000,
        from: "1.500.0",
        to: "1.501.0",
        reason: "it restarted 4 times in 10 minutes",
        log: "/home/me/.intentic/logs/swap.log",
    };
    expect(await updateOutcome(await withOutcome(JSON.stringify(rolledBack)))).toEqual(rolledBack);
    const updated: UpdateOutcome = { result: "updated", verb: "update", at: 1, from: "1.500.0", to: "1.501.0", keepUntil: 86_400_001 };
    expect(await updateOutcome(await withOutcome(JSON.stringify(updated)))).toEqual(updated);
});

test("no outcome, or one this build cannot read, is nothing said", async () => {
    expect(await updateOutcome(await withOutcome())).toBeUndefined();
    expect(await updateOutcome(await withOutcome("{"))).toBeUndefined();
    // A result a newer host has a word for and this build does not.
    expect(await updateOutcome(await withOutcome(JSON.stringify({ result: "deferred", at: 1 })))).toBeUndefined();
    expect(await updateOutcome(await withOutcome(JSON.stringify({ result: "kept" })))).toBeUndefined();
});

// The host's word on a download still running, which `ic sandbox prepare` rewrites every few seconds and removes when
// it ends. A killed ic cannot remove it, so only a fresh one is a download in progress.
const withPreparing = (contents?: string): Promise<string> => withMarker(contents, "update-preparing.json");
const NOW = 1_790_000_000_000;

test("a download the host is running is read back whole while its heartbeat is fresh", async () => {
    const pulling = { channel: "stable", startedAt: NOW - 90_000, at: NOW - 3_000, phase: "download", percent: 42 };
    expect(await preparingUpdate(await withPreparing(JSON.stringify(pulling)), NOW)).toEqual(pulling);
    const building = { channel: "stable", startedAt: NOW - 200_000, at: NOW - PREPARING_FRESH_MS, phase: "build" };
    expect(await preparingUpdate(await withPreparing(JSON.stringify(building)), NOW)).toEqual(building);
});

test("a download whose heartbeat stopped is no download at all, so a killed ic never leaves a bar frozen on the card", async () => {
    const stalled = { channel: "stable", startedAt: NOW - 600_000, at: NOW - PREPARING_FRESH_MS - 1, phase: "download", percent: 40 };
    expect(await preparingUpdate(await withPreparing(JSON.stringify(stalled)), NOW)).toBeUndefined();
});

test("no download marker, or one this build cannot read, is nothing downloading", async () => {
    expect(await preparingUpdate(await withPreparing(), NOW)).toBeUndefined();
    expect(await preparingUpdate(await withPreparing(JSON.stringify({ channel: "stable", at: NOW })), NOW)).toBeUndefined();
    expect(await preparingUpdate(await withPreparing(JSON.stringify({ channel: "stable", startedAt: NOW, at: NOW, phase: "download", percent: 140 })), NOW)).toBeUndefined();
});

test("a step a newer ic names is still a download in progress", async () => {
    const newer = { channel: "stable", startedAt: NOW - 1_000, at: NOW, phase: "verify" };
    expect(await preparingUpdate(await withPreparing(JSON.stringify(newer)), NOW)).toEqual(newer);
});
