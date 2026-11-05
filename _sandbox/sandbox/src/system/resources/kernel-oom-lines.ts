import { opt } from "../../opt.js";

/* THE KERNEL'S OWN WORD ON AN OOM KILL (2026-11-05). Every kill the kernel's OOM killer makes, whether a cgroup ran out
   or the whole machine did, it says in two lines of its ring buffer, readable from inside the container (/dev/kmsg, or
   dmesg). On the night of the runaway the global OOM ended it at 04:21:57 with:
     oom-kill:constraint=CONSTRAINT_NONE,nodemask=(null),cpuset=/,mems_allowed=0,global_oom,task_memcg=/wsl-user/…/docker/<id>/workload,task=integra,pid=19443,uid=0
     Out of memory: Killed process 19443 (integra) total-vm:62522052kB, anon-rss:17658000kB, file-rss:0kB, shmem-rss:0kB, UID:0 pgtables:36580kB oom_score_adj:600
   and a kill at the workload leaf's own bound reads `CONSTRAINT_MEMCG,…,oom_memcg=…` and `Memory cgroup out of memory:
   Killed process …`. This module is the one reader of those lines: the daemon's detector reads them as they come
   (cgroup-oom.ts), and the boot's post-mortem reads the whole ring back (system/boot/restarts/kernel-oom.ts).

   Two things about the lines decide how they are read:
   - The pid is the kernel's, in the machine's own numbering (the VM's), never the one the sandbox's `ps` shows: a
     reader matches it to a sandbox process by name and size, not by number.
   - The time is microseconds since the kernel started (/dev/kmsg's third field, dmesg's `[seconds.micros]`), not a date.
     Dating it is the reader's (kernel-oom.ts says why /proc/uptime is the wrong clock for it). */

/** One line of the kernel's log: when, in microseconds since the kernel started, and its text. */
export interface KernelLine {
    readonly bootUs: number;
    readonly text: string;
}

// /dev/kmsg's record header: "<facility*8+level>,<sequence>,<microseconds since boot>,<flags>[,…];<message>".
const KMSG = /^\d+,\d+,(\d+),[^;]*;(.*)$/u;
// dmesg's default: "[ 1234.567890] message" (some builds print nanoseconds, nine digits).
const DMESG = /^\[\s*(\d+)\.(\d{1,9})\]\s?(.*)$/u;

/** One raw line as /dev/kmsg or dmesg prints it; undefined for a continuation line or anything else. */
export const kernelLineOf = (raw: string): KernelLine | undefined => {
    const kmsg = KMSG.exec(raw);
    if (kmsg !== null) {
        return { bootUs: Number(kmsg[1]), text: kmsg[2] ?? "" };
    }
    const dmesg = DMESG.exec(raw);
    if (dmesg !== null) {
        // The fraction as microseconds, whatever its width: ".5" is 500000, a nanosecond ".123456789" is 123456.
        const micros = Number((dmesg[2] ?? "0").padEnd(6, "0").slice(0, 6));
        return { bootUs: Number(dmesg[1]) * 1_000_000 + micros, text: dmesg[3] ?? "" };
    }
    return undefined;
};

/**
 * Every dated line in a dump of /dev/kmsg records or dmesg output. Continuation lines are left out: /dev/kmsg's
 * ` KEY=value` dictionary and dmesg's indented rest of a multi-line message both start with a space.
 */
export const kernelLinesOf = (text: string): KernelLine[] =>
    text.split("\n").flatMap((raw) => {
        if (raw.startsWith(" ") || raw.trim() === "") {
            return [];
        }
        const line = kernelLineOf(raw);
        return line === undefined ? [] : [line];
    });

/** One OOM kill as the kernel told it, its `oom-kill:` line and its `Killed process` line paired by pid. */
export interface KernelOomKill {
    readonly bootUs: number;
    // `global`: the machine as a whole ran out (the 2026-11-05 kill); `memcg`: a cgroup hit its own memory.max.
    readonly scope: "global" | "memcg";
    // CONSTRAINT_NONE, CONSTRAINT_MEMCG, CONSTRAINT_CPUSET or CONSTRAINT_MEMORY_POLICY, when the oom-kill line was found.
    readonly constraint?: string;
    // The victim's cgroup as the kernel names it from the machine's root; the cgroup that ran out, for a memcg kill.
    readonly taskMemcg?: string;
    readonly oomMemcg?: string;
    readonly comm: string;
    // The kernel's pid: the machine's (the VM's) numbering, not the sandbox's.
    readonly pid: number;
    readonly uid?: number;
    // The sizes are the Killed process line's: a kill whose oom-kill line came alone has none.
    readonly totalVmBytes?: number;
    readonly anonRssBytes?: number;
    readonly fileRssBytes?: number;
    readonly shmemRssBytes?: number;
    readonly oomScoreAdj?: number;
}

// The two lines of one kill print within the same few milliseconds; a pairing further apart than this is two kills.
const SAME_KILL_US = 10_000_000;

const OOM_KILL = /oom-kill:(.*)$/u;
const KILLED = /(Memory cgroup out of memory: )?Killed process (\d+) \((.*)\) (total-vm:.*)$/u;
const SIZE = /(total-vm|anon-rss|file-rss|shmem-rss):(\d+)kB/gu;

interface OomKillLine {
    readonly bootUs: number;
    readonly constraint?: string;
    readonly global: boolean;
    readonly oomMemcg?: string;
    readonly taskMemcg?: string;
    readonly comm?: string;
    readonly pid: number;
    readonly uid?: number;
}

const numberOr = (text: string | undefined): number | undefined => (text === undefined ? undefined : Number(text));

// "constraint=…,nodemask=…,cpuset=…,mems_allowed=…[,global_oom|,oom_memcg=…],task_memcg=…,task=…,pid=…,uid=…". The task
// name may hold a comma, so the fields after it are read from the end.
const oomKillLineOf = (bootUs: number, fields: string): OomKillLine | undefined => {
    const tail = /(?:^|,)task_memcg=(.*?),task=(.*),pid=(\d+),uid=(\d+)$/u.exec(fields);
    const pid = tail?.[3] ?? /(?:^|,)pid=(\d+)/u.exec(fields)?.[1];
    if (pid === undefined) {
        return undefined;
    }
    return {
        bootUs,
        pid: Number(pid),
        global: /(?:^|,)global_oom(?:,|$)/u.test(fields),
        ...opt("constraint", /(?:^|,)constraint=(\w+)/u.exec(fields)?.[1]),
        ...opt("oomMemcg", /(?:^|,)oom_memcg=([^,]*)/u.exec(fields)?.[1]),
        ...opt("taskMemcg", tail?.[1]),
        ...opt("comm", tail?.[2]),
        ...opt("uid", numberOr(tail?.[4])),
    };
};

const KIB = 1024;

// A memcg kill by its oom-kill line: the constraint says so, or (on a kernel that prints no constraint) a cgroup that
// ran out without the machine running out.
const memcgLine = (line: OomKillLine | undefined): boolean =>
    line?.constraint === "CONSTRAINT_MEMCG" || (line?.oomMemcg !== undefined && !line.global);

// What the oom-kill line alone says of the kill: the cgroups, and the victim as far as it names it.
const oomKillFields = (line: OomKillLine | undefined) => ({
    ...opt("constraint", line?.constraint),
    ...opt("taskMemcg", line?.taskMemcg),
    ...opt("oomMemcg", line?.oomMemcg),
});

interface KilledLine {
    readonly bootUs: number;
    readonly memcgPrefix: boolean;
    readonly pid: number;
    readonly comm: string;
    readonly rest: string;
}

const killOf = (pending: OomKillLine | undefined, line: KilledLine): KernelOomKill => {
    const sizes = new Map([...line.rest.matchAll(SIZE)].map((match) => [match[1], Number(match[2]) * KIB]));
    const uid = numberOr(/UID:(\d+)/u.exec(line.rest)?.[1]) ?? pending?.uid;
    return {
        bootUs: line.bootUs,
        // The kill line's own prefix says a memcg kill even where the oom-kill line was lost or never printed (before 4.19).
        scope: line.memcgPrefix || memcgLine(pending) ? "memcg" : "global",
        ...oomKillFields(pending),
        comm: line.comm,
        pid: line.pid,
        ...opt("uid", uid),
        ...opt("totalVmBytes", sizes.get("total-vm")),
        ...opt("anonRssBytes", sizes.get("anon-rss")),
        ...opt("fileRssBytes", sizes.get("file-rss")),
        ...opt("shmemRssBytes", sizes.get("shmem-rss")),
        ...opt("oomScoreAdj", numberOr(/oom_score_adj:(-?\d+)/u.exec(line.rest)?.[1])),
    };
};

// An oom-kill line whose Killed process line never came (rotated out of the ring between them, rate-limited, or not
// printed yet when the log was read): its own fields still name the victim and the cgroup, only the sizes are missing.
const loneKillOf = (line: OomKillLine): KernelOomKill => ({
    bootUs: line.bootUs,
    scope: memcgLine(line) ? "memcg" : "global",
    ...oomKillFields(line),
    comm: line.comm ?? "?",
    pid: line.pid,
    ...opt("uid", line.uid),
});

const killedLineOf = (bootUs: number, text: string): KilledLine | undefined => {
    const killed = KILLED.exec(text);
    return killed === null ? undefined : { bootUs, memcgPrefix: killed[1] !== undefined, pid: Number(killed[2]), comm: killed[3] ?? "?", rest: killed[4] ?? "" };
};

/** The OOM kills in a run of kernel lines, oldest first: each `oom-kill:` line paired with its `Killed process` line. */
export const oomKillsOf = (lines: readonly KernelLine[]): KernelOomKill[] => {
    // oom-kill lines waiting for their Killed process line, by the victim's pid.
    const pending = new Map<number, OomKillLine>();
    const kills: KernelOomKill[] = [];
    const settle = (pid: number): OomKillLine | undefined => {
        const waiting = pending.get(pid);
        pending.delete(pid);
        return waiting;
    };
    for (const { bootUs, text } of lines) {
        const oomKill = OOM_KILL.exec(text);
        const parsed = oomKill === null ? undefined : oomKillLineOf(bootUs, oomKill[1] ?? "");
        if (parsed !== undefined) {
            const earlier = settle(parsed.pid);
            kills.push(...(earlier === undefined ? [] : [loneKillOf(earlier)]));
            pending.set(parsed.pid, parsed);
            continue;
        }
        const killed = killedLineOf(bootUs, text);
        if (killed === undefined) {
            continue;
        }
        const waiting = settle(killed.pid);
        const paired = waiting !== undefined && Math.abs(bootUs - waiting.bootUs) <= SAME_KILL_US;
        kills.push(...(waiting === undefined || paired ? [] : [loneKillOf(waiting)]), killOf(paired ? waiting : undefined, killed));
    }
    kills.push(...[...pending.values()].map(loneKillOf));
    return kills.toSorted((a, b) => a.bootUs - b.bootUs);
};

/** What the kernel saw resident in the victim when it killed it (anon + file + shmem), or undefined where no Killed line said. */
export const residentBytesOf = (kill: KernelOomKill): number | undefined =>
    kill.anonRssBytes === undefined ? undefined : kill.anonRssBytes + (kill.fileRssBytes ?? 0) + (kill.shmemRssBytes ?? 0);
