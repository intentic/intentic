import { GIB } from "../../../system/resources/storage/checkout-space.js";
import { fanOutCostNote } from "./fan-out-cost-note.js";

const space = { freeBytes: 15 * GIB, totalBytes: 100 * GIB };

test("small checkouts do not add noise until they exceed five percent of free space above the floor", () => {
    expect(fanOutCostNote({ bytes: 0.4 * GIB, space, largestFolders: [], pathsGiven: false })).toBeUndefined();
    expect(fanOutCostNote({ bytes: 0.6 * GIB, space, largestFolders: [], pathsGiven: false })).toContain("Each subagent here checks out about 0.6 GB");
});

test("a one GiB checkout is significant and paths suppress the scope advice", () => {
    const room = { freeBytes: 45 * GIB, totalBytes: 100 * GIB };
    expect(fanOutCostNote({ bytes: GIB, space: room, largestFolders: [{ path: "FIRMA/KADRY", bytes: GIB }], pathsGiven: true })).toBe(
        "Each subagent here checks out about 1.0 GB; the disk has room for about 40 at once (40.0 GB free above its floor), and the rest wait for disk space. Largest folders: FIRMA/KADRY 1.0 GB.",
    );
});
