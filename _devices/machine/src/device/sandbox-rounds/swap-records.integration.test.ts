import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readChannelSlugs, readSwapRecords } from "./swap-records.js";

/* The records are read off a real directory: only ic's own files, only those naming a phase, and nothing that throws. */

test("every record naming a phase is read, and nothing else in ic's home is", async () => {
    const home = mkdtempSync(join(tmpdir(), "ic-home-"));
    writeFileSync(join(home, "sandbox-work.channel"), "channel=stable\nswap_phase=cutover\nswap_at=1800000000000\n");
    writeFileSync(join(home, "sandbox-idle.channel"), "channel=stable\ncurrent=img:1\n");
    writeFileSync(join(home, "sandbox-work.log"), "swap_phase=cutover\n");
    expect(await readSwapRecords(home)).toEqual([{ slug: "work", phase: "cutover", at: 1_800_000_000_000, probationUntil: undefined }]);
});

// The keeper's answer to "what runs here" while Docker is down: every record, a swap in it or not, and nothing else.
test("every record is a sandbox this environment's ic knows, whatever its phase", async () => {
    const home = mkdtempSync(join(tmpdir(), "ic-home-"));
    writeFileSync(join(home, "sandbox-work.channel"), "channel=stable\nswap_phase=cutover\nswap_at=1800000000000\n");
    writeFileSync(join(home, "sandbox-idle.channel"), "channel=stable\ncurrent=img:1\n");
    writeFileSync(join(home, "sandbox-work.channel.before"), "channel=stable\n");
    writeFileSync(join(home, "sandbox-work.log"), "channel=stable\n");
    expect(await readChannelSlugs(home)).toEqual(["idle", "work"]);
    expect(await readChannelSlugs(join(tmpdir(), "ic-home-that-was-never-made"))).toEqual([]);
});

// Every caller defers or pauses on the answer; a directory ic never made must read as "no swap", not stop the agent.
test("a home that does not exist has no records", async () => {
    expect(await readSwapRecords(join(tmpdir(), "ic-home-that-was-never-made"))).toEqual([]);
});
