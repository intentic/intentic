import type { AnnounceRefusal, BootReport, HostedStatus } from "@intentic/api-contract";

// Decides what the hosted wait is waiting on, from three sources in boot order: machine power state (from the
// provider), the daemon's own report of its public address, and a platform refusal of a check-in, each covering
// the blind spot of the one before. A wait that knows nothing falls back to a plain spinner; never states what
// is not established.

// Steps in boot order. `done` never reverts: a machine reporting `stopping` mid-boot is Fly replacing it, not the
// wait un-happening.
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

// A machine built to order spends its first boot pulling the sandbox image. Naming that stage keeps the same
// minutes from reading as a hang.
const coldSteps = (steps: readonly { key: WaitStep; label: string }[]): readonly { key: WaitStep; label: string }[] =>
    steps.map((step) => (step.key === `machine` ? { ...step, label: `Starting the machine, downloading your sandbox` } : step));

// `remedy` is always present, never a diagnosis with no next move. `action` is `remake` for a sandbox that never
// checked in (bad address baked in), `reboot` for one that has files and only needs restarting.
export interface WaitFailure {
    readonly problem: string;
    readonly remedy: string;
    readonly action: "remake" | "reboot";
}

export interface HostedWaitView {
    readonly steps: readonly WaitStepView[];
    // Set once something has failed; the card shows this instead of the step list, never both.
    readonly failure: WaitFailure | undefined;
    // Estimate from the machine's origin (warm: seconds, cold: minutes), plus elapsed time past a minute.
    readonly note: string;
    // Whether the sandbox is confirmed reachable; undefined means it hasn't said (old image, non-probing lane).
    readonly reachable: boolean | undefined;
    // Whether the daemon's boot chain has not yet converged; false when it reports nothing (older images).
    readonly booting: boolean;
}

export interface HostedWaitInput {
    // The machine as the provider reports it, `unknown` when the platform cannot ask, which is not a failure.
    readonly machine: HostedStatus[`machine`] | undefined;
    // The daemon's own last word, null until it has one.
    readonly boot: BootReport | null;
    // The last check-in we refused and why, null in the ordinary case of never having refused one.
    readonly refusal: AnnounceRefusal | null;
    // Whether the daemon has ever checked in (`lastSeenAt` exists); distinguishes silent from unreachable.
    readonly announced: boolean;
    // Machine origin: warm pool (seconds) or built to order (minutes, image pull); undefined keeps the old estimate.
    readonly warm: boolean | undefined;
    // Elapsed wait time; only escalates an otherwise-progressing wait, never invents a diagnosis on its own.
    readonly waitedMs: number;
}

const MINUTE_MS = 60_000;
// Long enough that a cold first boot isn't accused of being broken; applies only when nothing better is known.
const SILENT_MS = 3 * MINUTE_MS;
// Matches the daemon's give-up window (reach-report.ts REACH_GIVE_UP_MS); past this, nothing is still trying.
const UNREACHABLE_MS = 5 * MINUTE_MS;
// When each origin's promise is spent, and the note turns to reassurance: warm past ~1 min, cold past its range.
const WARM_SPENT_MS = 90_000;
const COLD_SPENT_MS = 5 * MINUTE_MS;
// Ceiling for a stuck machine: SILENT_MS never fires while the provider reports `starting`/`created`.
const MACHINE_STUCK_MS = 10 * MINUTE_MS;

// Note under the step list. The estimate comes from the machine's origin, never the clock; the clock only tracks
// how much of that promise is spent.
const noteFor = (warm: boolean | undefined, waitedMs: number): string => {
    const minutes = Math.floor(waitedMs / MINUTE_MS);
    const inFor = minutes >= 1 ? `${minutes} min in, ` : ``;
    if (warm === false) {
        return waitedMs > COLD_SPENT_MS
            ? `${inFor}longer than usual, but still going. You'll be taken in as soon as it's ready.`
            : `${inFor}building a fresh machine: the first start downloads your sandbox, usually 3 to 5 minutes. You'll be taken in as soon as it's ready.`;
    }
    // Warm and unknown share the same promise: a stamp not yet read behaves like the old, origin-less estimate.
    return waitedMs > WARM_SPENT_MS
        ? `${inFor}taking longer than usual, but still going. You'll be taken in as soon as it's ready.`
        : `Usually under a minute. Nothing to install, nothing to paste, you'll be taken in as soon as it's ready.`;
};

// States meaning the machine won't come up on its own: `failed` outright, or sitting `stopped`/`destroyed`.
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

// Failures established by fact, not by elapsed time; they outrank every other reading, including a machine that
// looks like it's booting.
const finalFailure = (input: HostedWaitInput): Stall | undefined => {
    // Refusal outranks every other signal, which would otherwise narrate progress that can't happen.
    if (input.refusal !== null) {
        return {
            step: `connecting`,
            failure: {
                problem: `Your sandbox is running, but it's checking in from ${input.refusal.announced}, we expect it at ${input.refusal.expected}.`,
                remedy: `We won't hand you an address we can't vouch for. Start it over below, a fresh machine comes up on the right one.`,
                // The wrong address is baked into this machine; rebooting it would reproduce it.
                action: `remake`,
            },
        };
    }
    // Machine gone entirely, as final as a refusal; starting over means a new, empty machine.
    if (input.machine === `gone`) {
        return {
            step: `machine`,
            failure: {
                problem: `The machine we were running for you isn't there any more.`,
                remedy: `Start it over below and we'll build you a new one, on the same address. Anything that was on the old machine is gone with it, and that's ours to fix, nothing on your side causes this.`,
                // `reboot`, not `remake`: restart replaces a gone machine; `remake` refuses anything that has ever
                // connected.
                action: `reboot`,
            },
        };
    }
    // Not coming back on its own: Fly reports stopped or failed; nothing inside the box can fix that.
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

// Only a verdict once the daemon's window is spent; before that a tunnel is ordinarily still coming up.
// `checking` counts here too, once spent.
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
            // Box and files are healthy; only the boot's networking half needs rerunning.
            action: `reboot`,
        },
    };
};

// Failures the clock decides, each windowed so a boot going fine is never accused of being stuck; reached only
// when nothing above already ended the wait.
const stalledFailure = (input: HostedWaitInput): Stall | undefined => {
    const unreachable = unreachableFailure(input);
    if (unreachable !== undefined) {
        return unreachable;
    }
    if (input.announced || input.boot !== null) {
        return undefined;
    }
    // Long silence stated plainly, not as failure: it may still arrive, and the machine keeps trying.
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
    // Ceiling for `starting`/`created`, exempt from SILENT_MS as an ordinary cold pull; past double that it's stuck.
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

// The daemon's own account of its chain, when it gave one and the chain is still running.
const converging = (input: HostedWaitInput): { readonly step: string | undefined } | undefined =>
    input.boot?.boot !== undefined && !input.boot.boot.ready ? { step: input.boot.boot.step } : undefined;

// The healthy readings, in order. Each is a fact somebody established, never elapsed time.
const healthyStep = (input: HostedWaitInput, reachable: boolean | undefined): WaitStep => {
    // A reachable box still converging its workspace still reads as booting to the reader.
    if (converging(input) !== undefined) {
        return `booting`;
    }
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
    const chain = converging(input);
    // Step labels are origin-first, clock-second; when the daemon names its step, the booting row echoes it.
    const origin = input.warm === false ? coldSteps(STEPS) : STEPS;
    const steps =
        chain?.step === undefined
            ? origin
            : origin.map((step) => (step.key === `booting` ? { ...step, label: `Starting your sandbox: ${chain.step}` } : step));
    const note = noteFor(input.warm, input.waitedMs);
    const stall = finalFailure(input) ?? stalledFailure(input);
    const booting = chain !== undefined;
    return stall === undefined
        ? { steps: at(steps, healthyStep(input, reachable)), note, failure: undefined, reachable, booting }
        : { steps: at(steps, stall.step), note, failure: stall.failure, reachable, booting };
};
