import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { channelStamp } from "./ic-swaps.js";

/* The swaps answer is held while ic's channel records stay as they were: the stamp is what says they changed. */

test("the stamp moves when a channel record is written, added or removed, and only then", async () => {
    const home = mkdtempSync(join(tmpdir(), "ic-home-"));
    const record = join(home, "sandbox-work.channel");
    writeFileSync(record, "swap_phase=cutover\nswap_at=1000\n");
    utimesSync(record, 1_000, 1_000);
    const first = await channelStamp(home);
    expect(await channelStamp(home)).toBe(first);

    // Another file in ic's home is not a record, and changes nothing.
    writeFileSync(join(home, "keeper.json"), "{}");
    expect(await channelStamp(home)).toBe(first);

    // A cutover's heartbeat rewrites the record.
    writeFileSync(record, "swap_phase=cutover\nswap_at=1000\nswap_alive=16000\n");
    const beaten = await channelStamp(home);
    expect(beaten).not.toBe(first);

    writeFileSync(join(home, "sandbox-other.channel"), "");
    const added = await channelStamp(home);
    expect(added).not.toBe(beaten);

    rmSync(join(home, "sandbox-other.channel"));
    expect(await channelStamp(home)).toBe(beaten);
});

test("a home ic never wrote has a stamp, and it is the empty one", async () => {
    expect(await channelStamp(join(tmpdir(), "ic-home-that-was-never-made"))).toBe("");
});
