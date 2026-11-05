import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOomDetector, type KnownProcess, knownOf, openKernelLog } from "./cgroup-oom.js";
import { type KernelLine, kernelLinesOf } from "./kernel-oom-lines.js";
import { VERIFIED_WORKLOAD_MEMCG, verifiedDmesg } from "./kernel-oom-lines.testing.js";
import type { MemoryKill } from "./memory-records.js";

/* The kernel's own words for the 2026-11-05 runaway, as the VM logged a cgroup kill: the pid is the VM's, not the
   container's, which is why a kill is matched to a process by its name among the ones the last scan saw that are gone.
   The lines are parsed by kernel-oom-lines.ts (tested beside it); these are what the detector makes of them. */
const KIB = 1024;
const GIB = 1024 ** 3;
const LEAF = "/sys/fs/cgroup/workload";
const CONSTRAINT =
    "oom-kill:constraint=CONSTRAINT_MEMCG,nodemask=(null),cpuset=/,mems_allowed=0,oom_memcg=/docker/a4ba63bf2aa5/workload,task_memcg=/docker/a4ba63bf2aa5/workload,task=integra,pid=19443,uid=0";
const KILLED =
    "Memory cgroup out of memory: Killed process 19443 (integra) total-vm:62522052kB, anon-rss:17658000kB, file-rss:0kB, shmem-rss:0kB, UID:0 pgtables:36000kB oom_score_adj:600";

const record = (text: string, bootUs = 236_305_229_539): KernelLine => ({ bootUs, text });

describe("the kernel's log", () => {
    test("a reader that cannot open the log answers nothing rather than throwing, and a stand-in file reads to its end", () => {
        expect(openKernelLog("/nonexistent/kmsg").read()).toBeUndefined();
        const dir = mkdtempSync(join(tmpdir(), "kmsg-"));
        writeFileSync(join(dir, "kmsg"), `6,1,2,-;${CONSTRAINT}\n SUBSYSTEM=memory\n3,2,5,-;${KILLED}\n`);
        const log = openKernelLog(join(dir, "kmsg"));
        try {
            expect(log.read()).toEqual([
                { bootUs: 2, text: CONSTRAINT },
                { bootUs: 5, text: KILLED },
            ]);
            expect(log.read()).toEqual([]);
        } finally {
            log.close();
        }
    });
});

describe("naming a kill in the workload leaf", () => {
    // The game client as the last scan saw it, stamped by its conversation and in its background job's session.
    const integra: KnownProcess = knownOf({
        pid: 502,
        name: "integra",
        owner: "sub-tidy-pebble-aii1",
        jobId: "job-1",
        argv: "./integra --headless",
        pgrp: 500,
        rssBytes: 16 * GIB,
        rssHighWaterBytes: 17 * GIB,
        swapBytes: 3 * GIB,
        startTimeTicks: 9_000,
    });
    const editor: KnownProcess = knownOf({ pid: 600, name: "node", rssBytes: GIB, swapBytes: 0 });

    const stage = () => {
        const files = new Map([
            [`${LEAF}/memory.events`, "low 0\nhigh 0\nmax 4\noom 0\noom_kill 0\noom_group_kill 0\n"],
            [`${LEAF}/memory.max`, `${14.5 * GIB}\n`],
            [`${LEAF}/memory.swap.max`, `${4 * GIB}\n`],
            [`${LEAF}/memory.pressure`, "some avg10=81.20 avg60=40.00 avg300=9.00 total=1\nfull avg10=64.50 avg60=30.00 avg300=7.00 total=1\n"],
            ["/proc/uptime", "236400.00 100.00\n"],
        ]);
        const pending: KernelLine[] = [];
        let logReadable = true;
        const recorded: MemoryKill[] = [];
        const detector = createOomDetector({
            leaf: async () => LEAF,
            read: async (path) => files.get(path),
            kernelLog: () => (logReadable ? pending.splice(0) : undefined),
            record: async (kill) => void recorded.push(kill),
            now: () => 1_762_340_000_000,
        });
        return {
            files,
            pending,
            recorded,
            detector,
            kill: (count: number) => {
                files.set(`${LEAF}/memory.events`, `oom 1\noom_kill ${count}\n`);
            },
            unreadable: () => {
                logReadable = false;
            },
        };
    };

    test("the first look only sets where counting starts: an older kill is the boot's post-mortem's", async () => {
        const run = stage();
        run.kill(3);
        run.pending.push(record(CONSTRAINT), record(KILLED));
        expect(await run.detector.observe([integra, editor])).toEqual([]);
        expect(run.recorded).toEqual([]);
    });

    test("a kill since the last look is named as the process the last scan knew: its own pid, owner, job and argv", async () => {
        const run = stage();
        await run.detector.observe([integra, editor]);
        run.kill(1);
        run.pending.push(record(CONSTRAINT), record(KILLED));
        const [kill, ...more] = await run.detector.observe([editor]);
        expect(more).toEqual([]);
        expect(kill).toEqual({
            at: expect.any(Number),
            killer: "cgroup-oom",
            cgroup: "/docker/a4ba63bf2aa5/workload",
            pid: 502,
            comm: "integra",
            argv: "./integra --headless",
            // The larger of what the kernel saw at the kill and the peak the scan saw.
            rssBytes: 17 * GIB,
            swapBytes: 3 * GIB,
            pgid: 500,
            owner: "sub-tidy-pebble-aii1",
            jobId: "job-1",
            psi: { someAvg10: 81.2, fullAvg10: 64.5 },
            reason: "the workload cgroup every agent process runs in reached its bounds (memory.max 14.5 GiB, swap 4.0 GiB), and the kernel killed the process it scored worst",
        });
        expect(run.recorded).toEqual([kill!]);
        // Named once: the next look has nothing new.
        expect(await run.detector.observe([editor])).toEqual([]);
    });

    test("another sandbox's kill in the same log is not this leaf's when the counter already has its own", async () => {
        const run = stage();
        await run.detector.observe([integra, editor]);
        run.kill(1);
        const elsewhere = (pid: number, comm: string): string =>
            `Memory cgroup out of memory: Killed process ${pid} (${comm}) total-vm:1kB, anon-rss:900kB, file-rss:0kB, shmem-rss:0kB, UID:0 pgtables:4kB oom_score_adj:0`;
        run.pending.push(record(elsewhere(31_000, "postgres")), record(CONSTRAINT), record(KILLED), record(elsewhere(31_001, "redis")));
        expect((await run.detector.observe([editor])).map((kill) => kill.comm)).toEqual(["integra"]);
    });

    test("a process born and killed between two scans is still named, by what the kernel said of it", async () => {
        const run = stage();
        await run.detector.observe([editor]);
        run.kill(1);
        run.pending.push(record(KILLED));
        expect(await run.detector.observe([editor])).toEqual([
            expect.objectContaining({ pid: 19_443, comm: "integra", rssBytes: 17_658_000 * KIB, killer: "cgroup-oom" }),
        ]);
    });

    test("between ticks, a process is gone when /proc no longer has it", async () => {
        const run = stage();
        await run.detector.observe([integra, editor]);
        run.files.set("/proc/600/stat", "600 (node) S 1 600 600 0 -1 0 0 0 0 0 0 0 0 0 0 0 0 0 1 0 0 0");
        run.kill(1);
        run.pending.push(record(KILLED));
        expect((await run.detector.check()).map((kill) => [kill.pid, kill.jobId])).toEqual([[502, "job-1"]]);
    });

    test("with no kernel log to read, the counter says how many and the largest process gone is named as an inference", async () => {
        const run = stage();
        await run.detector.observe([integra, editor]);
        run.unreadable();
        run.kill(1);
        const [kill] = await run.detector.observe([]);
        expect(kill).toMatchObject({ pid: 502, comm: "integra", owner: "sub-tidy-pebble-aii1", jobId: "job-1" });
        expect(kill?.reason).toMatch(/the kernel's log could not be read, so this is the largest one gone/u);
    });

    test("a leaf made again, its counter back at zero, starts counting over without naming anything", async () => {
        const run = stage();
        run.kill(5);
        await run.detector.observe([integra]);
        run.kill(0);
        expect(await run.detector.observe([])).toEqual([]);
        run.kill(1);
        run.pending.push(record(KILLED));
        expect(await run.detector.observe([])).toHaveLength(1);
    });

    test("a kill the whole machine made is the kernel's, said as the machine running out", async () => {
        const run = stage();
        await run.detector.observe([integra, editor]);
        run.kill(1);
        run.pending.push(
            record("oom-kill:constraint=CONSTRAINT_NONE,nodemask=(null),cpuset=/,mems_allowed=0,global_oom,task_memcg=/docker/a4ba63bf2aa5/workload,task=integra,pid=19443,uid=0"),
            record(KILLED.replace("Memory cgroup out of memory", "Out of memory")),
        );
        const [kill] = await run.detector.observe([editor]);
        expect(kill).toMatchObject({ killer: "kernel-oom", pid: 502, owner: "sub-tidy-pebble-aii1", cgroup: "/docker/a4ba63bf2aa5/workload" });
        expect(kill?.reason).toBe("the machine the sandbox runs on ran out of memory, and the kernel killed the process it scored worst");
    });

    test("a look between a kill's two lines names it from its oom-kill line, and the late Killed line names nothing more", async () => {
        const run = stage();
        await run.detector.observe([integra, editor]);
        run.kill(1);
        run.pending.push(record(CONSTRAINT));
        const [kill, ...more] = await run.detector.observe([editor]);
        expect(more).toEqual([]);
        // No size from the kernel yet: the scan's peak stands.
        expect(kill).toMatchObject({ killer: "cgroup-oom", pid: 502, jobId: "job-1", cgroup: "/docker/a4ba63bf2aa5/workload", rssBytes: 17 * GIB });
        run.pending.push(record(KILLED));
        expect(await run.detector.observe([editor])).toEqual([]);
    });

    test("the verification's kill on a real kernel is named as the stress process the scan knew, by its own pid", async () => {
        const run = stage();
        const stress = knownOf({ pid: 88, name: "stress-ng-vm", owner: "brisk-ridge-27nl", pgrp: 80, rssBytes: 2 * GIB, swapBytes: GIB });
        await run.detector.observe([stress, editor]);
        run.kill(1);
        run.pending.push(...kernelLinesOf(verifiedDmesg()));
        expect(await run.detector.observe([editor])).toEqual([
            expect.objectContaining({
                killer: "cgroup-oom",
                cgroup: VERIFIED_WORKLOAD_MEMCG,
                pid: 88,
                comm: "stress-ng-vm",
                owner: "brisk-ridge-27nl",
                pgid: 80,
                // What the kernel saw resident (anon, file and shmem), larger than the scan's last reading.
                rssBytes: (3_112_052 + 544) * KIB,
            }),
        ]);
    });
});
