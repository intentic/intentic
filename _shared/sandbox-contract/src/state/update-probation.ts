// THE POLICY AN UPDATE IS HELD TO AFTER IT TOOK, one policy on two substrates.
//
// A new version of a sandbox that came up is not yet a version that works. On a machine `ic` runs, the old container stays
// parked and ready while a watch looks at the new one (_sandbox/ic/src/sandbox/probation.rs), and puts the old one back
// by itself if it keeps failing. On Fly the platform's api does the same job over the image the machine's row keeps as
// its way back (_platform/api/src/sandbox/hosted/gate/hosted-probation.ts). The two cannot share code (one looks through
// Docker, the other through Fly's exec), so they share what decides: the numbers below, and `judgeProbation` /
// `probationStep`, the rule that turns one look at the new version into a verdict and a verdict into a step.
//
// `ic` owns the rule; this is its TS twin, and golden/update-probation.json holds each number and each case, hand-written
// from the Rust: ic's test (probation.rs) and this package's test (update-probation.test.ts) both build every one, so
// neither can drift without the other failing. A number changes here, in the golden and in ic's constant together.

// Restarts that make a crash loop, whoever counts them: netd restarting a crashed daemon inside a container that stays up,
// Docker restarting the container, Fly restarting the machine, or the editor reading a sandbox's vitals (diagnose.ts).
// ic's health.rs CRASH_LOOP_RESTARTS and the platform's gate (daemon-health.ts) are this number too.
export const CRASH_LOOP_RESTARTS = 3;

export const UPDATE_PROBATION = {
    // How long the version before an update is kept ready to go back to (`IC_PROBATION_SECONDS` shortens ic's, for its
    // nightly drill), and how long the platform watches a hosted machine's new image.
    watchMs: 24 * 60 * 60_000,
    // How long a new version may stay not-ready, unreachable or silent before that counts against it: longer than any
    // healthy first boot (state conversions, a cold cache), which the switch's own health wait already sat through.
    graceMs: 10 * 60_000,
    // An open state journal is a boot still converting; past this it is a boot that will not finish.
    journalMs: 15 * 60_000,
    // Consecutive failed looks that end a probation in a rollback: never one bad answer.
    strikes: 3,
    // Rollback targets kept BEYOND `previous`, newest first: older builds `ic sandbox rollback --to` reaches without a
    // download (record.rs MAX_KEPT). The hosted row keeps only `previous`; see the platform's gate-row.ts.
    keptBuilds: 2,
    // Restarts that are a crash loop on their own, of the container and of the daemon inside it.
    crashLoopRestarts: CRASH_LOOP_RESTARTS,
} as const;

// A tunnel that has been `checking` this much longer than the grace has not come up.
const TUNNEL_EXTRA_MS = 5 * 60_000;

// What one look at the new version found: the same facts ic gathers through Docker and the platform through Fly.
// `null` is "not known" (a daemon too old to say), which is never held against a version.
export interface ProbationLook {
    // The container (the Fly machine) is running, and whether it is on its way down or up.
    readonly running: boolean;
    readonly restarting: boolean;
    // How many times the container has restarted: past `crashLoopRestarts` it is a crash loop on its own.
    readonly restarts: number;
    // `/health` answered with a document.
    readonly answered: boolean;
    // `boot.ready` (or an older daemon's top-level `ready`).
    readonly ready: boolean | null;
    // `state.journal`: open, none, failed.
    readonly journal: string | null;
    // `reach.state`: off, checking, reachable, unreachable.
    readonly reach: string | null;
    // What the daemon wrote to /history/boot-failure.json after the swap began.
    readonly bootFailure: string | null;
    // How many times the watch has seen the daemon start again inside a running container.
    readonly daemonRestarts: number;
    // netd's own word that the daemon keeps crashing, already in words.
    readonly crashLoop: string | null;
    // The owner stopped it on purpose: there is nothing to judge until it runs.
    readonly held: boolean;
}

// The facts of the swap a look is judged against: when the new version began, and how the old one's tunnel read.
export interface ProbationSwap {
    readonly at: number;
    // Held only to a tunnel the old version had.
    readonly reach: string | null;
}

export type ProbationVerdict =
    // The strikes start over.
    | { readonly kind: "healthy" }
    // Too early to hold anything against it.
    | { readonly kind: "pending" }
    // One failed look.
    | { readonly kind: "strike"; readonly reason: string }
    // Nothing to wait for: go back now.
    | { readonly kind: "fail"; readonly reason: string };

const strike = (reason: string): ProbationVerdict => ({ kind: "strike", reason });
const fail = (reason: string): ProbationVerdict => ({ kind: "fail", reason });
const PENDING: ProbationVerdict = { kind: "pending" };

// The condition a stopped-on-purpose, failed-boot, failed-conversion or crash-looping version is judged by, before the
// slower ones. Split out so `judgeProbation` reads as the list of what it is judged on, in order.
const failure = (look: ProbationLook): ProbationVerdict | undefined => {
    if (look.bootFailure !== null) {
        return fail(`the new version could not start: ${look.bootFailure}`);
    }
    if (look.journal === "failed") {
        return fail("the new version could not convert this sandbox's stored files; it put them back as they were");
    }
    if (look.daemonRestarts >= UPDATE_PROBATION.crashLoopRestarts) {
        return fail(`the new version's daemon kept crashing (${look.daemonRestarts} restarts)`);
    }
    if (look.crashLoop !== null) {
        return fail(`the new version's daemon kept crashing: ${look.crashLoop}`);
    }
    return undefined;
};

// Held only to a tunnel the old version had: a sandbox reached on loopback alone has none to lose.
const tunnel = (look: ProbationLook, swap: ProbationSwap, since: number, graceMs: number): ProbationVerdict | undefined => {
    if (swap.reach !== "reachable") {
        return undefined;
    }
    if (look.reach === "unreachable" && since >= graceMs) {
        return strike("the new version cannot be reached through its tunnel");
    }
    if (look.reach === "checking" && since >= graceMs + TUNNEL_EXTRA_MS) {
        return strike("the new version's tunnel never came up");
    }
    return look.reach === "unreachable" || look.reach === "checking" ? PENDING : undefined;
};

// The judgement, pure over one look, the swap and the clock: ic's `judge` (probation.rs), reason for reason.
export const judgeProbation = (look: ProbationLook, swap: ProbationSwap, now: number, graceMs: number = UPDATE_PROBATION.graceMs): ProbationVerdict => {
    const since = Math.max(0, now - swap.at);
    const late = since >= graceMs;
    // Stopped on purpose: there is nothing to judge, and going back would start a sandbox its owner stopped.
    if (look.held && !look.running && !look.restarting) {
        return PENDING;
    }
    const failed = failure(look);
    if (failed !== undefined) {
        return failed;
    }
    if (!look.running || look.restarting) {
        return look.restarts >= UPDATE_PROBATION.crashLoopRestarts
            ? fail(`the new version kept crashing (${look.restarts} restarts)`)
            : strike("the new version's container is not running");
    }
    if (!look.answered) {
        return late ? strike("the new version's daemon is not answering") : PENDING;
    }
    if (look.journal === "open") {
        return since >= UPDATE_PROBATION.journalMs ? strike("the new version is still converting stored files after 15 minutes") : PENDING;
    }
    if (look.ready === false) {
        return late ? strike("the new version never finished starting up") : PENDING;
    }
    return tunnel(look, swap, since, graceMs) ?? { kind: "healthy" };
};

// What the watch does with a verdict: go back, keep watching with the strikes as they now stand, or let the old version
// go because the probation is over.
export type ProbationStep =
    | { readonly action: "roll-back"; readonly reason: string }
    | { readonly action: "watch"; readonly strikes: number; readonly reason?: string }
    | { readonly action: "keep" };

// ic's judge_probation, as a decision over the verdict, the strikes so far and whether the probation is over. Pure.
export const probationStep = (verdict: ProbationVerdict, strikes: number, over: boolean): ProbationStep => {
    switch (verdict.kind) {
        case "fail":
            return { action: "roll-back", reason: verdict.reason };
        case "strike":
            return strikes + 1 >= UPDATE_PROBATION.strikes
                ? { action: "roll-back", reason: verdict.reason }
                : { action: "watch", strikes: strikes + 1, reason: verdict.reason };
        case "healthy":
            return over ? { action: "keep" } : { action: "watch", strikes: 0 };
        case "pending":
            return over ? { action: "keep" } : { action: "watch", strikes };
    }
};
