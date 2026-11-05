import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readContainerId, readKernelLog } from "./kernel-oom.js";

/* Reading the ring: /dev/kmsg without blocking, dmesg where there is none, and nothing (with the reason) where neither. */

let dir: string;

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "kernel-oom-"));
});

afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
});

test("records read from a kmsg device come back as lines, and an empty ring is no lines rather than a failure", async () => {
    const kmsg = join(dir, "kmsg");
    await writeFile(kmsg, "6,1,1000,-;first\n SUBSYSTEM=memory\n3,2,2000,-;second\n");
    expect(readKernelLog({ kmsgPath: kmsg })).toEqual({
        source: "kmsg",
        lines: [
            { bootUs: 1000, text: "first" },
            { bootUs: 2000, text: "second" },
        ],
    });
    await writeFile(kmsg, "");
    expect(readKernelLog({ kmsgPath: kmsg })).toEqual({ source: "kmsg", lines: [] });
});

test("with no /dev/kmsg, dmesg is read; with neither, the reason is said and nothing throws", () => {
    const missing = join(dir, "no-kmsg");
    expect(readKernelLog({ kmsgPath: missing, dmesg: () => "[    1.000002] hello\n" })).toEqual({ source: "dmesg", lines: [{ bootUs: 1_000_002, text: "hello" }] });
    const none = readKernelLog({
        kmsgPath: missing,
        dmesg: () => {
            throw Object.assign(new Error("dmesg: read kernel buffer failed: Operation not permitted"), { code: "EPERM" });
        },
    });
    expect(none).toEqual({ source: "none", lines: [], problem: "/dev/kmsg: ENOENT; dmesg: EPERM" });
});

test("this machine's own ring and container id are read without throwing, whatever this sandbox may see", () => {
    const log = readKernelLog();
    expect(["kmsg", "dmesg", "none"]).toContain(log.source);
    expect(log.source !== "none" || log.problem !== undefined).toBe(true);
    const id = readContainerId();
    expect(id === undefined || /^[0-9a-f]{12}([0-9a-f]{52})?$/u.test(id)).toBe(true);
});
