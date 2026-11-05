import { rmSync } from "node:fs";
import { join } from "node:path";
import {
    type ReadRestartIntent,
    ReadRestartIntentSchema,
    type RestartAction as ContractRestartAction,
} from "@intentic/sandbox-contract/schemas/restart-intent";
import type { HostCrashEvent } from "@intentic/sandbox-contract/schemas/hosts";
import { opt } from "../../../opt.js";
import { readJsonMarkerSync } from "../../../store/plain-files/json-marker.js";
import type { PostMortem } from "../../resources/memory-records.js";

// WHY THE DAEMON LAST STOPPED, SAID ONCE AT THE NEXT BOOT (2026-10-11). A restart used to leave a bare "shutting down"
// line and a boot timestamp, so whoever asked why a job died or /tmp emptied rebuilt it from uptime drops across two
// machines. Now whoever is about to stop or restart the sandbox (the owner's restart, `ic`, the device keeper, the
// desktop app, this daemon itself) first writes RESTART_INTENT_FILE, overwriting any earlier one; the stop reads it to
// name its initiator, and the next boot classifies how the previous run ended (daemon-exit.json, boot-marker.ts), logs
// one line, appends RESTARTS_FILE (the diagnostics `restarts` tool reads it), and deletes the intent. Both files are
// written by boot-marker.ts, synchronously as the exit marker is; this module reads and describes them.

export const RESTART_INTENT_FILE = "restart-intent.json";
export const RESTARTS_FILE = "restarts.jsonl";
// What the computer this sandbox runs on reported of its own crashes and GPU resets (hosts/gpu/host-crashes.ts), one
// event per line, by which a run that was killed without warning is explained once the computer is back.
export const HOST_CRASHES_FILE = "host-crashes.jsonl";
// Enough to read months of restarts in, small enough to rewrite whole on each boot.
export const RESTARTS_KEPT = 500;
// How long an intent can still explain a stop: a rebuild builds for many minutes after it is asked for, but one that
// never restarted must not be blamed for an unrelated restart hours later (as restart-resume.ts's ask).
export const INTENT_STANDS_MS = 2 * 60 * 60_000;

// What a writer puts in RESTART_INTENT_FILE is the contract's RestartIntentSchema: the daemon, ic and the device keeper write
// it from three languages, and one schema enumerates who may act and what they may do. A writer here is held to it
// (boot-marker.ts writeRestartIntent); the golden/host-files.json pins ic's and the keeper's.

// Read leniently: a writer newer than this daemon may name an initiator, an action or a side it does not know, and that
// intent still says more than none (the contract's ReadRestartIntentSchema). Only `at` is held to its meaning, since
// freshness is decided on it.
export type ReadIntent = ReadRestartIntent;

// What the daemon's own stops and a device op's restart name themselves by (daemon-stop.ts, hosts/devices.routes.ts): the
// contract's words, so a new action is added once.
export type RestartAction = ContractRestartAction;

// An intent that is missing, torn or unreadable explains no stop, and the boot reads it as none.
export const readRestartIntent = (logsDir: string): ReadIntent | undefined => readJsonMarkerSync(join(logsDir, RESTART_INTENT_FILE), ReadRestartIntentSchema);

export const removeRestartIntent = (logsDir: string): void => {
    rmSync(join(logsDir, RESTART_INTENT_FILE), { force: true });
};

/** The intent, when it was written for a stop of a run that started at `since` (epoch ms) and is still recent. */
export const standingIntent = (intent: ReadIntent | undefined, since: number | undefined, now: number): ReadIntent | undefined => {
    if (intent === undefined) {
        return undefined;
    }
    const at = Date.parse(intent.at);
    const recent = at <= now && now - at <= INTENT_STANDS_MS;
    return recent && (since === undefined || at >= since) ? intent : undefined;
};

// What the previous run's exit marker says, as far as this module reads it (boot-marker.ts owns the file).
export interface EndedRun {
    readonly state: "running" | "exited";
    readonly pid: number;
    readonly startedAt: number;
    readonly endedAt?: number;
    readonly exitCode?: number;
    readonly graceful?: boolean;
    readonly signal?: string;
    readonly stopReason?: string;
    readonly version?: string;
    readonly commit?: string;
}

// How the previous run ended, in one word: `stopped` went through the daemon's own stop; `exited` ended with code 0
// without it; `crashed` exited non-zero on its own or left a fatal-error report; `killed` never ran its exit hook at all
// (SIGKILL, a kernel OOM kill, a forced container stop, netd killing a stuck daemon, the host losing power); `unknown`
// left no marker (a first boot, or a marker that was lost).
// Two kills the boot can name from the records left behind (2026-11-05, post-mortem.ts): `netd-stuck`, netd killed it
// for not answering (a ping unanswered for five minutes, or a start that never said hello); `oom-victim`, the kernel's
// OOM killer chose the daemon itself. `killed` stays for a kill nothing on file names.
export const RUN_ENDINGS = ["stopped", "exited", "crashed", "killed", "netd-stuck", "oom-victim", "unknown"] as const;
export type RunEnding = (typeof RUN_ENDINGS)[number];

// The endings in which the daemon never ran its exit hook: what it was writing may be half-written (a git object, a
// database page), which a boot after one of them checks (git integrity, the conversation database).
const UNCLEAN: ReadonlySet<RunEnding> = new Set(["killed", "netd-stuck", "oom-victim", "unknown"]);

/** Whether the run ended without its exit hook (killed, by any hand, or no marker at all). */
export const endedUncleanly = (ended: RunEnding | undefined): boolean => ended !== undefined && UNCLEAN.has(ended);

export interface PreviousRun {
    readonly ended: RunEnding;
    readonly graceful: boolean;
    readonly pid?: number;
    readonly startedAt?: string;
    readonly stoppedAt?: string;
    readonly uptimeSeconds?: number;
    readonly signal?: string;
    readonly exitCode?: number;
    // What the daemon itself said it stopped for.
    readonly reason?: string;
    readonly version?: string;
    readonly commit?: string;
    readonly intent?: ReadIntent;
    readonly fatalReports?: readonly string[];
    // Every process in the container ended with it (PID 1 is a different process now).
    readonly containerRestarted?: boolean;
    // /tmp no longer holds what the previous run left there: the container was recreated.
    readonly tmpCleared?: boolean;
    // What the boot found on file about an unclean end (post-mortem.ts): what was killed for memory, what netd did, whose
    // turns it holds, and the named cause in a sentence. Absent after a clean stop.
    readonly postMortem?: PostMortem;
}

export interface EndFacts {
    readonly marker: EndedRun | undefined;
    readonly intent: ReadIntent | undefined;
    readonly now: number;
    readonly fatalReports?: readonly string[];
    readonly containerRestarted?: boolean;
    readonly tmpCleared?: boolean;
    readonly postMortem?: PostMortem;
    // Who killed the run, when the records name the hand (post-mortem.ts namedEndingOf): refines `killed`, nothing else.
    readonly namedEnding?: "netd-stuck" | "oom-victim";
}

const iso = (ms: number): string => new Date(ms).toISOString();

const endingOf = (marker: EndedRun | undefined, fatalReports: readonly string[]): RunEnding => {
    if (marker === undefined) {
        return "unknown";
    }
    if (marker.state === "running") {
        return fatalReports.length > 0 ? "crashed" : "killed";
    }
    // A marker from before `graceful` was written: its exit 0 came through the stop.
    if (marker.graceful ?? marker.exitCode === 0) {
        return "stopped";
    }
    return marker.exitCode === 0 ? "exited" : "crashed";
};

/** Classifies the previous run's end from its marker and the intent left for it. */
export const previousRunOf = (facts: EndFacts): PreviousRun => {
    const { marker, now } = facts;
    const fatalReports = facts.fatalReports ?? [];
    const marked = endingOf(marker, fatalReports);
    const ended = marked === "killed" && facts.namedEnding !== undefined ? facts.namedEnding : marked;
    const intent = standingIntent(facts.intent, marker?.startedAt, now);
    const endedAt = marker?.state === "exited" ? marker.endedAt : undefined;
    return {
        ended,
        graceful: ended === "stopped",
        ...opt("pid", marker?.pid),
        ...opt("startedAt", marker === undefined ? undefined : iso(marker.startedAt)),
        ...opt("stoppedAt", endedAt === undefined ? undefined : iso(endedAt)),
        ...opt("uptimeSeconds", endedAt === undefined || marker === undefined ? undefined : Math.max(0, Math.round((endedAt - marker.startedAt) / 1000))),
        ...opt("signal", marker?.signal),
        ...opt("exitCode", marker?.state === "exited" ? marker.exitCode : undefined),
        ...opt("reason", marker?.stopReason),
        ...opt("version", marker?.version),
        ...opt("commit", marker?.commit),
        ...opt("intent", intent),
        ...opt("fatalReports", fatalReports.length > 0 ? fatalReports : undefined),
        ...opt("containerRestarted", facts.containerRestarted),
        ...opt("tmpCleared", facts.tmpCleared),
        ...opt("postMortem", facts.postMortem),
    };
};

/** "3h 12m", "4m 5s", "9s". */
export const spanOf = (seconds: number): string => {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    if (hours > 0) {
        return `${String(hours)}h ${String(minutes)}m`;
    }
    return minutes > 0 ? `${String(minutes)}m ${String(seconds % 60)}s` : `${String(seconds)}s`;
};

/** "ic asked to update (a newer image): …", the initiator in words. */
export const initiatorText = (intent: ReadIntent): string =>
    `${intent.by}${intent.host === undefined ? "" : ` on ${intent.host}${intent.side === undefined ? "" : ` (${intent.side})`}`} asked to ${intent.action}: ${intent.reason}${
        intent.checks === undefined || intent.checks.length === 0 ? "" : ` [failed checks: ${intent.checks.join(", ")}]`
    }`;

const ENDINGS = {
    stopped: (run) =>
        `stopped gracefully${run.signal === undefined ? "" : ` on ${run.signal}`}${run.uptimeSeconds === undefined ? "" : ` after ${spanOf(run.uptimeSeconds)}`}`,
    exited: (run) => `exited with code 0 without being asked to stop${run.uptimeSeconds === undefined ? "" : ` after ${spanOf(run.uptimeSeconds)}`}`,
    crashed: (run) =>
        run.fatalReports === undefined
            ? `crashed: exited with code ${String(run.exitCode)} without being asked to stop (an uncaught exception or a fatal error; the lines before it in daemon.log say which)`
            : `died on a fatal error (read ${run.fatalReports.join(", ")} for the cause)`,
    killed: () => "was killed without warning (SIGKILL, a kernel OOM kill, a forced container stop, netd killing a stuck daemon, or the host going down)",
    "netd-stuck": () => "was killed by netd, which found it not answering (an event loop stopped for five minutes, or a start that never said hello)",
    "oom-victim": () => "was killed by the kernel's OOM killer, which chose the daemon itself",
    unknown: () => "unknown: it left no exit marker (a first boot, or the marker was lost)",
} satisfies Record<RunEnding, (run: PreviousRun) => string>;

const KILLS: ReadonlySet<RunEnding> = new Set(["killed", "netd-stuck", "oom-victim"]);

/**
 * A kill the post-mortem named, in place of the five-way guess: "was killed: netd killed the daemon after its event loop
 * stopped answering for 300 s …". A plain `killed` with memory killed around it says so first, since the post-mortem
 * then names what died for memory but not the hand that ended the daemon. Undefined when nothing was named.
 */
const namedKill = (run: PreviousRun): string | undefined => {
    const found = run.postMortem;
    if (found === undefined || found.cause === "unknown" || !KILLS.has(run.ended)) {
        return undefined;
    }
    return `was killed${run.ended === "killed" && found.cause === "memory" ? " without warning while memory ran out" : ""}: ${found.summary}`;
};

// The run's end in words, before why and what it cost: a named kill, else the host's crash, else the ending's own, with
// whatever the post-mortem found beside it (around a crash, or that nothing on file names the hand of a kill).
const endingText = (run: PreviousRun, crashes: readonly HostCrashEvent[]): string => {
    const named = namedKill(run);
    if (named !== undefined) {
        return named;
    }
    const own = crashes.length > 0 && (run.ended === "killed" || run.ended === "unknown") ? hostCrashText(crashes) : ENDINGS[run.ended](run);
    return run.postMortem === undefined ? own : `${own}; ${run.postMortem.summary}`;
};

// How long after a boot the host's own record of the crash before it may still be dated: Windows logs Kernel-Power 41 as
// it boots again, and its error reporting files a GPU reset's LiveKernelEvent minutes later.
export const CRASH_REPORTED_WITHIN_MS = 15 * 60_000;

/** The host's crashes that fall in a run's life: from its start to just after the boot that followed it. */
export const crashesDuring = (crashes: readonly HostCrashEvent[], startedAt: string | undefined, bootAt: string): HostCrashEvent[] => {
    const from = startedAt === undefined ? Number.NEGATIVE_INFINITY : Date.parse(startedAt);
    const until = Date.parse(bootAt) + CRASH_REPORTED_WITHIN_MS;
    return crashes.filter((crash) => {
        const at = Date.parse(crash.at);
        return at >= from && at <= until;
    });
};

const CRASH_WORDS = { "gpu-reset": "its GPU reset", "host-crash": "it went down" } satisfies Record<HostCrashEvent["kind"], string>;

/**
 * A killed run's end by the host's own reports: "was killed when the computer it runs on went down after a GPU reset:
 * Windows reported its GPU reset at … (LiveKernelEvent 141); it went down at … (Kernel-Power 41)". A GPU reset with no
 * crash of the computer is said beside the kill, not as its cause: Windows can recover from one.
 */
export const hostCrashText = (crashes: readonly HostCrashEvent[]): string => {
    const ordered = crashes.toSorted((a, b) => Date.parse(a.at) - Date.parse(b.at));
    const reset = ordered.some((crash) => crash.kind === "gpu-reset");
    const down = ordered.some((crash) => crash.kind === "host-crash");
    const events = ordered.map((crash) => `${CRASH_WORDS[crash.kind]} at ${crash.at} (${crash.code})`).join("; ");
    return down
        ? `was killed when the computer it runs on went down${reset ? " after a GPU reset" : ""}: Windows reported ${events}`
        : `was killed without warning while the computer it runs on had a GPU reset: Windows reported ${events}`;
};

/**
 * The previous run's end in one sentence, for the boot's log line and a resumed turn's account of the restart. `crashes`
 * are the host's own reports of the run's life (crashesDuring): a run killed without warning is then said to have died
 * with its host, by the event Windows named.
 */
export const describePreviousRun = (run: PreviousRun, crashes: readonly HostCrashEvent[] = []): string => {
    const why =
        run.intent !== undefined
            ? `; ${initiatorText(run.intent)}`
            : run.reason !== undefined
              ? `; ${run.reason}`
              : run.ended === "stopped" && run.signal !== undefined
                ? "; nothing recorded who sent it (docker stop, a host shutdown, or a tool that writes no restart-intent.json)"
                : "";
    const lost =
        run.containerRestarted === true
            ? `; the container restarted too, so every process in it ended (terminals, background jobs, dev servers)${run.tmpCleared === true ? " and /tmp was emptied" : ""}`
            : run.tmpCleared === true
              ? "; /tmp was emptied"
              : "";
    return `${endingText(run, crashes)}${why}${lost}`;
};

/**
 * What the restart this boot follows cost a turn it cut, for the note a resumed turn reads: what still runs, whether /tmp
 * survived, and why it happened. A daemon-only restart spares the terminals' tmux sessions (generation-sweep.ts), a
 * container restart spares nothing, and only a recreated container empties /tmp.
 */
export const restartCost = (run: PreviousRun): string => {
    const processes =
        run.containerRestarted === true
            ? "The whole container restarted, so every process in it ended: background commands, terminal sessions and dev servers started before it are gone, and must be started again if still needed."
            : run.containerRestarted === false
              ? "Only the daemon restarted, inside a running container: what it ran for the turn ended, while terminal (tmux) sessions may have survived, so check before starting one again."
              : "Assume any background command, job or dev server started before it has ended, and check before relying on one.";
    const tmp = run.tmpCleared === true ? " /tmp was emptied, so anything written there is gone." : run.tmpCleared === false ? " /tmp was kept." : "";
    // What it cost is said above; the ending alone says why.
    const { containerRestarted: _restarted, tmpCleared: _cleared, ...ending } = run;
    const why = run.intent !== undefined ? ` Why: ${initiatorText(run.intent)}.` : run.ended === "unknown" ? "" : ` The run before it ${describePreviousRun(ending)}.`;
    return `${processes}${tmp}${why}`;
};

export interface RestartRecord {
    readonly at: string;
    readonly boot: { readonly pid: number; readonly version: string; readonly commit?: string };
    readonly previous: PreviousRun;
}
