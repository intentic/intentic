import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unstubbed } from "@intentic/testing";
import type { Services } from "../../composition.js";
import { filePeerStore } from "../../peers/peer-store.js";
import { revokeSuperseded } from "../host-dedupe.js";
import { HOST_PEER } from "../host-peer.js";

// The dedupe's "made before it" is the enrollment store's own order, so it is checked on the real store: a pairing is
// appended (enrollment.ts `issue`), a rename keeps a record where it was, and an amended machine id moves nothing. The
// owner's own case, end to end: rog paired as "radarsu-rog", the card renamed outside the rename path, rog paired
// again as "rog" and connected, saying which computer it is.

const ROG = "m-f9491b45-2639-4a69-9e4e-c4697c0403d6";

const quiet = unstubbed<Services["logger"]>("logger", { info: () => undefined });

test("a computer paired again under a new name drops its old key once it connects, and keeps every other", async () => {
    const hosts = filePeerStore(mkdtempSync(join(tmpdir(), "host-dedupe-")), HOST_PEER.store);
    const pair = async (id: string): Promise<void> => {
        await hosts.enroll(hosts.mintPairing(id).token);
    };
    await pair("radarsu-rog");
    await hosts.amend("radarsu-rog", { machineId: ROG });
    await pair("rog::wsl:archlinux");
    await hosts.amend("rog::wsl:archlinux", { machineId: ROG });
    // One that never said which computer it is: a placeholder id, never a duplicate of anything.
    await pair("old-laptop");
    await pair("rog");
    await hosts.amend("rog", { machineId: ROG });

    const hostHub = unstubbed<Services["hostHub"]>("hostHub", { online: (id) => id === "rog" });
    expect(await revokeSuperseded({ hosts, hostHub, logger: quiet }, "rog")).toEqual(["radarsu-rog"]);
    expect((await hosts.list()).map((entry) => entry.id)).toEqual(["rog::wsl:archlinux", "old-laptop", "rog"]);

    // Nothing left to drop, at boot or on the next connect.
    const asleep = unstubbed<Services["hostHub"]>("hostHub", { online: () => false });
    expect(await revokeSuperseded({ hosts, hostHub: asleep, logger: quiet })).toEqual([]);
});

test("re-pairing a key that already exists moves it to the end, so it counts as the newest", async () => {
    const hosts = filePeerStore(mkdtempSync(join(tmpdir(), "host-dedupe-")), HOST_PEER.store);
    for (const id of ["desk", "rog", "desk"]) {
        await hosts.enroll(hosts.mintPairing(id).token);
        await hosts.amend(id, { machineId: ROG });
    }
    const asleep = unstubbed<Services["hostHub"]>("hostHub", { online: () => false });
    expect(await revokeSuperseded({ hosts, hostHub: asleep, logger: quiet })).toEqual(["rog"]);
    expect((await hosts.list()).map((entry) => entry.id)).toEqual(["desk"]);
});
