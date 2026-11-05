import { opt } from "../../../opt.js";
import type { MemoryKill, NetdKill, PressureSample } from "../../resources/memory-records.js";

/* THE NIGHT OF 2026-11-05 AS ITS RECORDS WOULD HAVE READ, for the tests of what the boot after it concludes. A job of
   sub-tidy-pebble-aii1 started `integra replay-client` (pid 1077125 here, 19443 to the VM's kernel) at 02:22; netd
   sampled it growing while memory was short, killed the daemon (pid 65) whose loop stopped at 02:39:18, then every
   daemon it started after that failed to say hello within three minutes, until the kernel's global OOM killed integra
   at 04:21:57 and the daemon that came up at 04:22:18 found it all on file. The container id in the kernel's line is
   illustrative, as in the incident report. */

export const at = (time: string): number => Date.parse(`2026-11-05T${time}Z`);

export const CONTAINER_ID = "a8c75cbac8dc3f2e1a7b5c9d0e4f6a8b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f";
export const WORKLOAD_MEMCG = `/wsl-user/distro-4261/docker/${CONTAINER_ID}/workload`;
export const CULPRIT = "sub-tidy-pebble-aii1";
export const RUNAWAY_PID = 1_077_125;
export const DAEMON_PID = 65;
export const STARTED_AT = at("02:18:37.882");
export const BOOT_AT = at("04:22:18.297");
export const KILLED_AT = at("04:21:57.000");
const GB = 1_000_000_000;

// The kernel's stamp of the two lines, and the clock zero that dates it to 04:21:57.
const KILL_BOOT_US = 236_305_229_131;
export const KERNEL_ZERO = KILLED_AT - KILL_BOOT_US / 1000;

/** The kernel's two lines, as /dev/kmsg gives them, among others of no interest. */
export const kmsgText = (memcg: string = WORKLOAD_MEMCG): string =>
    [
        "6,182290,236305100000,-;integra invoked oom-killer: gfp_mask=0x140cca(GFP_HIGHUSER_MOVABLE|__GFP_COMP), order=0, oom_score_adj=600",
        " SUBSYSTEM=memory",
        `6,182299,236305229000,-;oom-kill:constraint=CONSTRAINT_NONE,nodemask=(null),cpuset=/,mems_allowed=0,global_oom,task_memcg=${memcg},task=integra,pid=19443,uid=0`,
        `3,182300,${String(KILL_BOOT_US)},-;Out of memory: Killed process 19443 (integra) total-vm:62522052kB, anon-rss:17658000kB, file-rss:0kB, shmem-rss:0kB, UID:0 pgtables:36580kB oom_score_adj:600`,
        "",
    ].join("\n");

const top = (pid: number, comm: string, rssBytes: number, swapBytes: number, owner?: string) => ({ pid, comm, rssBytes, swapBytes, ...opt("owner", owner) });

/** netd's samples while memory was short: integra growing, a small integra of a one-shot beside it, and the daemon. */
export const pressure = (): PressureSample[] => [
    {
        at: at("02:30:00"),
        psi: { someAvg10: 30, fullAvg10: 12 },
        top: [top(RUNAWAY_PID, "integra", 9 * GB, 4 * GB, CULPRIT), top(DAEMON_PID, "MainThread", 0.7 * GB, 0, "daemon")],
    },
    {
        at: at("04:21:40"),
        psi: { someAvg10: 92, fullAvg10: 80 },
        top: [
            top(RUNAWAY_PID, "integra", 17.9 * GB, 33 * GB, CULPRIT),
            top(1_077_300, "integra", 0.05 * GB, 0, "one-shot"),
            top(2_000, "node", 0.4 * GB, 0.1 * GB, "brave-quill-q6g5"),
        ],
    },
];

// netd's HELLO_DEADLINE, and how often it then killed a daemon it had started.
const NO_HELLO_MS = 180_000;
const NO_HELLO_KILLS = 34;

/** What netd did to the daemon: killed the stuck one, then every restart that never said hello, three minutes apart. */
export const netdKills = (): NetdKill[] => [
    { at: at("02:39:18"), kind: "stuck", pid: DAEMON_PID, silentMs: 300_000, psi: { someAvg10: 47.3, fullAvg10: 31 } },
    ...Array.from(
        { length: NO_HELLO_KILLS },
        (_, index): NetdKill => ({ at: at("02:42:20") + index * NO_HELLO_MS, kind: "no-hello", pid: 15_000 + index, silentMs: NO_HELLO_MS - 1_000 }),
    ),
];

/** A memory-kills.jsonl the daemon and netd's guard would write in a sandbox that has them (none on the night). */
export const guardKill = (overrides: Partial<MemoryKill> = {}): MemoryKill => ({
    at: at("03:00:00"),
    killer: "netd-guard",
    pid: 4242,
    comm: "node",
    rssBytes: 17 * 1024 ** 3,
    owner: "wise-fern-usz1",
    jobId: "job-7",
    reason: "memory pressure 61% for 30 s",
    ...overrides,
});

/** One JSON line per record. */
export const jsonLines = (rows: readonly unknown[]): string => rows.map((row) => `${JSON.stringify(row)}\n`).join("");

/** The sentence the night's post-mortem reads as. */
export const NIGHT_SUMMARY =
    "netd killed the daemon after its event loop stopped answering for 300 s while memory pressure was 47%, then 34 daemons it restarted that never said hello; " +
    "integra (pid 1077125, 16.8 GB resident and 30.7 GB swapped) started by sub-tidy-pebble-aii1 was killed for memory by the kernel's global OOM killer at 04:21:57 UTC";
