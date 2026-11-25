import { basename } from "node:path";
import type { NetdKill } from "../../resources/memory-records.js";

/* WHAT NETD KEPT OF A DAEMON IT KILLED STUCK, SAID IN THE POST-MORTEM'S SENTENCE (2026-11-24). Before netd kills a daemon
   whose ping went unanswered, or a start that never said hello, it reads every thread's state, wait channel, syscall
   and kernel stack out of /proc into a file beside its records, and asks Node for a diagnostic report with SIGUSR2
   (_sandbox/netd/crates/netd/src/evidence.rs); the kill's line names both (`evidence`, memory-records.ts). This says
   them, so the restart record's sentence and the diagnostics `restarts` tool point a reader at the files:
   - the main thread asleep in the kernel (`D`, or `S` on a wait channel) is a blocking call that never returned: a sync
     read on a hung network mount names a cifs or nfs channel;
   - the main thread running is JavaScript or native code that never yielded, which no report can show: Node answers
     the report signal on the event loop it stopped, so a report comes only from a loop still turning. */

const STATE_WORDS = new Map([
    ["R", "running (JavaScript or native code that never yielded)"],
    ["S", "asleep"],
    ["D", "in uninterruptible sleep (a blocking call in the kernel, often disk or a network mount)"],
    ["T", "stopped"],
    ["t", "stopped by a tracer"],
    ["Z", "a zombie"],
]);

const mainThreadText = ({ state, wchan }: NonNullable<NetdKill["evidence"]>): string | undefined => {
    if (state === undefined) {
        return undefined;
    }
    return `its main thread was ${STATE_WORDS.get(state) ?? `in state ${state}`}${wchan === undefined ? "" : ` in ${wchan}`}`;
};

const reportText = ({ signal, report }: NonNullable<NetdKill["evidence"]>): string | undefined => {
    if (report !== undefined) {
        return `Node's report is ${basename(report)}`;
    }
    return signal === undefined ? undefined : `no Node report came on ${signal}, so its event loop never turned again`;
};

/** What netd kept of the daemon it killed, in words for the post-mortem's sentence; undefined when it kept nothing. */
export const evidenceText = (kill: NetdKill | undefined): string | undefined => {
    const evidence = kill?.evidence;
    if (evidence === undefined) {
        return undefined;
    }
    const parts = [
        mainThreadText(evidence),
        evidence.capture === undefined ? undefined : `every thread is in ${evidence.capture}`,
        reportText(evidence),
    ].filter((part) => part !== undefined);
    return parts.length === 0 ? undefined : parts.join(", ");
};

/** The kill whose evidence the sentence names: the first stuck kill, else the newest start that never said hello. */
export const evidenceKill = (netd: readonly NetdKill[]): NetdKill | undefined =>
    netd.find((kill) => kill.kind === "stuck" && kill.evidence !== undefined) ?? netd.findLast((kill) => kill.kind === "no-hello" && kill.evidence !== undefined);
