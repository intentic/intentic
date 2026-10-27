import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const entrypoint = readFileSync(fileURLToPath(new URL("../docker-entrypoint.sh", import.meta.url)), "utf8");

/* The heap and the memory.high brake are sized from what the box HAS, and an owner's cap past the engine never binds. */
describe(`entrypoint memory sizing`, () => {
    const GIB = 1024 ** 3;
    // The WSL guest's MemTotal behind a 20 GB .wslconfig, in KiB.
    const GUEST_KIB = 20_479_632;
    const sizing = entrypoint.slice(entrypoint.indexOf("heap_mb=1536"), entrypoint.indexOf("exec /opt/sandbox/netd/intentic-netd"));
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

/* The cgroup section runs against a staged root, and against a staged mount table and namespace beside it: the root's
   cgroup2 mount as Docker made it (read-write when privileged, read-only otherwise) and this container's own cgroup. */
const cgroupSetup = (): string => {
    const helper = entrypoint.match(/^cgroup_set\(\) .*$/m)?.[0] ?? "";
    return `${helper}\n${entrypoint.slice(entrypoint.indexOf("cgroup_root=/sys/fs/cgroup"), entrypoint.indexOf("# UV_THREADPOOL_SIZE"))}`;
};
// Where the staged mount table and namespace file live: beside the root, never inside it, as /proc is beside /sys.
const proc = (root: string) => ({ mounts: `${root}.mounts`, self: `${root}.self-cgroup` }) as const;
const stageMount = (root: string, options: string, self = "/"): void => {
    writeFileSync(proc(root).mounts, `proc /proc proc rw,nosuid 0 0\ncgroup ${root} cgroup2 ${options},nosuid,nodev,noexec,relatime,nsdelegate 0 0\n`);
    writeFileSync(proc(root).self, `0::${self}\n`);
};
const cgroupScript = (setup: string, root: string): string =>
    setup.replaceAll("/sys/fs/cgroup", root).replaceAll("/proc/mounts", proc(root).mounts).replaceAll("/proc/self/cgroup", proc(root).self);

/* The daemon's own cgroup, run against a staged root: every process of the root moves to `workload` first, controllers
   open for the children, and the daemon's leaf keeps its memory resident at a larger cpu and io weight. */
describe(`entrypoint daemon cgroup`, () => {
    const setup = cgroupSetup();
    const stage = (controllers: string): string => {
        const root = mkdtempSync(join(tmpdir(), "entrypoint-cgroup-"));
        writeFileSync(join(root, "cgroup.controllers"), `${controllers}\n`);
        writeFileSync(join(root, "cgroup.subtree_control"), "");
        writeFileSync(join(root, "cgroup.procs"), "1\n7\n");
        stageMount(root, "rw");
        return root;
    };
    // Answers what the setup printed: the container log it would land in.
    const run = (root: string): string =>
        spawnSync("sh", ["-ec", cgroupScript(setup, root)], { encoding: "utf8", env: { PATH: process.env["PATH"] ?? "" } }).stderr;
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

    // A kernel without iocost has no io.weight: the daemon keeps every other knob, and the log hears nothing of it.
    it(`keeps the other knobs, silently, where the kernel lacks one`, () => {
        const root = stage("cpuset cpu io memory pids");
        mkdirSync(join(root, "daemon", "io.weight"), { recursive: true });
        expect(run(root)).toBe("");
        expect(read(join(root, "daemon", "memory.swap.max"))).toBe("0");
        expect(read(join(root, "daemon", "cpu.weight"))).toBe("1000");
    });

    it(`touches nothing where cgroup2 offers no memory controller`, () => {
        const root = stage("cpuset cpu pids");
        mkdirSync(join(root, "daemon"));
        run(root);
        expect(() => read(join(root, "daemon", "memory.swap.max"))).toThrow();
        expect(read(join(root, "cgroup.subtree_control"))).toBe("");
    });
});

/* A root that keeps refusing the memory controller (a process the move missed holds it, EBUSY): tried again, and said. */
describe(`entrypoint daemon cgroup, refused`, () => {
    const setup = cgroupSetup();

    it(`tries the controllers again, then says the daemon is not yet kept out of swap`, () => {
        const root = mkdtempSync(join(tmpdir(), "entrypoint-cgroup-"));
        writeFileSync(join(root, "cgroup.controllers"), "cpu io memory\n");
        writeFileSync(join(root, "cgroup.procs"), "1\n");
        // A directory where the control file should be: every write to it fails, as EBUSY would.
        mkdirSync(join(root, "cgroup.subtree_control"));
        stageMount(root, "rw");
        const script = cgroupScript(setup, root);
        mkdirSync(join(root, "daemon", "memory.swap.max"), { recursive: true });
        const run = spawnSync("sh", ["-ec", script], { encoding: "utf8", env: { PATH: process.env["PATH"] ?? "" } });
        expect(run.status).toBe(0);
        expect(run.stderr).toBe("intentic: the daemon's cgroup is not yet kept out of swap; the daemon tries again once it starts\n");
    });
});

/* Docker mounts cgroup2 read-only in a container it does not run privileged, as every compose sandbox is: root passed
   `[ -w ]` there and every write after it failed in silence, so the daemon's heap was free to swap (2026-10-27). */
describe(`entrypoint cgroup filesystem, read-only`, () => {
    const setup = cgroupSetup();
    // A `mount` ahead of the real one on PATH: notes what it was asked, then does what the kernel would, or refuses.
    const stub = (root: string, allowed: boolean) => {
        const bin = mkdtempSync(join(tmpdir(), "entrypoint-bin-"));
        const asked = join(bin, "asked");
        const outcome = allowed ? `sed -i 's/ cgroup2 ro,/ cgroup2 rw,/' "${proc(root).mounts}"` : "exit 32";
        writeFileSync(join(bin, "mount"), `#!/bin/sh\necho "$*" >> "${asked}"\n${outcome}\n`, { mode: 0o755 });
        return { bin, asked };
    };
    const stage = (self: string): string => {
        const root = mkdtempSync(join(tmpdir(), "entrypoint-cgroup-"));
        writeFileSync(join(root, "cgroup.controllers"), "cpu io memory\n");
        writeFileSync(join(root, "cgroup.subtree_control"), "");
        writeFileSync(join(root, "cgroup.procs"), "1\n7\n");
        stageMount(root, "ro", self);
        return root;
    };
    const run = (root: string, bin: string) =>
        spawnSync("sh", ["-ec", cgroupScript(setup, root)], { encoding: "utf8", env: { PATH: `${bin}:${process.env["PATH"] ?? ""}` } });
    const warning = /is read-only in this container, so the daemon's heap is not kept out of swap/u;

    it(`remounts it read-write in the container's own cgroup namespace, and the daemon gets its leaf`, () => {
        const root = stage("/");
        const { bin, asked } = stub(root, true);
        const ran = run(root, bin);
        expect(ran.status).toBe(0);
        expect(readFileSync(asked, "utf8")).toBe(`-o remount,rw ${root}\n`);
        expect(ran.stderr).toBe("");
        expect(readFileSync(join(root, "daemon", "memory.swap.max"), "utf8").trim()).toBe("0");
    });

    it(`says the heap is not kept out of swap where the remount is refused, and writes nothing`, () => {
        const root = stage("/");
        const ran = run(root, stub(root, false).bin);
        expect(ran.status).toBe(0);
        expect(ran.stderr).toMatch(warning);
        expect(existsSync(join(root, "daemon"))).toBe(false);
        expect(readFileSync(join(root, "cgroup.subtree_control"), "utf8")).toBe("");
    });

    // Under the host's cgroup namespace the root is the host's own, and nothing in it is this container's to move.
    it(`leaves a host namespace's cgroup filesystem as it found it`, () => {
        const root = stage("/system.slice/docker-0123abcd.scope");
        const { bin, asked } = stub(root, true);
        const ran = run(root, bin);
        expect(existsSync(asked)).toBe(false);
        expect(ran.stderr).toMatch(warning);
        expect(existsSync(join(root, "daemon"))).toBe(false);
    });
});
