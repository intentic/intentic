import { HISTORY_ROOT } from "@intentic/constants";
import {
    cgroupMountOptions,
    checkDaemonLeaf,
    checkWorkloadLeaf,
    type CgroupFiles,
    daemonLeafOf,
    startDaemonCgroupKeeper,
    workloadBounds,
    workloadLeafOf,
} from "./daemon-cgroup.js";
import { WORKLOAD_BOUNDS_OVERRIDE } from "./memory-records.js";

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
    const keeper = startDaemonCgroupKeeper({ warn: (fields: unknown) => { warned.push(fields); }, info: () => {} }, { io, intervalMs: 5, swapEnv: undefined });
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
        const keeper = startDaemonCgroupKeeper({ warn: (fields: unknown, message?: string) => { warned.push({ fields, message }); }, info: () => {} }, { io: fakeFiles(texts).io, intervalMs: 5, container, swapEnv: undefined });
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

/* THE WORKLOAD LEAF'S BOUNDS (2026-11-05): a runaway grew to 17.6 GB resident and 33 GB of swap in a leaf bounded by
   neither, and the daemon it froze sat in that same leaf. */
const GIB = 1024 ** 3;
const ROOT = "/sys/fs/cgroup";
const WORKLOAD = `${ROOT}/workload`;

test("the workload leaf sits beside the daemon's, whichever of the two a process is in", () => {
    expect(workloadLeafOf("0::/daemon\n")).toBe(WORKLOAD);
    expect(workloadLeafOf("0::/workload\n")).toBe(WORKLOAD);
    expect(workloadLeafOf("0::/docker/abc/daemon\n")).toBe("/sys/fs/cgroup/docker/abc/workload");
    expect(workloadLeafOf("0::/\n")).toBeUndefined();
    expect(workloadLeafOf("0::/workload/nested\n")).toBeUndefined();
});

describe("the workload leaf's bounds", () => {
    const bounds = (inputs: Partial<Parameters<typeof workloadBounds>[0]>) =>
        Object.fromEntries(workloadBounds({ capBytes: undefined, machineBytes: undefined, swapEnv: undefined, override: undefined, ...inputs }).map(({ file, value }) => [file, value]));

    test("the incident's 18 GiB box: a wall 3.5 GiB under the cap, 4 GiB of swap, and no group kill", () => {
        expect(bounds({ capBytes: 18 * GIB })).toEqual({ "memory.max": String(14.5 * GIB), "memory.swap.max": String(4 * GIB), "memory.oom.group": "0" });
    });

    test("the swap ic wrote on a live reshape wins over the one it set on the container, which wins over the default", () => {
        expect(bounds({ capBytes: 16 * GIB, swapEnv: "2g" })["memory.swap.max"]).toBe(String(2 * GIB));
        expect(bounds({ capBytes: 16 * GIB, swapEnv: "2g", override: '{"swapGib": 6}' })["memory.swap.max"]).toBe(String(6 * GIB));
        // Neither is ever zero, and a torn file or a word for a size is no bound at all.
        expect(bounds({ capBytes: 16 * GIB, swapEnv: "0g", override: '{"swapGib": 0}' })["memory.swap.max"]).toBe(String(4 * GIB));
        expect(bounds({ capBytes: 16 * GIB, swapEnv: "lots", override: '{"swapG' })["memory.swap.max"]).toBe(String(4 * GIB));
    });

    test("a sandbox with no cap has no wall, and the machine's memory sizes its swap", () => {
        expect(bounds({ machineBytes: 8 * GIB })).toEqual({ "memory.max": "max", "memory.swap.max": String(2 * GIB), "memory.oom.group": "0" });
    });

    test("a pass writes only what differs, and reads the cap, the machine and the override fresh", async () => {
        const { io, writes } = fakeFiles({
            [`${ROOT}/memory.max`]: `${16 * GIB}\n`,
            "/proc/meminfo": "MemTotal:       20479632 kB\n",
            [`${WORKLOAD}/memory.max`]: "max\n",
            [`${WORKLOAD}/memory.swap.max`]: "max\n",
            [`${WORKLOAD}/memory.oom.group`]: "0\n",
        });
        const check = await checkWorkloadLeaf(ROOT, undefined, io);
        expect(check.restored).toEqual([
            { file: "memory.max", was: "max", now: String(12.5 * GIB) },
            { file: "memory.swap.max", was: "max", now: String(4 * GIB) },
        ]);
        expect(writes).toEqual([[`${WORKLOAD}/memory.max`, String(12.5 * GIB)], [`${WORKLOAD}/memory.swap.max`, String(4 * GIB)]]);
        expect((await checkWorkloadLeaf(ROOT, undefined, io)).restored).toEqual([]);
    });
});

describe("the keeper and the workload leaf", () => {
    const keep = async (texts: Record<string, string>, options: { readonly ppid?: number; readonly refuse?: ReadonlySet<string> } = {}) => {
        const { io, writes } = fakeFiles(texts, options.refuse);
        const said: { level: string; fields: unknown; message: string | undefined }[] = [];
        const logger = {
            warn: (fields: unknown, message?: string) => void said.push({ level: "warn", fields, message }),
            info: (fields: unknown, message?: string) => void said.push({ level: "info", fields, message }),
        };
        const keeper = startDaemonCgroupKeeper(logger, { io, intervalMs: 5, container: true, pid: 64, ppid: options.ppid ?? 7, swapEnv: undefined });
        return {
            writes,
            said,
            texts,
            settle: async (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms)),
            stop: () => keeper.stop(),
        };
    };
    const leaves = (self: string) =>
        ({
        "/proc/self/cgroup": `0::${self}\n`,
        "/proc/7/cgroup": "0::/daemon\n",
        [`${ROOT}/memory.max`]: `${18 * GIB}\n`,
        [`${LEAF}/memory.swap.max`]: "0\n",
        [`${LEAF}/cpu.weight`]: "1000\n",
        [`${LEAF}/cgroup.procs`]: "7\n",
        [`${WORKLOAD}/cgroup.procs`]: "64\n",
        [`${WORKLOAD}/memory.max`]: "max\n",
        [`${WORKLOAD}/memory.swap.max`]: "max\n",
        [`${WORKLOAD}/memory.oom.group`]: "0\n",
        }) satisfies Record<string, string>;

    // Observed live on 2026-11-05: the daemon (pid 64) in `workload`, beside the runaway and under its bounds.
    test("a daemon found in the workload leaf beside netd's moves itself back into its own, said once", async () => {
        const run = await keep(leaves("/workload"));
        try {
            await run.settle();
            expect(run.writes).toContainEqual([`${LEAF}/cgroup.procs`, "64"]);
            const moved = run.said.filter((line) => line.message?.includes("moved it back into its own") === true);
            expect(moved).toEqual([{ level: "warn", fields: { leaf: LEAF, from: WORKLOAD }, message: expect.any(String) }]);
            // Kept from there on, the workload leaf's bounds with it.
            expect(run.texts[`${WORKLOAD}/memory.swap.max`]).toBe(`${4 * GIB}\n`);
        } finally {
            run.stop();
        }
    });

    test("a second daemon an agent started stays in the workload leaf, and leaves its bounds to the one netd runs", async () => {
        const run = await keep({ ...leaves("/workload"), "/proc/9/cgroup": "0::/workload\n" }, { ppid: 9 });
        try {
            await run.settle();
            expect(run.writes).toEqual([]);
            expect(run.said).toEqual([]);
        } finally {
            run.stop();
        }
    });

    test("a move the kernel refuses is said once, and the leaf is kept all the same", async () => {
        const run = await keep(leaves("/workload"), { refuse: new Set([`${LEAF}/cgroup.procs`]) });
        try {
            await run.settle();
            expect(run.said.filter((line) => line.message?.includes("moving it back into its own was refused") === true)).toHaveLength(1);
            expect(run.texts[`${WORKLOAD}/memory.max`]).toBe(`${14.5 * GIB}\n`);
        } finally {
            run.stop();
        }
    });

    test("each bound a live reshape sets is said once, and a bound reset to the same wrong value is not said again", async () => {
        const run = await keep(leaves("/daemon"));
        try {
            await run.settle();
            const set = () => run.said.filter((line) => line.level === "info").map((line) => line.fields);
            expect(set()).toEqual([
                { leaf: WORKLOAD, file: "memory.max", was: "max", now: String(14.5 * GIB) },
                { leaf: WORKLOAD, file: "memory.swap.max", was: "max", now: String(4 * GIB) },
            ]);
            // Something resets the swap: put back, not said a second time.
            run.texts[`${WORKLOAD}/memory.swap.max`] = "max\n";
            await run.settle();
            expect(run.texts[`${WORKLOAD}/memory.swap.max`]).toBe(`${4 * GIB}\n`);
            expect(set()).toHaveLength(2);
            // ic reshapes it live to 6 GiB: a new bound, a line of its own.
            run.texts[WORKLOAD_BOUNDS_OVERRIDE] = '{"swapGib": 6}\n';
            await run.settle();
            expect(run.texts[`${WORKLOAD}/memory.swap.max`]).toBe(`${6 * GIB}\n`);
            expect(set().at(-1)).toEqual({ leaf: WORKLOAD, file: "memory.swap.max", was: String(4 * GIB), now: String(6 * GIB) });
        } finally {
            run.stop();
        }
    });

    test("a swap bound the leaf refuses is said once as a warning", async () => {
        const run = await keep(leaves("/daemon"), { refuse: new Set([`${WORKLOAD}/memory.swap.max`]) });
        try {
            await run.settle();
            await run.settle();
            expect(run.said.filter((line) => line.message?.includes("writing it was refused") === true).map((line) => line.fields)).toEqual([
                { leaf: WORKLOAD, file: "memory.swap.max", reason: "EBUSY" },
            ]);
        } finally {
            run.stop();
        }
    });
});
