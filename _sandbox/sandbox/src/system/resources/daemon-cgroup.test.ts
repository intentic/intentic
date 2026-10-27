import { HISTORY_ROOT } from "@intentic/constants";
import { cgroupMountOptions, checkDaemonLeaf, type CgroupFiles, daemonLeafOf, startDaemonCgroupKeeper } from "./daemon-cgroup.js";

// A cgroup filesystem in a map: a missing key is a file this kernel lacks, a `refuse` entry a write the kernel turns down.
const fakeFiles = (texts: Record<string, string>, refuse: ReadonlySet<string> = new Set()) => {
    const writes: [string, string][] = [];
    const io: CgroupFiles = {
        read: async (path) => texts[path],
        write: async (path, value) => {
            if (refuse.has(path)) { throw new Error("EBUSY"); }
            writes.push([path, value]);
            texts[path] = `${value}\n`;
        },
    };
    return { io, writes };
};

const LEAF = "/sys/fs/cgroup/daemon";

test("only the entrypoint's daemon leaf is the daemon's to keep", () => {
    expect(daemonLeafOf("0::/daemon\n")).toBe(LEAF);
    expect(daemonLeafOf("0::/docker/abc/daemon\n")).toBe("/sys/fs/cgroup/docker/abc/daemon");
    expect(daemonLeafOf("0::/workload\n")).toBeUndefined();
    expect(daemonLeafOf("0::/daemons\n")).toBeUndefined();
    expect(daemonLeafOf("12:cpu:/daemon\n")).toBeUndefined();
});

// 2026-10-13: a day's run with the leaf at the kernel's defaults, 559 MiB of the daemon's heap in swap.
test("a leaf at the kernel's defaults gets the entrypoint's settings back, and one already right is left alone", async () => {
    const { io, writes } = fakeFiles({ [`${LEAF}/memory.swap.max`]: "max\n", [`${LEAF}/cpu.weight`]: "100\n", [`${LEAF}/io.weight`]: "default 1000\n8:0 200\n" });
    const check = await checkDaemonLeaf(LEAF, io);
    expect(check.restored).toEqual([{ file: "memory.swap.max", was: "max" }, { file: "cpu.weight", was: "100" }]);
    expect(writes).toEqual([[`${LEAF}/memory.swap.max`, "0"], [`${LEAF}/cpu.weight`, "1000"]]);
    expect((await checkDaemonLeaf(LEAF, io)).restored).toEqual([]);
});

test("a write the kernel refuses and a controller the leaf lacks are reported, never thrown", async () => {
    const { io } = fakeFiles({ [`${LEAF}/cpu.weight`]: "100\n" }, new Set([`${LEAF}/cpu.weight`]));
    expect(await checkDaemonLeaf(LEAF, io)).toEqual({
        restored: [],
        refused: [{ file: "cpu.weight", reason: "EBUSY" }],
        missing: ["memory.swap.max", "io.weight"],
    });
});

test("the keeper says each restore once a daemon life, however often something resets it", async () => {
    const texts = { "/proc/self/cgroup": "0::/daemon\n", [`${LEAF}/memory.swap.max`]: "max\n", [`${LEAF}/cpu.weight`]: "1000\n" } satisfies Record<string, string>;
    const { io } = fakeFiles(texts);
    const warned: unknown[] = [];
    const keeper = startDaemonCgroupKeeper({ warn: (fields: unknown) => { warned.push(fields); }, info: () => {} }, { io, intervalMs: 5 });
    try {
        await new Promise((resolve) => setTimeout(resolve, 15));
        // Reset under it, as whatever reset it the first time would.
        texts[`${LEAF}/memory.swap.max`] = "max\n";
        await new Promise((resolve) => setTimeout(resolve, 15));
        expect(texts[`${LEAF}/memory.swap.max`]).toBe("0\n");
        expect(warned).toEqual([{ leaf: LEAF, file: "memory.swap.max", was: "max", now: "0" }]);
    } finally {
        keeper.stop();
    }
    // Nothing here touches a real cgroup or the history volume.
    expect(HISTORY_ROOT).not.toBe(LEAF);
});

// 2026-10-27: a compose sandbox's cgroup filesystem was read-only, the entrypoint made no leaf, and the daemon said nothing.
const COMPOSE_MOUNTS = "proc /proc proc rw,nosuid 0 0\ncgroup /sys/fs/cgroup cgroup2 ro,nosuid,nodev,noexec,relatime,nsdelegate 0 0\n";

test("the cgroup mount's options are read off the mount table, and only the cgroup2 one at the root counts", () => {
    expect(cgroupMountOptions(COMPOSE_MOUNTS)).toBe("ro,nosuid,nodev,noexec,relatime,nsdelegate");
    expect(cgroupMountOptions("cgroup /sys/fs/cgroup/memory cgroup rw 0 0\n")).toBeUndefined();
    expect(cgroupMountOptions("")).toBeUndefined();
});

describe("a container with no daemon leaf", () => {
    const watch = async (texts: Record<string, string>, container: boolean): Promise<unknown[]> => {
        const warned: unknown[] = [];
        const keeper = startDaemonCgroupKeeper({ warn: (fields: unknown, message?: string) => { warned.push({ fields, message }); }, info: () => {} }, { io: fakeFiles(texts).io, intervalMs: 5, container });
        try {
            await new Promise((resolve) => setTimeout(resolve, 20));
        } finally {
            keeper.stop();
        }
        return warned;
    };

    test("is said once a daemon life, with the mount that kept it from one", async () => {
        const warned = await watch({ "/proc/self/cgroup": "0::/\n", "/proc/mounts": COMPOSE_MOUNTS }, true);
        expect(warned).toEqual([{ fields: { mount: "ro,nosuid,nodev,noexec,relatime,nsdelegate" }, message: expect.stringMatching(/no daemon leaf, so nothing keeps the daemon's heap out of swap/u) }]);
    });

    test("is not a local daemon's to say, nor a guest's beside a leaf another daemon holds", async () => {
        expect(await watch({ "/proc/self/cgroup": "0::/\n", "/proc/mounts": COMPOSE_MOUNTS }, false)).toEqual([]);
        expect(await watch({ "/proc/self/cgroup": "0::/workload\n", "/sys/fs/cgroup/daemon/cgroup.procs": "9\n" }, true)).toEqual([]);
    });
});
