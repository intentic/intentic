import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { stagedUpdate } from "./staged-update.js";

// The staged-update marker: every failure to read it (missing, malformed, unversioned) falls back to "nothing is known
// to be waiting".

const withMarker = async (contents?: string): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), "staged-"));
    if (contents !== undefined) {
        await writeFile(join(dir, "update-staged.json"), contents);
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
