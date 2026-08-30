import type { AnnounceRefusal, BootReport, HostedStatus } from "@intentic-app/api-contract";

/* WHAT THE HOSTED WAIT IS ACTUALLY WAITING ON, decided in one pure place beside the page, the setupReport.ts
 * pattern, for the lane that had no equivalent.
 *
 * The card used to have a single sentence ("Starting your machine") and a stopwatch that eventually called it
 * slow. That sentence was shown to a machine that had not booted, a machine that had booted and gone silent, a
 * sandbox whose public address served nobody, and a sandbox we were refusing every time it spoke, four
 * different problems with four different answers, narrated identically and therefore not narrated at all.
 * People sat through it because nothing on screen distinguished "working" from "wedged".
 *
 * Three sources, in the order the boot actually happens, each covering the blind spot of the one before:
 *   • the MACHINE's power state, which the platform reads from the provider, the only thing that exists
 *     before the daemon does, so the only way to see a machine that never came up
 *   • the DAEMON's own report of whether its public address answers, which is the only way to see a box that
 *     is running perfectly and reachable by nobody
 *   • the platform's REFUSAL of a check-in, which is a dead end that otherwise exists only in a server log
 *
 * A wait that knows nothing (an older sandbox that reports nothing, a provider we cannot ask) falls all the
 * way back to the honest spinner this replaced. Saying less is fine; saying something we have not established
 * is not. */

// The steps, in the order they happen. `done` walks forward and never back, a machine that reports `stopping`
// mid-boot is Fly replacing it, not the wait un-happening, and a list that ticks backwards reads as breakage.
export type WaitStep = "machine" | "booting" | "connecting" | "ready";

export interface WaitStepView {
    readonly key: WaitStep;
    readonly label: string;
    // "done", passed; "active", where the wait is right now; "todo", not reached.
    readonly state: "done" | "active" | "todo";
}

const STEPS: readonly { key: WaitStep; label: string }[] = [
    { key: `machine`, label: `Starting the machine` },
    { key: `booting`, label: `Starting your sandbox` },
    { key: `connecting`, label: `Putting it on the internet` },
    { key: `ready`, label: `Ready` },
];

// A machine built to order spends its first boot pulling the sandbox image, the honest multi-minute stage
// (setupReport.ts names the same one on the command lane), so its first step SAYS so. "Starting the machine"
// over a download reads as a hang; the same minutes with the download named read as work.
const coldSteps = (steps: readonly { key: WaitStep; label: string }[]): readonly { key: WaitStep; label: string }[] =>
    steps.map((step) => (step.key === `machine` ? { ...step, label: `Starting the machine, downloading your sandbox` } : step));

/* What went wrong, in the words the card renders. `problem` is the state of the world; `remedy` is what
 * happens next, always present, because a failure with no next move is the spinner with extra steps.
 *
 * `action` is what the button under it does, and it exists because the two recoveries are not
 * interchangeable. A sandbox that has never checked in can be thrown away and made again, which is the only
 * thing that fixes a machine built with the wrong address baked into it. One that HAS checked in has files on
 * it, so it is booted again instead, enough to rerun a daemon that died and a tunnel that never bound, and
 * nothing is lost either way. From the reader's side both are "start it over"; only one of them is safe. */
export interface WaitFailure {
    readonly problem: string;
    readonly remedy: string;
    readonly action: "remake" | "reboot";
}

export interface HostedWaitView {
    readonly steps: readonly WaitStepView[];
    // Set once something has genuinely gone wrong. The card shows this INSTEAD of the step list: a list still
    // ticking beside "here is what broke" is the page contradicting itself (setupReport.ts's rule, same reason).
    readonly failure: WaitFailure | undefined;
    // The line under the healthy step list: the estimate this machine's ORIGIN earns (warm pool: seconds;
    // built to order: minutes of image pull), plus, once a minute is on the clock, how long it has been.
    // The one sentence the clock is allowed to shape, and only ever toward patience, never toward diagnosis.
    readonly note: string;
    // Whether the sandbox is confirmed usable from outside, the ONLY thing the handover is allowed to turn
    // on. Undefined means the sandbox has not said (an image older than the report, or a lane that never
    // probes), and undefined must behave exactly as this page behaved before any of this existed.
    readonly reachable: boolean | undefined;
}

export interface HostedWaitInput {
    // The machine as the provider reports it, `unknown` when the platform cannot ask, which is not a failure.
    readonly machine: HostedStatus[`machine`] | undefined;
    // The daemon's own last word, null until it has one.
    readonly boot: BootReport | null;
    // The last check-in we refused and why, null in the ordinary case of never having refused one.
    readonly refusal: AnnounceRefusal | null;
    // Whether the daemon has ever checked in (a `lastSeenAt` exists). Distinguishes a silent box from one that
    // is talking to us, which is the difference between "it never started" and "it started and can't be seen".
    readonly announced: boolean;
    // Where the machine came from (the summary's hosted stamp): warm pool, seconds; built to order, its
    // first boot pulls the image, minutes. Decides which estimate the card promises, because "under a minute"
    // over a cold pull is the lie that made healthy first boots read as stuck. Undefined (the stamp not read
    // yet) keeps the old promise.
    readonly warm: boolean | undefined;
    // How long this wait has been running. Only ever used to escalate a wait that is otherwise progressing,
    // never to invent a diagnosis, which is the trap the old stopwatch fell into.
    readonly waitedMs: number;
}

const MINUTE_MS = 60_000;
// Long enough that a cold machine pulling a first boot is not accused of being broken; short enough to catch
// someone who has settled in to watch. Only applies where nothing better is known.
const SILENT_MS = 3 * MINUTE_MS;
// A box that has been telling us for this long that its own address does not answer is not mid-boot any more.
// Matches the daemon's own give-up window (reach-report.ts REACH_GIVE_UP_MS), past it nothing is still trying.
const UNREACHABLE_MS = 5 * MINUTE_MS;
// When each origin's promise counts as SPENT and the note switches from estimate to reassurance: a warm
// machine past "under a minute" with margin, a cold one past the top of its own stated range.
const WARM_SPENT_MS = 90_000;
const COLD_SPENT_MS = 5 * MINUTE_MS;
// A machine still not running after this long, double a cold pull's worst honest case, has left narration
// territory: SILENT_MS deliberately never fires while the provider says `starting`/`created` (that is a pull
// going fine), so without this ceiling a wedged pull would reassure forever with no way out on screen.
const MACHINE_STUCK_MS = 10 * MINUTE_MS;

// What the sandbox's absence would read as, said under the whole step list. The estimate comes from the
// machine's ORIGIN, never the clock; the clock only says how much of the promise is spent and, once a minute
// is up, how long it has been, which is the difference between a page that is counting and one that froze.
const noteFor = (warm: boolean | undefined, waitedMs: number): string => {
    const minutes = Math.floor(waitedMs / MINUTE_MS);
    const inFor = minutes >= 1 ? `${minutes} min in, ` : ``;
    if (warm === false) {
        return waitedMs > COLD_SPENT_MS
            ? `${inFor}longer than usual, but still going. You'll be taken in as soon as it's ready.`
            : `${inFor}building a fresh machine: the first start downloads your sandbox, usually 3 to 5 minutes. You'll be taken in as soon as it's ready.`;
    }
    // Warm and unknown share the old promise, a pool machine really is seconds, and a stamp not read yet
    // must behave exactly as this page behaved before origins existed.
    return waitedMs > WARM_SPENT_MS
        ? `${inFor}taking longer than usual, but still going. You'll be taken in as soon as it's ready.`
        : `Usually under a minute. Nothing to install, nothing to paste, you'll be taken in as soon as it's ready.`;
};

// Machine states that mean the box is not coming up on its own. `failed` is Fly saying so outright; a machine
// sitting in `stopped` or `destroyed` while somebody waits on it will not start itself.
const DEAD_MACHINE = new Set([`stopped`, `suspended`, `destroying`, `destroyed`, `failed`]);

const at = (steps: readonly { key: WaitStep; label: string }[], active: WaitStep): WaitStepView[] => {
    const index = steps.findIndex((step) => step.key === active);
    return steps.map((step, position) => ({
        ...step,
        state: position < index ? `done` : position === index ? `active` : `todo`,
    }));
};

// A failure and the step it happened at, the shape both readers below answer in.
type Stall = { readonly step: WaitStep; readonly failure: WaitFailure };

/* THE FINALS, in rank order, each established by somebody rather than by the clock: no amount of waiting
 * changes any of them, so they outrank every other reading, including a machine that looks like it is booting. */
const finalFailure = (input: HostedWaitInput): Stall | undefined => {
    /* THE REFUSAL FIRST: a sandbox we are turning away is talking to us perfectly and will never be accepted,
     * and every other signal (a running machine, a booting daemon) would narrate progress that cannot happen.
     * This is the shape a half-migrated sandbox takes, and the one failure genuinely ours rather than the
     * machine's. */
    if (input.refusal !== null) {
        return {
            step: `connecting`,
            failure: {
                problem: `Your sandbox is running, but it's checking in from ${input.refusal.announced}, we expect it at ${input.refusal.expected}.`,
                remedy: `We won't hand you an address we can't vouch for. Start it over below, a fresh machine comes up on the right one.`,
                // The wrong address is built into this machine, so booting it again would reproduce it exactly.
                action: `remake`,
            },
        };
    }
    /* THE MACHINE IS NOT THERE AT ALL, which the platform learns by the provider refusing to answer about it.
     * Just as final as the refusal and just as invisible from inside the box: nothing is booting, nothing will
     * check in, and the wait would otherwise narrate a machine that stopped existing. Said plainly, INCLUDING
     * what it costs, because "start it over" here means a new machine with an empty disk rather than the same
     * one booted again, and a card that hid that would be promising files back that are not coming back. */
    if (input.machine === `gone`) {
        return {
            step: `machine`,
            failure: {
                problem: `The machine we were running for you isn't there any more.`,
                remedy: `Start it over below and we'll build you a new one, on the same address. Anything that was on the old machine is gone with it, and that's ours to fix, nothing on your side causes this.`,
                // `reboot` even though the machine is gone: the platform's restart replaces a machine that no
                // longer exists (sandbox.routes.ts), while `remake` hands the sandbox back first, which it
                // refuses to do for anything that has ever connected.
                action: `reboot`,
            },
        };
    }
    // The machine is not coming back on its own: Fly says stopped or failed, and nothing inside the box could
    // ever fix that.
    if (input.machine !== undefined && DEAD_MACHINE.has(input.machine)) {
        return {
            step: `machine`,
            failure: {
                problem: `The machine we started for you isn't running.`,
                remedy: `Start it over below. If it stops again, that's ours to fix, nothing on your side causes this.`,
                action: `reboot`,
            },
        };
    }
    return undefined;
};

/* THE BOX SAYS ITS OWN ADDRESS DOESN'T ANSWER, the failure that stranded everybody, and the one nothing else
 * on this page can see. Only a verdict once the daemon has stopped trying: before that it is the ordinary
 * state of a tunnel coming up, and calling it broken at three seconds would be a lie about a boot that is
 * going fine.
 *
 * `checking` counts here once the window is spent, and that is not a technicality: it is a box that said it
 * was testing itself and then never came back, the daemon died mid-probe, or its reports stopped arriving.
 * Reading it as "still working" forever would rebuild the exact silent wait this replaces, one state left. */
const unreachableFailure = (input: HostedWaitInput): Stall | undefined => {
    const stopped = input.boot?.reach === `unreachable` || input.boot?.reach === `checking`;
    if (!stopped || input.waitedMs <= UNREACHABLE_MS) {
        return undefined;
    }
    return {
        step: `connecting`,
        failure: {
            problem: input.boot?.detail ?? `Your sandbox is running, but it can't be reached at its address.`,
            remedy: `The sandbox itself is fine, it's the connection to it that didn't come up. Starting it over sets that up again; nothing on it is lost.`,
            // The box and its files are healthy; it is the boot's networking half that needs rerunning.
            action: `reboot`,
        },
    };
};

/* THE ONES THE CLOCK DECIDES, each with a window chosen so that a boot going fine is never accused of being
 * stuck. Only reached when nothing above has already ended the wait. */
const stalledFailure = (input: HostedWaitInput): Stall | undefined => {
    const unreachable = unreachableFailure(input);
    if (unreachable !== undefined) {
        return unreachable;
    }
    if (input.announced || input.boot !== null) {
        return undefined;
    }
    // Nothing has said anything for long enough that saying so beats a spinner. Deliberately not called a
    // failure: it may still arrive, and the machine keeps trying either way.
    if (input.waitedMs > SILENT_MS && input.machine !== `starting` && input.machine !== `created`) {
        return {
            step: `booting`,
            failure: {
                problem: `The machine is running, but your sandbox hasn't checked in yet.`,
                remedy: `It keeps trying on its own, leave this open or come back later. Starting it over is safe if you'd rather not wait.`,
                action: `reboot`,
            },
        };
    }
    /* The ceiling the exclusion above needs: `starting`/`created` are exempt from SILENT_MS because a pull in
     * flight is the ordinary shape of a cold first boot, but a machine STILL in them at double a pull's worst
     * honest case is not pulling any more, and without this the note would reassure forever with nothing on
     * screen to press. Same soft shape as the silence above: not called broken, and the reboot loses nothing. */
    if (input.waitedMs > MACHINE_STUCK_MS) {
        return {
            step: `machine`,
            failure: {
                problem: `The machine is taking far longer to come up than it should.`,
                remedy: `It keeps trying on its own, leave this open or come back later. Starting it over is safe if you'd rather not wait.`,
                action: `reboot`,
            },
        };
    }
    return undefined;
};

// The healthy readings, in order. Each is a fact somebody established, never elapsed time.
const healthyStep = (input: HostedWaitInput, reachable: boolean | undefined): WaitStep => {
    if (reachable === true) {
        return `ready`;
    }
    // The daemon exists and is either testing its address or waiting for the tunnel to bind.
    if (input.boot !== null || input.announced) {
        return `connecting`;
    }
    return input.machine === `started` ? `booting` : `machine`;
};

export const hostedWaitView = (input: HostedWaitInput): HostedWaitView => {
    const reachable = input.boot === null ? undefined : input.boot.reach === `reachable`;
    // The step labels this origin earns, and the caption under them, both origin-first, clock-second.
    const steps = input.warm === false ? coldSteps(STEPS) : STEPS;
    const note = noteFor(input.warm, input.waitedMs);
    const stall = finalFailure(input) ?? stalledFailure(input);
    return stall === undefined
        ? { steps: at(steps, healthyStep(input, reachable)), note, failure: undefined, reachable }
        : { steps: at(steps, stall.step), note, failure: stall.failure, reachable };
};
