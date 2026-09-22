import type { Capability } from "@intentic/sandbox-contract";
import { test, expect } from "bun:test";
import type { CapabilitiesStore } from "../capabilities/capabilities-store.js";
import { checks } from "./invariant.js";
import { parseMountinfo } from "./mountinfo.js";

// The access check is the safety property of the subsystem, tested against real mountinfo lines, not an assumed shape.

const store = (capabilities: Capability[]): CapabilitiesStore => ({ list: async () => capabilities }) as unknown as CapabilitiesStore;

const disk = (id: string, access: "read" | "readwrite"): Capability =>
    ({ id, kind: "netdisk", config: { provider: "smb", server: "nas", share: id, username: "u", access, version: "auto", autoMount: "on" } }) as Capability;

const line = (id: string, flag: "ro" | "rw", superFlag: "ro" | "rw" = flag): string =>
    `3001 2857 0:210 / /mnt/netdisk/${id} ${flag},relatime - cifs //nas/${id} ${superFlag},vers=3.1.1,soft`;

const run = async (deps: Parameters<typeof checks>[0], name: string): Promise<string | undefined> => {
    const check = checks(deps).find((candidate) => candidate.name === name);
    if (check === undefined) {
        throw new Error(`no check named ${name}`);
    }
    let failure: string | undefined;
    try {
        await check.run({
            moment: "sweep",
            fail: (message: string) => {
                failure = message;
                throw new Error(message);
            },
        });
    } catch {
        // The throw reports the violation; the message was already captured above.
    }
    return failure;
};

const ACCESS = "a-read-only-disk-is-mounted-read-only";
const STRAY = "nothing-under-the-disk-root-but-the-manifest's-disks";

test("a read-only disk mounted ro, and a read-write disk mounted rw, are not violations", async () => {
    const mounts = async () => parseMountinfo([line("archive", "ro"), line("scratch", "rw")].join("\n"));
    expect(await run({ capabilities: store([disk("archive", "read"), disk("scratch", "readwrite")]), mounts }, ACCESS)).toBeUndefined();
});

test("a read-only disk that takes writes is reported, whichever layer was flipped", async () => {
    const perMount = async () => parseMountinfo(line("archive", "rw", "rw"));
    const failure = await run({ capabilities: store([disk("archive", "read")]), mounts: perMount }, ACCESS);
    expect(failure).toMatch(/\/mnt\/netdisk\/archive \(netdisk "archive"\)/);
    expect(failure).toMatch(/read-only account/);
    // Only the superblock says rw while the per-mount flag still says ro: the kernel still refuses writes, no alarm.
    const superOnly = async () => parseMountinfo(line("archive", "ro", "rw"));
    expect(await run({ capabilities: store([disk("archive", "read")]), mounts: superOnly }, ACCESS)).toBeUndefined();
});

test("an unmounted read-only disk, and a mount at the same point that is not cifs, are silence", async () => {
    expect(await run({ capabilities: store([disk("archive", "read")]), mounts: async () => [] }, ACCESS)).toBeUndefined();
    const tmpfs = async () => parseMountinfo("3001 2857 0:210 / /mnt/netdisk/archive rw,relatime - tmpfs tmpfs rw");
    expect(await run({ capabilities: store([disk("archive", "read")]), mounts: tmpfs }, ACCESS)).toBeUndefined();
});

test("a mount under the disk root the manifest never asked for is reported; the manifest's own are not", async () => {
    const mounts = async () => parseMountinfo([line("archive", "ro"), line("handmade", "rw")].join("\n"));
    const failure = await run({ capabilities: store([disk("archive", "read")]), mounts }, STRAY);
    expect(failure).toMatch(/\/mnt\/netdisk\/handmade \(cifs \/\/nas\/handmade\)/);
    expect(failure).not.toMatch(/archive/);
    expect(await run({ capabilities: store([disk("archive", "read"), disk("handmade", "readwrite")]), mounts }, STRAY)).toBeUndefined();
});
