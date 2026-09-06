import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { stagedUpdate } from "./staged-update.js";

/* The one fact on /info the daemon cannot work out for itself, arriving as a file the host wrote. Every case
 * here is a way for the update card to say something false about what taking an update costs, so each one
 * resolves to the same safe answer: "nothing is known to be waiting", which is how the card read before this
 * existed. */

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
    // The version is a nicety the image may not report. Treating its absence as "nothing is staged" would
    // throw away the entire benefit: the download HAS happened, and the restart is still the only cost left.
    const dir = await withMarker(JSON.stringify({ channel: "beta", at: 1 }));
    expect(await stagedUpdate(dir)).toEqual({ channel: "beta", at: 1 });
});

test("no marker at all is the ordinary case, not an error", async () => {
    // Every sandbox that has never had an update prepared for it is in exactly this state, on every /info.
    expect(await stagedUpdate(await withMarker())).toBeUndefined();
});

test("a marker that cannot be understood reads as nothing staged", async () => {
    // Truncated by a crash mid-write, hand-edited, or written in a shape a newer `ic` knows and this build
    // does not. The card must fall back to offering the ordinary update, never to claiming a download that
    // may not have happened.
    expect(await stagedUpdate(await withMarker("not json at all"))).toBeUndefined();
    expect(await stagedUpdate(await withMarker(JSON.stringify({ version: "1.4.2" })))).toBeUndefined();
    expect(await stagedUpdate(await withMarker(JSON.stringify({ channel: "stable", at: "soon" })))).toBeUndefined();
    expect(await stagedUpdate(await withMarker(JSON.stringify([1, 2, 3])))).toBeUndefined();
});

test("a history root that is not there does not throw on the info path", async () => {
    // /info answers on every browser connection. A daemon whose history volume is missing is already in
    // trouble; a route that throws would take the whole sandbox hub down with it.
    expect(await stagedUpdate(join(tmpdir(), "intentic-no-such-history-root"))).toBeUndefined();
});
