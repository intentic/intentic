import { sizeLabel } from "@intentic/base/format";
import { DAEMON_OWNER, ONE_SHOT_OWNER } from "../../seams/workload-stamp.js";
import type { MemoryKill } from "./memory-records.js";

/* ONE KILL, ONE SENTENCE (2026-11-05). A process killed for memory is told in three places: the ending of the job it was
   part of and the notice its conversation hears (agent/tools/jobs/memory-kills.ts), the card and the re-run of a turn it
   held (agent/run/turn/holds/memory-kill.ts), and the post-mortem the boot after a stop draws (system/boot/restarts/
   post-mortem.ts). Each named the killer, the size and the owner its own way, so one kill read three ways: "netd's memory
   guard" here and "the sandbox's memory guard" there, 17.6 GiB of "peak RSS" beside 18.9 GB "resident". This module owns
   the killers' names and the one sentence; each place keeps its own words around it. */

// Who killed it, by the record's `killer` (memory-records.ts).
const KILLERS = {
    "netd-guard": "the sandbox's memory guard",
    "cgroup-oom": "the kernel at the sandbox's own memory bound",
    "kernel-oom": "the kernel's global OOM killer",
} as const satisfies Record<MemoryKill["killer"], string>;

// Every time in the sandbox's records is UTC; the sentence says so rather than leave a reader to guess their own zone.
const clock = (at: number): string => `${new Date(at).toISOString().slice(11, 19)} UTC`;

const sizeOf = (kill: MemoryKill): string => {
    const swapped = kill.swapBytes === undefined || kill.swapBytes === 0 ? undefined : `${sizeLabel(kill.swapBytes)} swapped`;
    if (kill.rssBytes === undefined) {
        return swapped === undefined ? "" : `, ${swapped}`;
    }
    return `, ${sizeLabel(kill.rssBytes)} resident${swapped === undefined ? "" : ` and ${swapped}`}`;
};

// Whose the process was, as the record names it: the job and the conversation that started it, or the daemon's own. A
// one-shot helper call is nobody's turn, so it names no one.
const originOf = (kill: MemoryKill): string => {
    if (kill.owner === DAEMON_OWNER) {
        return " (one of the daemon's own)";
    }
    const owner = kill.owner === undefined || kill.owner === "" || kill.owner === ONE_SHOT_OWNER ? undefined : kill.owner;
    if (kill.jobId !== undefined) {
        return owner === undefined ? ` from background job ${kill.jobId}` : ` from background job ${kill.jobId} of ${owner}`;
    }
    return owner === undefined ? "" : ` started by ${owner}`;
};

/** What only the post-mortem knows of a kill, and what a sentence naming several leaves out. */
export interface KillWording {
    // The victim was a daemon (the post-mortem tells by its cgroup or its pid), not a process of the workload.
    readonly daemon?: boolean;
    // A kernel kill no sample of netd's attributed: its pid is the machine's, not one any file in the sandbox uses.
    readonly machinePid?: boolean;
    // False where one sentence names several kills (the post-mortem's summary): each reason stays on its own record.
    readonly reason?: boolean;
}

/**
 * One kill in words, without a closing stop so a place can carry on after it: "integra (pid 1077125, 16.8 GB resident
 * and 30.7 GB swapped) from background job job-7 of sub-tidy-pebble-aii1 was killed for memory by the kernel's global
 * OOM killer at 04:21:57 UTC: memory pressure 92% for 30 s".
 */
export const killSentence = (kill: MemoryKill, wording: KillWording = {}): string => {
    const pid = wording.machinePid === true ? `the kernel's pid ${String(kill.pid)}` : `pid ${String(kill.pid)}`;
    const victim = wording.daemon === true ? `the daemon itself (${pid}${sizeOf(kill)})` : `${kill.comm} (${pid}${sizeOf(kill)})${originOf(kill)}`;
    const why = wording.reason === false || kill.reason === undefined ? "" : `: ${kill.reason.replace(/[.\s]+$/u, "")}`;
    return `${victim} was killed for memory by ${KILLERS[kill.killer]} at ${clock(kill.at)}${why}`;
};
