import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { S2S_SEEN_IDS_MS } from "@intentic/sandbox-contract/schemas/s2s";
import { fileSeenIds, s2sSeenIdsDocument } from "./seen-ids.js";

// The ids taken are a ledger: each one taken is one appended line, never a rewrite of the rest, read back once by a
// daemon that restarts, and an id past its thirty days is no longer remembered.

test("each id taken appends one line, the lines before untouched, and a restart remembers them", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "seen-ids-")), s2sSeenIdsDocument.path);
    let now = 1_000;
    const seen = fileSeenIds(path, () => now);
    await seen.add("one");
    const first = readFileSync(path, "utf8");
    expect(first).toBe('{"id":"one","at":1000}\n');
    now = 2_000;
    await seen.add("two");
    expect(readFileSync(path, "utf8")).toBe(`${first}{"id":"two","at":2000}\n`);
    expect([await seen.has("one"), await seen.has("two"), await seen.has("three")]).toEqual([true, true, false]);

    const restarted = fileSeenIds(path, () => now);
    expect([await restarted.has("one"), await restarted.has("two")]).toEqual([true, true]);
    // Thirty days after "one" it is still remembered; a millisecond past, no more.
    now = 1_000 + S2S_SEEN_IDS_MS;
    expect(await restarted.has("one")).toBe(true);
    now += 1;
    expect([await restarted.has("one"), await restarted.has("two")]).toEqual([false, true]);
});
