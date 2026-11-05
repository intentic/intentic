import { kernelLinesOf } from "../../resources/kernel-oom-lines.js";
import type { NetdKill } from "../../resources/memory-records.js";
import {
    assemblePostMortem,
    attributeKernelKill,
    type DatedKernelKill,
    kernelKillsIn,
    postMortemForRecord,
    type PostMortemInput,
    postMortemSince,
} from "./post-mortem.js";
import {
    at,
    BOOT_AT,
    CONTAINER_ID,
    CULPRIT,
    DAEMON_PID,
    guardKill,
    KERNEL_ZERO,
    KILLED_AT,
    kmsgText,
    netdKills,
    NIGHT_SUMMARY,
    pressure,
    RUNAWAY_PID,
    STARTED_AT,
    WORKLOAD_MEMCG,
} from "./memory-incident.testing.js";

/* What the boot after 2026-11-05 concludes from the records, assembled from records already read. */

const MINUTE = 60_000;
const KIB = 1024;

const nightKill = (): DatedKernelKill => {
    const [kill] = kernelKillsIn({ lines: kernelLinesOf(kmsgText()), source: "kmsg" }, KERNEL_ZERO, STARTED_AT, BOOT_AT);
    if (kill === undefined) {
        throw new Error("the night's kernel lines held no kill");
    }
    return kill;
};

const input = (overrides: Partial<PostMortemInput> = {}): PostMortemInput => ({
    previous: { pid: DAEMON_PID, startedAt: STARTED_AT },
    bootAt: BOOT_AT,
    since: STARTED_AT,
    kills: [],
    netd: netdKills(),
    pressure: pressure(),
    kernel: [nightKill()],
    kernelElsewhere: 0,
    kernelLog: { source: "kmsg", reachesBackTo: at("01:00:00") },
    ...overrides,
});

test("the night: netd's kills and the kernel's global OOM name the cause, the runaway's conversation, and the hand that ended the run", () => {
    const { postMortem, namedEnding } = assemblePostMortem(input());
    expect(postMortem.cause).toBe("memory");
    expect(namedEnding).toBe("netd-stuck");
    expect(postMortem.culprits).toEqual([CULPRIT]);
    expect(postMortem.summary).toBe(NIGHT_SUMMARY);
    expect(postMortem.netd).toHaveLength(35);
    expect(postMortem.killed).toEqual([
        {
            at: KILLED_AT,
            killer: "kernel-oom",
            pid: RUNAWAY_PID,
            comm: "integra",
            rssBytes: 17_658_000 * KIB,
            swapBytes: 33_000_000_000,
            owner: CULPRIT,
            cgroup: WORKLOAD_MEMCG,
            reason: expect.stringContaining("its pid 19443 is the machine's; matched to pid 1077125 here by name and size in netd's sample at 2026-11-05T04:21:40.000Z"),
        },
    ]);
});

test("a kernel kill's victim is the same-named process in netd's newest sample before it, the nearest in size of several", () => {
    const kill = { at: KILLED_AT, comm: "integra", residentBytes: 17_658_000 * KIB };
    expect(attributeKernelKill(kill, pressure())).toMatchObject({ pid: RUNAWAY_PID, owner: CULPRIT, sampleAt: at("04:21:40") });
    // A small kill of the same name is the small process, not the runaway.
    expect(attributeKernelKill({ ...kill, residentBytes: 40_000_000 }, pressure())).toMatchObject({ pid: 1_077_300, owner: "one-shot" });
    // Only the older sample lists the daemon's name; a sample after the kill counts only when none before it does.
    expect(attributeKernelKill({ at: at("02:35:00"), comm: "MainThread" }, pressure())).toMatchObject({ pid: DAEMON_PID, sampleAt: at("02:30:00") });
    expect(attributeKernelKill({ at: at("02:29:50"), comm: "MainThread" }, pressure())).toMatchObject({ pid: DAEMON_PID, sampleAt: at("02:30:00") });
    // Out of reach: no sample within ten minutes, or none that names it.
    expect(attributeKernelKill({ at: at("03:00:00"), comm: "integra" }, pressure())).toBeUndefined();
    expect(attributeKernelKill({ at: KILLED_AT, comm: "java" }, pressure())).toBeUndefined();
});

test("a kernel kill no sample names is said with the kernel's own pid", () => {
    const { postMortem } = assemblePostMortem(input({ pressure: [] }));
    expect(postMortem.killed[0]).toMatchObject({ pid: 19443, comm: "integra" });
    expect(postMortem.killed[0]).not.toHaveProperty("owner");
    expect(postMortem.culprits).toEqual([]);
    expect(postMortem.summary).toContain("integra (the kernel's pid 19443, 16.8 GB) was killed by the kernel's global OOM at 04:21:57 UTC");
});

test("the kernel killing the daemon itself is an oom-victim, and the daemon is no culprit", () => {
    const daemonLeaf = WORKLOAD_MEMCG.replace(/workload$/u, "daemon");
    const kill: DatedKernelKill = { ...nightKill(), comm: "MainThread", pid: 19001, taskMemcg: daemonLeaf, anonRssBytes: 3 * 1024 ** 3, at: at("02:35:00") };
    const { postMortem, namedEnding } = assemblePostMortem(input({ kernel: [kill], netd: [], pressure: [] }));
    expect(postMortem.cause).toBe("oom-victim");
    expect(namedEnding).toBe("oom-victim");
    expect(postMortem.culprits).toEqual([]);
    expect(postMortem.killed[0]).toMatchObject({ owner: "daemon", killer: "kernel-oom" });
    expect(postMortem.summary).toBe("the daemon itself (the kernel's pid 19001, 3.0 GB) was killed by the kernel's global OOM at 02:35:00 UTC");
});

test("netd killing a stuck daemon with nothing killed for memory is netd-stuck", () => {
    const stuck: NetdKill = { at: at("03:00:00"), kind: "stuck", pid: DAEMON_PID, silentMs: 300_000, psi: { someAvg10: 12.4, fullAvg10: 3 } };
    const { postMortem, namedEnding } = assemblePostMortem(input({ kernel: [], netd: [stuck] }));
    expect(postMortem).toMatchObject({ cause: "netd-stuck", culprits: [], killed: [] });
    expect(namedEnding).toBe("netd-stuck");
    expect(postMortem.summary).toBe("netd killed the daemon after its event loop stopped answering for 300 s while memory pressure was 12%");
    // netd's kill of another daemon (an earlier pid) names the cause, but not the hand that ended this run.
    expect(assemblePostMortem(input({ kernel: [], netd: [{ ...stuck, pid: 7 }] })).namedEnding).toBeUndefined();
});

test("recorded kills keep their owner and job; the daemon's own and one-shots are no culprits; the kernel's copy of a recorded memcg kill is dropped", () => {
    const memcgKernel: DatedKernelKill = { ...nightKill(), scope: "memcg", comm: "node", pid: 30_000, at: at("03:10:20") };
    const { postMortem } = assemblePostMortem(
        input({
            kernel: [memcgKernel],
            netd: [],
            kills: [
                guardKill(),
                guardKill({ at: at("03:05:00"), pid: 4300, comm: "esbuild", owner: "daemon", rssBytes: 1024 ** 3 }),
                guardKill({ at: at("03:06:00"), pid: 4400, comm: "sh", owner: "one-shot", rssBytes: 1024 ** 2 }),
                guardKill({ at: at("03:10:00"), killer: "cgroup-oom", pid: 4500, comm: "node", owner: "lively-sage-ndvm", reason: "workload memory.max" }),
                // Outside the span: before the previous run started.
                guardKill({ at: STARTED_AT - MINUTE, owner: "noble-forge-r92c" }),
            ],
        }),
    );
    expect(postMortem.cause).toBe("memory");
    expect(postMortem.killed.map((kill) => kill.pid)).toEqual([4242, 4300, 4400, 4500]);
    expect(postMortem.culprits).toEqual(["wise-fern-usz1", "lively-sage-ndvm"]);
    expect(postMortem.summary).toBe(
        "node (pid 4242, 17.0 GB) from job job-7 of wise-fern-usz1 was killed by netd's memory guard at 03:00:00 UTC; " +
            "esbuild (pid 4300, 1.0 GB) (one of the daemon's own) was killed by netd's memory guard at 03:05:00 UTC; " +
            "node (pid 4500, 17.0 GB) from job job-7 of lively-sage-ndvm was killed by the kernel at the sandbox's own memory bound at 03:10:00 UTC; " +
            "and one more process killed for memory",
    );
});

test("with nothing on file, the sentence says what was looked at, and why the kernel's log could not be", () => {
    const empty = { kernel: [], netd: [], kills: [] };
    expect(assemblePostMortem(input(empty)).postMortem).toEqual({
        cause: "unknown",
        killed: [],
        netd: [],
        culprits: [],
        summary:
            "nothing on file names the hand: no process was killed for memory, netd killed no daemon, and the kernel's log (it reaches back to 2026-11-05T01:00:00.000Z) has no OOM kill in this sandbox",
    });
    const denied = assemblePostMortem(input({ ...empty, kernelLog: { source: "none", problem: "/dev/kmsg: EPERM" }, kernelElsewhere: 2, unreadable: "pressure.jsonl: EIO" }));
    expect(denied.postMortem.summary).toBe(
        "nothing on file names the hand: no process was killed for memory, netd killed no daemon, and the kernel's log could not be read (/dev/kmsg: EPERM); " +
            "the kernel's global OOM also killed 2 processes outside this sandbox; some records could not be read (pressure.jsonl: EIO)",
    );
    expect(denied.namedEnding).toBeUndefined();
});

test("the span reaches back past every boot netd killed before its hello, to the run that began it", () => {
    const stuckRun = at("02:18:38");
    const failed = [at("02:42:30"), at("02:45:30")];
    const kills: NetdKill[] = [
        { at: at("02:39:18"), kind: "stuck", pid: DAEMON_PID, silentMs: 300_000 },
        { at: at("02:45:20"), kind: "no-hello", silentMs: 178_000 },
        { at: at("02:48:20"), kind: "no-hello", silentMs: 175_000 },
    ];
    const boots = [at("01:12:22"), stuckRun, ...failed];
    // The marker belongs to the last failed start; the span goes back to the run that got stuck.
    expect(postMortemSince(at("02:45:30.050"), boots, kills, BOOT_AT)).toBe(stuckRun);
    // A run that said hello is where it stops; one that left no marker starts at the newest boot.
    expect(postMortemSince(STARTED_AT, boots.slice(0, 2), kills, BOOT_AT)).toBe(STARTED_AT);
    expect(postMortemSince(undefined, [at("01:12:22")], [], BOOT_AT)).toBe(at("01:12:22"));
    expect(postMortemSince(undefined, [], [], BOOT_AT)).toBe(BOOT_AT - 24 * 60 * MINUTE);
});

test("the restart record keeps every stuck kill and the newest of the rest", () => {
    const { postMortem } = assemblePostMortem(input());
    const kept = postMortemForRecord(postMortem);
    expect(kept.netd).toHaveLength(11);
    expect(kept.netd[0]).toMatchObject({ kind: "stuck" });
    expect(kept.netd.at(-1)).toEqual(postMortem.netd.at(-1));
    expect(kept.summary).toBe(postMortem.summary);
    expect(CONTAINER_ID).toHaveLength(64);
});
