import type { PostMortem } from "../../../../system/resources/memory-records.js";

// WHETHER THIS BOOT PICKS UP WHAT THE RESTART CUT, decided once for every pass that could: interrupted turns
// (turn-resume.ts), interrupted automation fires (automations/fire-resume.ts), and stranded loops and workflow runs
// (loops/loop-runner.ts, workflows/workflow-runner.ts). Each pass used to work it out for itself, and the loop and
// workflow pass never did, so a loop restarted on every boot with autoResumeOnRestart off and through a restart storm
// that system/boot/boot-history.ts says resumes nothing. One value, read in bootstrap/boot-resumes.ts, keeps them agreeing.
// `asked`: the owner's ask for this restart is what resumes, rather than the setting; a resumed turn is told which.
// `memory`: the boot's post-mortem traced the restart to memory running out, which decides for the cut turns on its own
// terms (memory-restart.ts) and leaves every other kind of cut work to `resume`.
export type RestartResume = (
    | { readonly resume: true; readonly asked: boolean }
    | { readonly resume: false; readonly why: "storm" | "off" }
) & { readonly memory?: MemoryRestart | undefined };

/* A RESTART MEMORY CAUSED (2026-11-05). A background job grew without limit, the VM thrashed, netd killed the frozen
   daemon, and the five turns it cut came back "interrupted … autoResumeOnRestart is off", though only one conversation
   had caused it. Switching that setting on would have re-run the cause too, all at once, into a machine still
   recovering. A restart the post-mortem names as memory's instead holds every turn it cut for the memory release, which
   lets them back one at a time once memory has stayed free, on each conversation's answer to a memory kill, whatever
   autoResumeOnRestart says; the conversations whose own process was the one killed are held for a press, with what the
   post-mortem found on their card. A restart storm still resumes nothing. */
export interface MemoryRestart {
    // The post-mortem's named cause in one sentence, told to each turn it cut and on each held card.
    readonly summary: string;
    // The conversations whose own process was killed for memory: never re-run by themselves.
    readonly culprits: ReadonlySet<string>;
}

// A restart storm resumes nothing, ask or setting (2026-10-05), memory's or not; otherwise the owner's ask for this
// restart counts as autoResumeOnRestart, this once, and a restart memory caused carries what decides for its turns.
export const restartResume = (facts: {
    readonly ownerAsked: boolean;
    readonly storm: boolean;
    readonly autoResumeOnRestart: boolean;
    readonly memory?: MemoryRestart | undefined;
}): RestartResume => {
    if (facts.storm) {
        return { resume: false, why: "storm" };
    }
    const memory = facts.memory === undefined ? {} : { memory: facts.memory };
    return facts.ownerAsked || facts.autoResumeOnRestart ? { resume: true, asked: facts.ownerAsked, ...memory } : { resume: false, why: "off", ...memory };
};

// What tells a daemon starved of memory from one stuck on its own, where netd killed it with no memory kill near the end:
// a restart netd held back for want of memory, or tasks stalled on memory for a tenth of the ten seconds before it acted
// (PSI some avg10, in percent). Below that a loop is slow, not starved. Not a kill in `killed`: a `netd-stuck` cause
// means none came near the end (post-mortem.ts NEAR_STOP_MS), so any there is one the run survived.
const STARVED_SOME_PERCENT = 10;

const pressureOnRecord = (postMortem: PostMortem): boolean =>
    postMortem.netd.some((kill) => kill.kind === "restart-held" || (kill.psi?.someAvg10 ?? 0) >= STARVED_SOME_PERCENT);

/** Whether the post-mortem traces the restart to memory: a memory kill, the daemon itself the OOM killer's, or netd ending a loop memory starved. */
export const memoryCaused = (postMortem: PostMortem): boolean =>
    postMortem.cause === "memory" || postMortem.cause === "oom-victim" || (postMortem.cause === "netd-stuck" && pressureOnRecord(postMortem));

/**
 * What a restart memory caused decides for its cut turns, or undefined for a restart it did not cause, which behaves
 * exactly as before. A parent whose subagent is the culprit is not one itself: its own turn was a victim like any other,
 * and comes back told which child it was (memory-kill.ts memoryTail), so a conversation the post-mortem names that only
 * supervises another it names, with no kill on record of a process of its own, is let go. `supervisorOf` answers who
 * spawned a conversation (auth/principal.ts).
 */
export const memoryRestartOf = (postMortem: PostMortem | undefined, supervisorOf: (conversationId: string) => string | undefined): MemoryRestart | undefined => {
    if (postMortem === undefined || !memoryCaused(postMortem)) {
        return undefined;
    }
    const named = new Set(postMortem.culprits);
    const owners = new Set(postMortem.killed.flatMap((kill) => (kill.owner === undefined ? [] : [kill.owner])));
    const parentOnly = (id: string): boolean => !owners.has(id) && [...named].some((other) => other !== id && supervisorOf(other) === id);
    return { summary: postMortem.summary, culprits: new Set([...named].filter((id) => !parentOnly(id))) };
};

// Why nothing was picked up, in the words a turn's record and the log use.
export const notResumedReason = (policy: Extract<RestartResume, { resume: false }>): string =>
    policy.why === "storm" ? "this boot is one of a restart storm" : "autoResumeOnRestart is off";

// What a stranded loop or workflow run says when it is settled instead of resumed, on its card and in its record.
export const notResumedDetail = (policy: Extract<RestartResume, { resume: false }>): string =>
    policy.why === "storm"
        ? "The sandbox restarted while this ran, and a restart storm held it: nothing is resumed until the restarts stop."
        : "The sandbox restarted while this ran, and resuming after a restart is off.";
