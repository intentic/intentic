import { kernelLineOf, kernelLinesOf, oomKillsOf, residentBytesOf } from "./kernel-oom-lines.js";
import { VERIFIED_KILL_PID, VERIFIED_WORKLOAD_MEMCG, verifiedDmesg } from "./kernel-oom-lines.testing.js";

/* The kernel's two lines of an OOM kill, as /dev/kmsg and dmesg print them: the 2026-11-05 global kill, and a kill at the
   workload leaf's own bound from the same day's verification on a real kernel. */

const ID = "a8c75cbac8dc3f2e1a7b5c9d0e4f6a8b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f";
const MEMCG = `/wsl-user/distro-4261/docker/${ID}/workload`;
const OOM_KILL = `oom-kill:constraint=CONSTRAINT_NONE,nodemask=(null),cpuset=/,mems_allowed=0,global_oom,task_memcg=${MEMCG},task=integra,pid=19443,uid=0`;
const KILLED =
    "Out of memory: Killed process 19443 (integra) total-vm:62522052kB, anon-rss:17658000kB, file-rss:0kB, shmem-rss:0kB, UID:0 pgtables:36580kB oom_score_adj:600";
const KIB = 1024;

test("a /dev/kmsg record and a dmesg line are read to the same microsecond, and continuation lines are left out", () => {
    expect(kernelLineOf(`6,182300,236305229131,-;${KILLED}`)).toEqual({ bootUs: 236_305_229_131, text: KILLED });
    expect(kernelLineOf(`[236305.229131] ${KILLED}`)).toEqual({ bootUs: 236_305_229_131, text: KILLED });
    expect(kernelLineOf("[    5.5] early")).toEqual({ bootUs: 5_500_000, text: "early" });
    expect(kernelLineOf("[    1.123456789] nanoseconds")).toEqual({ bootUs: 1_123_456, text: "nanoseconds" });
    expect(kernelLinesOf(["4,1,10,-;first", " SUBSYSTEM=memory", "[0.000020] second", "                 active_file:1505820", ""].join("\n"))).toEqual([
        { bootUs: 10, text: "first" },
        { bootUs: 20, text: "second" },
    ]);
});

test("a record with more header fields reads by its third, and a line with no header is no line", () => {
    expect(kernelLinesOf(`3,9,12,-,caller=T42;${KILLED}\n SUBSYSTEM=memory\n`)).toEqual([{ bootUs: 12, text: KILLED }]);
    expect(kernelLineOf("no header here")).toBeUndefined();
    expect(kernelLineOf("x,y,z;text")).toBeUndefined();
});

test("the night's global OOM: the oom-kill line and the Killed process line are one kill, with every field the kernel gave", () => {
    const lines = kernelLinesOf([`4,182299,236305229000,-;${OOM_KILL}`, `3,182300,236305229131,-;${KILLED}`].join("\n"));
    expect(oomKillsOf(lines)).toEqual([
        {
            bootUs: 236_305_229_131,
            scope: "global",
            constraint: "CONSTRAINT_NONE",
            taskMemcg: MEMCG,
            comm: "integra",
            pid: 19443,
            uid: 0,
            totalVmBytes: 62_522_052 * KIB,
            anonRssBytes: 17_658_000 * KIB,
            fileRssBytes: 0,
            shmemRssBytes: 0,
            oomScoreAdj: 600,
        },
    ]);
});

test("the verification's kill at the workload leaf's bound, as a real kernel printed it, is one memcg kill", () => {
    const [kill, ...more] = oomKillsOf(kernelLinesOf(verifiedDmesg()));
    expect(more).toEqual([]);
    expect(kill).toEqual({
        bootUs: 1_561_485_721_680,
        scope: "memcg",
        constraint: "CONSTRAINT_MEMCG",
        taskMemcg: VERIFIED_WORKLOAD_MEMCG,
        oomMemcg: VERIFIED_WORKLOAD_MEMCG,
        comm: "stress-ng-vm",
        pid: VERIFIED_KILL_PID,
        uid: 0,
        totalVmBytes: 8_426_700 * KIB,
        anonRssBytes: 3_112_052 * KIB,
        fileRssBytes: 544 * KIB,
        shmemRssBytes: 0,
        oomScoreAdj: 1000,
    });
    // What the kernel saw resident: anon, file and shmem together.
    expect(kill === undefined ? undefined : residentBytesOf(kill)).toBe((3_112_052 + 544) * KIB);
});

test("a kill at the sandbox's own bound reads as a memcg kill, from its constraint and from its Killed line alike", () => {
    const leaf = `/docker/${ID}/workload`;
    const memcg = [
        `[100.000100] oom-kill:constraint=CONSTRAINT_MEMCG,nodemask=(null),cpuset=${ID},mems_allowed=0,oom_memcg=${leaf},task_memcg=${leaf},task=node,pid=4242,uid=1000`,
        "[100.000200] Memory cgroup out of memory: Killed process 4242 (node) total-vm:9000kB, anon-rss:8000kB, file-rss:100kB, shmem-rss:0kB, UID:1000 pgtables:40kB oom_score_adj:0",
    ].join("\n");
    expect(oomKillsOf(kernelLinesOf(memcg))).toMatchObject([
        { scope: "memcg", constraint: "CONSTRAINT_MEMCG", oomMemcg: leaf, taskMemcg: leaf, comm: "node", pid: 4242, uid: 1000, anonRssBytes: 8000 * KIB },
    ]);
    // An older kernel prints no oom-kill line: the Killed line's own prefix still says memcg.
    expect(oomKillsOf(kernelLinesOf(memcg.split("\n")[1] ?? ""))).toMatchObject([{ scope: "memcg", pid: 4242 }]);
    expect(oomKillsOf(kernelLinesOf(`[1.0] ${KILLED}`))).toMatchObject([{ scope: "global", comm: "integra" }]);
});

test("an oom-kill line whose Killed line never came is still a kill, with no sizes, and lines of two kills are not crossed", () => {
    const lines = kernelLinesOf(
        [
            `[10.0] ${OOM_KILL}`,
            // Twenty seconds on, the same pid number in another kill: not the first one's Killed line.
            "[30.0] oom-kill:constraint=CONSTRAINT_NONE,nodemask=(null),cpuset=/,mems_allowed=0,global_oom,task_memcg=/other,task=java,pid=19443,uid=0",
            "[30.1] Out of memory: Killed process 19443 (java) total-vm:10kB, anon-rss:5kB, file-rss:0kB, shmem-rss:0kB, UID:0 pgtables:4kB oom_score_adj:0",
        ].join("\n"),
    );
    const kills = oomKillsOf(lines);
    expect(kills).toEqual([
        { bootUs: 10_000_000, scope: "global", constraint: "CONSTRAINT_NONE", taskMemcg: MEMCG, comm: "integra", pid: 19443, uid: 0 },
        expect.objectContaining({ bootUs: 30_100_000, comm: "java", taskMemcg: "/other", anonRssBytes: 5 * KIB }),
    ]);
    expect(kills.map(residentBytesOf)).toEqual([undefined, 5 * KIB]);
});

test("a task name with a comma or with parentheses in it is read whole", () => {
    const [comma] = oomKillsOf(kernelLinesOf("[1.0] oom-kill:constraint=CONSTRAINT_NONE,global_oom,task_memcg=/workload,task=a,b,pid=7,uid=0"));
    expect(comma).toMatchObject({ comm: "a,b", pid: 7, taskMemcg: "/workload" });
    const [parens] = oomKillsOf(
        kernelLinesOf("[1.0] Out of memory: Killed process 77 (Web Content (1)) total-vm:100kB, anon-rss:10kB, file-rss:2kB, shmem-rss:1kB, UID:0 pgtables:4kB oom_score_adj:0"),
    );
    expect(parens).toMatchObject({ scope: "global", pid: 77, comm: "Web Content (1)" });
    expect(parens === undefined ? undefined : residentBytesOf(parens)).toBe(13 * KIB);
});
