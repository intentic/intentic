import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { swapsFromFiles } from "./swaps-fallback.js";

/* COMPAT(ic-swaps): remove with swaps-fallback.ts. The fallback reads a real directory: only ic's own record files, only
those naming a swap, and nothing that throws. */

const NOW = 1_800_000_100_000;

test("every record naming a swap is read as ic would answer it, and nothing else in ic's home is", async () => {
    const home = mkdtempSync(join(tmpdir(), "ic-home-"));
    writeFileSync(join(home, "sandbox-work.channel"), `channel=stable\nswap_phase=cutover\nswap_at=${NOW - 30_000}\n`);
    writeFileSync(join(home, "sandbox-dead.channel"), `channel=stable\nswap_phase=cutover\nswap_at=${NOW - 300_000}\n`);
    writeFileSync(join(home, "sandbox-idle.channel"), "channel=stable\ncurrent=img:1\n");
    writeFileSync(join(home, "sandbox-work.log"), "swap_phase=cutover\n");
    expect(await swapsFromFiles(home, NOW)).toEqual([
        { slug: "dead", phase: "cutover", at: NOW - 300_000, cutoverInProgress: false },
        { slug: "work", phase: "cutover", at: NOW - 30_000, cutoverInProgress: true },
    ]);
});

// Every caller defers or pauses on the answer; a directory ic never made must read as "no swap", not stop the agent.
test("a home that does not exist has no swaps", async () => {
    expect(await swapsFromFiles(join(tmpdir(), "ic-home-that-was-never-made"), NOW)).toEqual([]);
});
