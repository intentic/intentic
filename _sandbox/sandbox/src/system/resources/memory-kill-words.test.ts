import { killSentence } from "./memory-kill-words.js";
import type { MemoryKill } from "./memory-records.js";

/* One kill, said the same wherever it is told: a job's ending and its conversation's notice, a held turn's card and
   re-run, and the post-mortem's sentence (2026-11-05, when the three said it three ways). */

const GIB = 1024 ** 3;

const kill = (fields: Partial<MemoryKill> = {}): MemoryKill => ({
    at: Date.parse("2026-11-05T04:21:57Z"),
    killer: "cgroup-oom",
    pid: 502,
    comm: "integra",
    rssBytes: 17.6 * GIB,
    swapBytes: 3 * GIB,
    reason: "the workload cgroup reached its bounds (memory.max 14.5 GiB, swap 4.0 GiB).",
    ...fields,
});

test("a kill is one sentence: what, its pid, its size, whose, by whom, when, and why", () => {
    expect(killSentence(kill({ owner: "sub-tidy-pebble-aii1", jobId: "job-7" }))).toBe(
        "integra (pid 502, 17.6 GB resident and 3.0 GB swapped) from background job job-7 of sub-tidy-pebble-aii1 was killed for memory by the kernel at the sandbox's own memory bound at 04:21:57 UTC: the workload cgroup reached its bounds (memory.max 14.5 GiB, swap 4.0 GiB)",
    );
    expect(killSentence(kill({ killer: "netd-guard", swapBytes: undefined, rssBytes: 300 * 1024 ** 2, reason: undefined, owner: "wise-fern-usz1" }))).toBe(
        "integra (pid 502, 300.0 MB resident) started by wise-fern-usz1 was killed for memory by the sandbox's memory guard at 04:21:57 UTC",
    );
});

test("the daemon's own work and a one-shot name nobody; nothing on size says nothing", () => {
    expect(killSentence(kill({ owner: "daemon", rssBytes: undefined, swapBytes: undefined, reason: undefined }))).toBe(
        "integra (pid 502) (one of the daemon's own) was killed for memory by the kernel at the sandbox's own memory bound at 04:21:57 UTC",
    );
    expect(killSentence(kill({ owner: "one-shot", jobId: "job-9", reason: undefined }))).toMatch(/^integra \(pid 502, [^)]+\) from background job job-9 was killed/u);
});

test("what only the post-mortem knows, and what its sentence of several kills leaves out", () => {
    expect(killSentence(kill({ killer: "kernel-oom", owner: "daemon" }), { daemon: true, machinePid: true, reason: false })).toBe(
        "the daemon itself (the kernel's pid 502, 17.6 GB resident and 3.0 GB swapped) was killed for memory by the kernel's global OOM killer at 04:21:57 UTC",
    );
});
