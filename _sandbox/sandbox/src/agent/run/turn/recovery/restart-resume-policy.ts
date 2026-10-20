// WHETHER THIS BOOT PICKS UP WHAT THE RESTART CUT, decided once for every pass that could: interrupted turns
// (turn-resume.ts), interrupted automation fires (automations/fire-resume.ts), and stranded loops and workflow runs
// (loops/loop-runner.ts, workflows/workflow-runner.ts). Each pass used to work it out for itself, and the loop and
// workflow pass never did, so a loop restarted on every boot with autoResumeOnRestart off and through a restart storm
// that system/boot/boot-history.ts says resumes nothing. One value, read in bootstrap/boot-resumes.ts, keeps them agreeing.
// `asked`: the owner's ask for this restart is what resumes, rather than the setting; a resumed turn is told which.
export type RestartResume = { readonly resume: true; readonly asked: boolean } | { readonly resume: false; readonly why: "storm" | "off" };

// A restart storm resumes nothing, ask or setting (2026-10-05); otherwise the owner's ask for this restart counts as
// autoResumeOnRestart, this once.
export const restartResume = (facts: { readonly ownerAsked: boolean; readonly storm: boolean; readonly autoResumeOnRestart: boolean }): RestartResume => {
    if (facts.storm) {
        return { resume: false, why: "storm" };
    }
    return facts.ownerAsked || facts.autoResumeOnRestart ? { resume: true, asked: facts.ownerAsked } : { resume: false, why: "off" };
};

// Why nothing was picked up, in the words a turn's record and the log use.
export const notResumedReason = (policy: Extract<RestartResume, { resume: false }>): string =>
    policy.why === "storm" ? "this boot is one of a restart storm" : "autoResumeOnRestart is off";

// What a stranded loop or workflow run says when it is settled instead of resumed, on its card and in its record.
export const notResumedDetail = (policy: Extract<RestartResume, { resume: false }>): string =>
    policy.why === "storm"
        ? "The sandbox restarted while this ran, and a restart storm held it: nothing is resumed until the restarts stop."
        : "The sandbox restarted while this ran, and resuming after a restart is off.";
