import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const entrypoint = readFileSync(fileURLToPath(new URL("../docker-entrypoint.sh", import.meta.url)), "utf8");

/* The heap and the memory.high brake are sized from what the box HAS, and an owner's cap past the engine never binds. */
describe(`entrypoint memory sizing`, () => {
    const GIB = 1024 ** 3;
    // The WSL guest's MemTotal behind a 20 GB .wslconfig, in KiB.
    const GUEST_KIB = 20_479_632;
    const sizing = entrypoint.slice(entrypoint.indexOf("heap_mb=1536"), entrypoint.indexOf("exec node"));
    // The sizing lines run against a staged memory.max, memory.high and meminfo; answers the heap and the brake written.
    const size = (memoryMax: string, engineKib: number): { heapMb: number; high: string } => {
        const dir = mkdtempSync(join(tmpdir(), "entrypoint-"));
        writeFileSync(join(dir, "memory.max"), `${memoryMax}\n`);
        writeFileSync(join(dir, "memory.high"), "max\n");
        writeFileSync(join(dir, "meminfo"), `MemTotal:       ${engineKib} kB\nMemFree:          812344 kB\n`);
        // The whole cgroup root is staged, never only the files named: the slice also holds the daemon's own cgroup
        // setup, which run against the real root would move this machine's processes.
        const script = sizing.replaceAll("/sys/fs/cgroup", dir).replaceAll("/proc/meminfo", join(dir, "meminfo"));
        const run = spawnSync("sh", ["-ec", `${script}\necho "$heap_mb"`], { encoding: "utf8", env: { PATH: process.env["PATH"] ?? "" } });
        return { heapMb: Number(run.stdout.trim()), high: readFileSync(join(dir, "memory.high"), "utf8").trim() };
    };
    // The script's own integer order: divide by 100, then take the percentage.
    const brake = (bytes: number): string => String(Math.floor(bytes / 100) * 90);

    it(`sizes from the cap where the cap binds`, () => {
        expect(size(String(16 * GIB), GUEST_KIB)).toEqual({ heapMb: 3072, high: brake(16 * GIB) });
    });

    it(`sizes from the engine where the cap is past it`, () => {
        expect(size(String(64 * GIB), GUEST_KIB).high).toBe(brake(GUEST_KIB * 1024));
        // A small engine under a big cap: a quarter of the engine's 4 GiB, not of the 64 nobody has.
        expect(size(String(64 * GIB), 4 * 1024 * 1024)).toEqual({ heapMb: 1024, high: brake(4 * GIB) });
    });

    it(`leaves an uncapped box on the middle heap and unbraked`, () => {
        expect(size("max", GUEST_KIB)).toEqual({ heapMb: 1536, high: "max" });
    });
});

/* The daemon's own cgroup, run against a staged root: every process of the root moves to `workload` first, controllers
   open for the children, and the daemon's leaf keeps its memory resident at a larger cpu and io weight. */
describe(`entrypoint daemon cgroup`, () => {
    const setup = entrypoint.slice(entrypoint.indexOf("cgroup_root=/sys/fs/cgroup"), entrypoint.indexOf("# UV_THREADPOOL_SIZE"));
    const stage = (controllers: string): string => {
        const root = mkdtempSync(join(tmpdir(), "entrypoint-cgroup-"));
        writeFileSync(join(root, "cgroup.controllers"), `${controllers}\n`);
        writeFileSync(join(root, "cgroup.subtree_control"), "");
        writeFileSync(join(root, "cgroup.procs"), "1\n7\n");
        return root;
    };
    const run = (root: string): void => {
        const script = setup.replaceAll("/sys/fs/cgroup", root);
        spawnSync("sh", ["-ec", script], { encoding: "utf8", env: { PATH: process.env["PATH"] ?? "" } });
    };
    const read = (path: string): string => readFileSync(path, "utf8").trim();

    it(`keeps the daemon resident and weighted above its workload, once the root is emptied into a leaf`, () => {
        const root = stage("cpuset cpu io memory pids");
        run(root);
        expect(read(join(root, "workload", "cgroup.procs"))).toBe("7");
        expect(read(join(root, "cgroup.subtree_control"))).toBe("+memory");
        expect(read(join(root, "daemon", "memory.swap.max"))).toBe("0");
        expect(read(join(root, "daemon", "cpu.weight"))).toBe("1000");
        expect(read(join(root, "daemon", "io.weight"))).toBe("default 1000");
    });

    it(`touches nothing where cgroup2 offers no memory controller`, () => {
        const root = stage("cpuset cpu pids");
        mkdirSync(join(root, "daemon"));
        run(root);
        expect(() => read(join(root, "daemon", "memory.swap.max"))).toThrow();
        expect(read(join(root, "cgroup.subtree_control"))).toBe("");
    });
});
