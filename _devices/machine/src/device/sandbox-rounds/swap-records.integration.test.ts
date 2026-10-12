import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readChannelSlugs } from "./swap-records.js";

/* The records are listed off a real directory: only ic's own files, and nothing that throws. */

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
