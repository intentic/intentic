import { join } from "node:path";
import { sizeLabel } from "@intentic/base/format";
import { z } from "zod";
import { opt } from "../../../opt.js";
import { logsRoot } from "../../../seams/logs-root.js";
import { readJsonMarkerSync } from "../../../store/plain-files/json-marker.js";
import { type KernelOomKill, oomKillsOf, residentBytesOf } from "../../resources/kernel-oom-lines.js";
import { type MemoryKill, type NetdKill, type PostMortem, PostMortemSchema, type PressureSample } from "../../resources/memory-records.js";
import { bootHistoryDocument } from "./boot-history.js";
import { epochOfKernel, type KernelLog, kernelZeroEpochMs, memcgIsDaemonLeaf, memcgIsOurs, readContainerId, readKernelLog } from "./kernel-oom.js";
import { type MemoryTrail, neverStartedBoots, readMemoryTrail, readTrail } from "./memory-trail.js";
import { RESTARTS_FILE, RUN_ENDINGS, type RunEnding } from "./restart-record.js";

/* WHY THE RUN BEFORE THIS ONE ENDED, NAMED FROM WHAT WAS LEFT ON FILE (2026-11-05). A job's `integra replay-client` grew
   to 17.6 GB of RSS and 33 GB of swap; the VM thrashed; at 02:39 netd killed the daemon whose event loop had stopped
   answering for 300 s, then every daemon it started in its place that could not say hello within three minutes, until
   the kernel's global OOM killed the runaway at 04:21:57. The daemon that came up at 04:22 filed "was killed without
   warning (SIGKILL, a kernel OOM kill, a forced container stop, netd killing a stuck daemon, or the host going down)",
   and five turns sat interrupted with nothing saying which of the five it was, or whose process did it.

   So a boot after an unclean stop (killed, crashed, or no marker at all) reads what the stop left behind and names it:
   - what was killed for memory: netd's guard and the daemon's own cgroup watch (memory-kills.jsonl), and the kernel's
     OOM lines for THIS sandbox (kernel-oom.ts), which nothing else records;
   - what netd did to the daemon (netd-kills.jsonl): killed it stuck, killed restarts that never said hello, held one;
   - whose process each victim was: a recorded kill carries its owner; a kernel kill carries only the machine's pid and
     a name, so it is matched to netd's pressure samples (attributeKernelKill below).
   The span read is the run before this boot, reaching back past every boot netd killed before its hello: those were
   the machine's thrash, not runs of their own, and the cause is in the run that got stuck before them.

   The result is the contract's PostMortem (memory-records.ts): a cause, what was killed, what netd did, the culprits
   (conversations whose own process was killed, whose cut turns the resume pass holds rather than restarts), and one
   sentence. boot-marker.ts computes it as it claims the exit marker, synchronously and once, files it on the restart
   record, and the record's sentence names it (restart-record.ts); readPostMortem hands the same value to the resume
   pass. */

// The kernel's clock is converted to a date, so a kill is matched to the span with this much room either way.
const KERNEL_SLACK_MS = 60_000;
// A post-mortem reaches back at most this far, as boot-history.json keeps boots.
const MAX_SPAN_MS = 24 * 60 * 60_000;
// The exit marker's start and boot-history.json's entry for one boot are written a moment apart.
const SAME_BOOT_MS = 60_000;
// netd's samples this long before a kernel kill (or this long after, a sample it took before it noticed) are what a
// kernel kill's victim is looked up in.
const ATTRIBUTE_BEFORE_MS = 10 * 60_000;
const ATTRIBUTE_AFTER_MS = 30_000;
// The kernel's memcg kill and the daemon's own record of the same kill (cgroup-oom) are read as one within this.
const SAME_KILL_MS = 60_000;
// Owners that are not a conversation: the daemon's own processes, and one-shot commands nobody's turn ran.
const NOT_CONVERSATIONS = new Set(["daemon", "one-shot"]);
// The netd process sits in the daemon's leaf beside the daemon; a kill of it is not the daemon's.
const NETD_COMM = "intentic-netd";

/* THE SPAN. */

/**
 * Where the post-mortem's span starts: the previous run's start, moved back past every boot netd killed before its hello
 * (memory-trail.ts neverStartedBoots), so a chain of failed starts reaches the run whose end began it. A run with no
 * known start (no marker) starts at the newest boot on record; never more than a day back.
 */
export const postMortemSince = (previousStartedAt: number | undefined, boots: readonly number[], netd: readonly NetdKill[], bootAt: number): number => {
    const floor = bootAt - MAX_SPAN_MS;
    const sorted = boots.filter((at) => at < bootAt).toSorted((a, b) => a - b);
    let since = previousStartedAt ?? sorted.at(-1) ?? floor;
    const never = neverStartedBoots(sorted, netd);
    let index = sorted.findLastIndex((at) => Math.abs(at - since) <= SAME_BOOT_MS);
    while (index > 0 && never.has(sorted[index] ?? Number.NaN)) {
        index -= 1;
        since = sorted[index] ?? since;
    }
    return Math.max(floor, since);
};

/* A KERNEL KILL'S VICTIM. */

export interface Attribution {
    // The victim's pid as the sandbox numbers it.
    readonly pid: number;
    readonly owner?: string;
    readonly rssBytes: number;
    readonly swapBytes: number;
    readonly oomScore?: number;
    // The netd sample it was found in.
    readonly sampleAt: number;
}

/**
 * The sandbox process a kernel kill took, from netd's pressure samples. The kernel names its victim by the machine's
 * pid, which no file in the sandbox uses (the container has its own pid namespace), and by its command name, which both
 * number spaces share (the kernel's `comm`, 15 characters, is what netd reads from /proc/<pid>/comm). So: of netd's
 * samples from ATTRIBUTE_BEFORE_MS before the kill to ATTRIBUTE_AFTER_MS after it, the newest one at or before the kill
 * (failing that, the first after it) that lists a process of the same name; of several such processes in it, the one
 * whose resident size is nearest what the kernel said the victim held. A runaway is the heaviest process by far, so
 * name and size single it out; a victim no sample lists (netd samples only while memory is short, and only the three
 * processes its guard would kill first) stays unattributed, said with the kernel's own pid.
 */
export const attributeKernelKill = (
    kill: { readonly at: number; readonly comm: string; readonly residentBytes?: number },
    samples: readonly PressureSample[],
): Attribution | undefined => {
    const rank = (sample: PressureSample): number => (sample.at <= kill.at ? kill.at - sample.at : ATTRIBUTE_BEFORE_MS + sample.at - kill.at);
    const near = samples.filter((sample) => sample.at >= kill.at - ATTRIBUTE_BEFORE_MS && sample.at <= kill.at + ATTRIBUTE_AFTER_MS).toSorted((a, b) => rank(a) - rank(b));
    const size = kill.residentBytes ?? 0;
    for (const sample of near) {
        const best = sample.top.filter((top) => top.comm === kill.comm).toSorted((a, b) => Math.abs(a.rssBytes - size) - Math.abs(b.rssBytes - size))[0];
        if (best !== undefined) {
            return {
                pid: best.pid,
                rssBytes: best.rssBytes,
                swapBytes: best.swapBytes,
                sampleAt: sample.at,
                ...opt("owner", best.owner),
                ...opt("oomScore", best.oomScore),
            };
        }
    }
    return undefined;
};

/** A kernel kill dated, with whether it was in this sandbox. */
export interface DatedKernelKill extends KernelOomKill {
    readonly at: number;
}

/** The kernel's OOM kills in the log, dated by `zeroEpochMs` (kernelZeroEpochMs), in the span or near it. */
export const kernelKillsIn = (log: KernelLog, zeroEpochMs: number, since: number, until: number): DatedKernelKill[] =>
    oomKillsOf(log.lines)
        .map((kill) => ({ ...kill, at: epochOfKernel(kill.bootUs, zeroEpochMs) }))
        .filter((kill) => kill.at >= since - KERNEL_SLACK_MS && kill.at <= until + KERNEL_SLACK_MS);

const iso = (at: number): string => new Date(at).toISOString();

// What the kernel line said, for the kill's `reason`, beside how its sandbox pid was found.
const kernelReason = (kill: DatedKernelKill, found: Attribution | undefined): string =>
    [
        `the kernel's ${kill.scope === "memcg" ? "memory-cgroup" : "global"} OOM killer (${kill.constraint ?? "constraint not printed"}) in ${kill.taskMemcg ?? "a cgroup it did not print"}`,
        found === undefined
            ? `its pid ${String(kill.pid)} is the machine's, and no netd sample names a ${kill.comm} near the kill, so its pid here is unknown`
            : `its pid ${String(kill.pid)} is the machine's; matched to pid ${String(found.pid)} here by name and size in netd's sample at ${iso(found.sampleAt)}`,
        ...(kill.totalVmBytes === undefined ? [] : [`total-vm ${sizeLabel(kill.totalVmBytes)}`]),
        ...(kill.oomScoreAdj === undefined ? [] : [`oom_score_adj ${String(kill.oomScoreAdj)}`]),
    ].join("; ");

/** One kill as the post-mortem holds it: the record, and what the summary says about it. */
export interface Found {
    readonly kill: MemoryKill;
    // The victim was a daemon (the previous run, or one netd killed in the span), not a process of the workload.
    readonly daemon: boolean;
    // A kernel kill no sample attributed: its pid is the machine's.
    readonly machinePid?: boolean;
}

/** A kernel kill as a MemoryKill, attributed where netd's samples allow. */
const kernelFound = (kill: DatedKernelKill, samples: readonly PressureSample[], daemonPids: ReadonlySet<number>): Found => {
    const resident = residentBytesOf(kill);
    const found = attributeKernelKill({ at: kill.at, comm: kill.comm, ...opt("residentBytes", resident) }, samples);
    const daemon = (memcgIsDaemonLeaf(kill.taskMemcg) && kill.comm !== NETD_COMM) || (found !== undefined && daemonPids.has(found.pid));
    return {
        kill: {
            at: kill.at,
            killer: kill.scope === "memcg" ? "cgroup-oom" : "kernel-oom",
            pid: found?.pid ?? kill.pid,
            comm: kill.comm,
            ...opt("rssBytes", resident ?? found?.rssBytes),
            ...opt("swapBytes", found?.swapBytes),
            ...opt("oomScore", found?.oomScore),
            ...opt("owner", daemon ? "daemon" : found?.owner),
            ...opt("cgroup", kill.taskMemcg),
            reason: kernelReason(kill, found),
        },
        daemon,
        ...opt("machinePid", found === undefined ? true : undefined),
    };
};

/* ASSEMBLY. */

/** Everything the post-mortem is drawn from, read already (collectPostMortem reads it). */
export interface PostMortemInput {
    // The run before this boot, as its exit marker said.
    readonly previous: { readonly pid?: number; readonly startedAt?: number };
    readonly bootAt: number;
    // Where the span starts (postMortemSince).
    readonly since: number;
    readonly kills: readonly MemoryKill[];
    readonly netd: readonly NetdKill[];
    readonly pressure: readonly PressureSample[];
    // This sandbox's kernel kills in the span, dated; and how many the log holds for other sandboxes on the machine.
    readonly kernel: readonly DatedKernelKill[];
    readonly kernelElsewhere: number;
    // What reading the kernel's log came to: its source, why it could not be read, how far back it reaches.
    readonly kernelLog: { readonly source: KernelLog["source"]; readonly problem?: string; readonly reachesBackTo?: number };
    // Records that could not be read, in words.
    readonly unreadable?: string;
}

export interface Assembled {
    readonly postMortem: PostMortem;
    // Who killed the previous run itself, when the records name the hand (restart-record.ts EndFacts.namedEnding).
    readonly namedEnding?: "netd-stuck" | "oom-victim";
}

const DAEMON_KILLS: ReadonlySet<NetdKill["kind"]> = new Set(["stuck", "no-hello"]);

const inSpan = (at: number, since: number, until: number): boolean => at >= since && at <= until;

// The kernel's memcg kill the daemon recorded itself (cgroup-oom, with its owner and job) is the same kill, kept once.
const recordedAlready = (kill: DatedKernelKill, recorded: readonly MemoryKill[]): boolean =>
    kill.scope === "memcg" && recorded.some((other) => other.killer === "cgroup-oom" && other.comm === kill.comm && Math.abs(other.at - kill.at) <= SAME_KILL_MS);

const causeOf = (found: readonly Found[], netd: readonly NetdKill[]): PostMortem["cause"] => {
    if (found.some((one) => one.daemon && one.kill.killer !== "netd-guard")) {
        return "oom-victim";
    }
    if (found.length > 0) {
        return "memory";
    }
    return netd.some((kill) => DAEMON_KILLS.has(kill.kind)) ? "netd-stuck" : "unknown";
};

// Whose turn a victim's process was: a conversation, never the daemon's own or a one-shot, each named once.
const culpritsOf = (found: readonly Found[]): string[] => [
    ...new Set(found.flatMap(({ kill, daemon }) => (daemon || kill.owner === undefined || NOT_CONVERSATIONS.has(kill.owner) ? [] : [kill.owner]))),
];

// Who ended the previous run itself: the kernel, if a daemon it killed was that run; else netd, if it killed that run
// (by its pid, or in its span when netd did not write one).
const namedEndingOf = (input: PostMortemInput, found: readonly Found[], netd: readonly NetdKill[]): Assembled["namedEnding"] => {
    const from = (input.previous.startedAt ?? input.since) - KERNEL_SLACK_MS;
    const until = input.bootAt + KERNEL_SLACK_MS;
    const pidFits = (pid: number | undefined): boolean => pid === undefined || input.previous.pid === undefined || pid === input.previous.pid;
    if (found.some(({ kill, daemon }) => daemon && kill.killer !== "netd-guard" && inSpan(kill.at, from, until))) {
        return "oom-victim";
    }
    return netd.some((kill) => DAEMON_KILLS.has(kill.kind) && inSpan(kill.at, from, until) && pidFits(kill.pid)) ? "netd-stuck" : undefined;
};

/** The post-mortem of the span, from records already read. Pure. */
export const assemblePostMortem = (input: PostMortemInput): Assembled => {
    const until = input.bootAt;
    const netd = input.netd.filter((kill) => inSpan(kill.at, input.since, until)).toSorted((a, b) => a.at - b.at);
    const recorded = input.kills.filter((kill) => inSpan(kill.at, input.since, until));
    const daemonPids = new Set([...(input.previous.pid === undefined ? [] : [input.previous.pid]), ...netd.flatMap((kill) => (kill.pid === undefined ? [] : [kill.pid]))]);
    const found: Found[] = [
        ...recorded.map((kill): Found => ({ kill, daemon: daemonPids.has(kill.pid) })),
        ...input.kernel.filter((kill) => !recordedAlready(kill, recorded)).map((kill) => kernelFound(kill, input.pressure, daemonPids)),
    ].toSorted((a, b) => a.kill.at - b.kill.at);
    const cause = causeOf(found, netd);
    const postMortem: PostMortem = {
        cause,
        killed: found.map(({ kill }) => kill),
        netd,
        culprits: culpritsOf(found),
        summary: summaryOf(found, netd, input),
    };
    return { postMortem, ...opt("namedEnding", namedEndingOf(input, found, netd)) };
};

/* THE SENTENCE. */

const KILLERS = {
    "netd-guard": "netd's memory guard",
    "cgroup-oom": "the kernel at the sandbox's own memory bound",
    "kernel-oom": "the kernel's global OOM",
} satisfies Record<MemoryKill["killer"], string>;

// How many kills the sentence names; the rest are counted.
const NAMED_KILLS = 3;

// Every time in the sandbox's logs is UTC; the sentence says so rather than leave a reader to guess their own zone.
const clock = (at: number): string => `${iso(at).slice(11, 19)} UTC`;

const seconds = (ms: number | undefined): string => (ms === undefined ? "minutes" : `${String(Math.round(ms / 1000))} s`);

const pressureText = (kill: NetdKill | undefined): string =>
    kill?.psi === undefined ? "" : ` while memory pressure was ${String(Math.round(kill.psi.someAvg10))}%`;

const times = (count: number, one: string, many: string): string => (count === 1 ? one : `${String(count)} ${many}`);

/** What netd did to the daemon in the span, in words; undefined when it did nothing. */
const netdText = (netd: readonly NetdKill[]): string | undefined => {
    const stuck = netd.filter((kill) => kill.kind === "stuck");
    const noHello = netd.filter((kill) => kill.kind === "no-hello").length;
    const held = netd.filter((kill) => kill.kind === "restart-held").length;
    const first = stuck[0];
    const parts = [
        ...(first === undefined
            ? []
            : [
                  `netd killed the daemon${stuck.length > 1 ? ` ${String(stuck.length)} times` : ""} after its event loop stopped answering for ${seconds(first.silentMs)}${pressureText(first)}`,
              ]),
        ...(noHello === 0
            ? []
            : [`${first === undefined ? "netd killed " : "then "}${times(noHello, "a daemon it restarted that", "daemons it restarted that")} never said hello`]),
        ...(held === 0 ? [] : [`held ${times(held, "a restart", "restarts")} while memory was short`]),
    ];
    return parts.length === 0 ? undefined : parts.join(", ");
};

const sizeText = (kill: MemoryKill): string => {
    if (kill.rssBytes === undefined) {
        return "";
    }
    return kill.swapBytes === undefined || kill.swapBytes === 0
        ? `, ${sizeLabel(kill.rssBytes)}`
        : `, ${sizeLabel(kill.rssBytes)} resident and ${sizeLabel(kill.swapBytes)} swapped`;
};

const fromText = (kill: MemoryKill): string => {
    if (kill.owner === undefined || NOT_CONVERSATIONS.has(kill.owner)) {
        return kill.owner === "daemon" ? " (one of the daemon's own)" : "";
    }
    return kill.jobId === undefined ? ` from ${kill.owner}` : ` from job ${kill.jobId} of ${kill.owner}`;
};

/** One kill in words: "integra (pid 1077125, 16.8 GB) from sub-tidy-pebble-aii1 was killed by the kernel's global OOM at 04:21:57 UTC". */
const killText = ({ kill, daemon, machinePid }: Found): string => {
    const pid = machinePid === true ? `the kernel's pid ${String(kill.pid)}` : `pid ${String(kill.pid)}`;
    const victim = daemon ? `the daemon itself (${pid}${sizeText(kill)})` : `${kill.comm} (${pid}${sizeText(kill)})${fromText(kill)}`;
    return `${victim} was killed by ${KILLERS[kill.killer]} at ${clock(kill.at)}`;
};

// The kills the sentence names: every daemon the kernel took, then the largest, said in the order they happened.
const namedKills = (found: readonly Found[]): Found[] => {
    const chosen = found
        .toSorted((a, b) => Number(b.daemon) - Number(a.daemon) || (b.kill.rssBytes ?? 0) + (b.kill.swapBytes ?? 0) - ((a.kill.rssBytes ?? 0) + (a.kill.swapBytes ?? 0)))
        .slice(0, NAMED_KILLS);
    return chosen.toSorted((a, b) => a.kill.at - b.kill.at);
};

const killsText = (found: readonly Found[]): string | undefined => {
    if (found.length === 0) {
        return undefined;
    }
    const named = namedKills(found).map(killText).join("; ");
    const rest = found.length - Math.min(found.length, NAMED_KILLS);
    return rest === 0 ? named : `${named}; and ${times(rest, "one more process", "more processes")} killed for memory`;
};

// What the kernel's log could say, when it named nothing here.
const kernelText = (input: PostMortemInput): string => {
    const { kernelLog } = input;
    if (kernelLog.source === "none") {
        return `the kernel's log could not be read (${kernelLog.problem ?? "no reason given"})`;
    }
    const reach = kernelLog.reachesBackTo === undefined ? "" : ` (it reaches back to ${iso(kernelLog.reachesBackTo)})`;
    return `the kernel's log${reach} has no OOM kill in this sandbox`;
};

/** The post-mortem's one sentence: netd's part, then the kills; or, with neither, what was looked at and found empty. */
const summaryOf = (found: readonly Found[], netd: readonly NetdKill[], input: PostMortemInput): string => {
    const said = [netdText(netd), killsText(found)].filter((part) => part !== undefined);
    const elsewhere = input.kernelElsewhere === 0 ? [] : [`the kernel's global OOM also killed ${times(input.kernelElsewhere, "a process", "processes")} outside this sandbox`];
    const unread = input.unreadable === undefined ? [] : [`some records could not be read (${input.unreadable})`];
    const main = said.length > 0 ? said.join("; ") : `nothing on file names the hand: no process was killed for memory, netd killed no daemon, and ${kernelText(input)}`;
    return [main, ...elsewhere, ...unread].join("; ");
};

/* READING IT ALL, ONCE PER BOOT. */

/** Where the post-mortem reads from; a test hands its own. */
export interface PostMortemSources {
    readonly kernelLog?: () => KernelLog;
    readonly containerId?: () => string | undefined;
    // The kernel's clock zero as epoch ms (kernelZeroEpochMs).
    readonly kernelZero?: () => number;
    readonly memoryTrail?: (logsDir: string) => MemoryTrail;
}

const BootsOnDisk = z.looseObject({ boots: z.array(z.number()) });

/** The previous run, as the boot that follows it knows it. */
export interface PreviousFacts {
    readonly ended: RunEnding;
    readonly pid?: number;
    readonly startedAt?: number;
}

// Endings that leave something to explain: the daemon never ran its own stop.
const NEEDS_POST_MORTEM: ReadonlySet<RunEnding> = new Set(["killed", "crashed", "unknown", "netd-stuck", "oom-victim"]);

/**
 * The post-mortem of the run before a boot at `bootAt`, read from the records under `logsDir`, boot-history.json at
 * `bootHistoryPath`, and the kernel's log; synchronous, for the boot marker's claim. Undefined after a clean stop, and
 * for a run with no marker (a first boot) about which nothing was found. Never throws: each source that cannot be read
 * is said in the summary instead.
 */
export const collectPostMortem = (
    logsDir: string,
    bootHistoryPath: string,
    previous: PreviousFacts,
    bootAt: number,
    sources: PostMortemSources = {},
): Assembled | undefined => {
    if (!NEEDS_POST_MORTEM.has(previous.ended)) {
        return undefined;
    }
    const trail = (sources.memoryTrail ?? readMemoryTrail)(logsDir);
    const boots = readJsonMarkerSync(bootHistoryPath, BootsOnDisk)?.boots ?? [];
    const since = postMortemSince(previous.startedAt, boots, trail.netd.rows, bootAt);
    const log = (sources.kernelLog ?? readKernelLog)();
    const zero = (sources.kernelZero ?? kernelZeroEpochMs)();
    const containerId = (sources.containerId ?? readContainerId)();
    const nearby = kernelKillsIn(log, zero, since, bootAt);
    const ours = nearby.filter((kill) => memcgIsOurs(kill.taskMemcg, containerId));
    const first = log.lines[0];
    const unreadable = [trail.kills.unreadable, trail.netd.unreadable, trail.pressure.unreadable].filter((problem) => problem !== undefined);
    const assembled = assemblePostMortem({
        previous: { ...opt("pid", previous.pid), ...opt("startedAt", previous.startedAt) },
        bootAt,
        since,
        kills: trail.kills.rows,
        netd: trail.netd.rows,
        pressure: trail.pressure.rows,
        kernel: ours,
        kernelElsewhere: nearby.filter((kill) => kill.scope === "global" && !memcgIsOurs(kill.taskMemcg, containerId)).length,
        kernelLog: {
            source: log.source,
            ...opt("problem", log.problem),
            ...opt("reachesBackTo", first === undefined ? undefined : epochOfKernel(first.bootUs, zero)),
        },
        ...opt("unreadable", unreadable.length === 0 ? undefined : unreadable.join("; ")),
    });
    // A first boot (no marker) with nothing found has nothing to explain.
    return previous.ended === "unknown" && assembled.postMortem.cause === "unknown" ? undefined : assembled;
};

// How much of a post-mortem the restart record keeps: restarts.jsonl is rewritten whole on every boot, and a thrash
// leaves dozens of `no-hello` kills that say the same thing. Every `stuck` kill stays, as the one that began it.
const KEPT_KILLS = 20;
const KEPT_NETD = 10;

/** The post-mortem as the restart record files it: every kind of fact, the newest of each, in time order. */
export const postMortemForRecord = (found: PostMortem): PostMortem => {
    const stuck = found.netd.filter((kill) => kill.kind === "stuck");
    const rest = found.netd.filter((kill) => kill.kind !== "stuck").slice(-KEPT_NETD);
    return { ...found, killed: found.killed.slice(-KEPT_KILLS), netd: [...stuck, ...rest].toSorted((a, b) => a.at - b.at) };
};

// This boot's post-mortem, by the logs directory it was computed for.
let computed: { readonly logsDir: string; readonly value: PostMortem | undefined } | undefined;

/** Keeps this boot's post-mortem (boot-marker.ts, as it claims the marker), for readPostMortem. */
export const notePostMortem = (logsDir: string, value: PostMortem | undefined): void => {
    computed = { logsDir, value };
};

/** Test seam: forgets this process's post-mortem. */
export const resetPostMortem = (): void => {
    computed = undefined;
};

// A restart record, read for its boot and its previous run, as leniently as the diagnostics tool reads it: a field
// another build wrote differently reads as absent.
const FiledRestartSchema = z.object({
    at: z.string(),
    previous: z
        .object({
            ended: z.enum(RUN_ENDINGS).optional().catch(undefined),
            pid: z.number().optional().catch(undefined),
            startedAt: z.string().optional().catch(undefined),
            postMortem: PostMortemSchema.optional().catch(undefined),
        })
        .optional()
        .catch(undefined),
});
type FiledRestart = z.infer<typeof FiledRestartSchema>;

const filedRestarts = (logsDir: string): FiledRestart[] => [...readTrail(logsDir, RESTARTS_FILE, FiledRestartSchema).rows];

// The post-mortem of the newest boot filed under `logsDir`, for a process that did not compute one as it claimed the
// marker: the one filed with it, else one drawn now from the same records.
const filedPostMortem = (historyRoot: string, sources: PostMortemSources): PostMortem | undefined => {
    const logsDir = logsRoot(historyRoot);
    const newest = filedRestarts(logsDir).at(-1);
    const previous = newest?.previous;
    if (newest === undefined || previous?.ended === undefined) {
        return undefined;
    }
    if (previous.postMortem !== undefined) {
        return previous.postMortem;
    }
    const startedAt = previous.startedAt === undefined ? undefined : Date.parse(previous.startedAt);
    return collectPostMortem(
        logsDir,
        join(historyRoot, bootHistoryDocument.path),
        { ended: previous.ended, ...opt("pid", previous.pid), ...opt("startedAt", Number.isNaN(startedAt) ? undefined : startedAt) },
        Date.parse(newest.at),
        sources,
    )?.postMortem;
};

/**
 * Why the run before this boot ended, as this boot's post-mortem found it: undefined after a clean stop. Computed once
 * per boot (as the boot marker is claimed, else on the first call from the newest restart record) and the same value
 * every call after.
 */
export const readPostMortem = async (historyRoot: string, sources: PostMortemSources = {}): Promise<PostMortem | undefined> => {
    const logsDir = logsRoot(historyRoot);
    if (computed?.logsDir !== logsDir) {
        computed = { logsDir, value: filedPostMortem(historyRoot, sources) };
    }
    return computed.value;
};

/** One boot's filed post-mortem, for the diagnostics `restarts` tool. */
export interface FiledPostMortem {
    readonly at: number;
    readonly ended?: RunEnding;
    readonly postMortem: PostMortem;
}

/** The post-mortems filed on restart records under `logsDir` from `sinceMs` on, newest first. */
export const readFiledPostMortems = (logsDir: string, sinceMs: number | undefined): FiledPostMortem[] =>
    filedRestarts(logsDir)
        .flatMap((row): FiledPostMortem[] => {
            const at = Date.parse(row.at);
            const found = row.previous?.postMortem;
            return found === undefined || Number.isNaN(at) || (sinceMs !== undefined && at < sinceMs) ? [] : [{ at, postMortem: found, ...opt("ended", row.previous?.ended) }];
        })
        .toReversed();
