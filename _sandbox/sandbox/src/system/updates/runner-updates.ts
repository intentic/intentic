import { errorMessage } from "@intentic/base/errors";
import type { RunnerSummary } from "@intentic/sandbox-contract/protocol/doors/runner-protocol";
import { runnerSlug } from "@intentic/sandbox-contract/protocol/doors/runner-protocol";
import type { DeviceFlowLine } from "@intentic/sandbox-contract/schemas/devices";
import { DEV_VERSION, isNewer } from "@intentic/sandbox-contract/state/versions";
import type { Logger } from "pino";
import type { Chore } from "../chore-clock.js";

/* RUNNERS FOLLOW THIS SANDBOX'S RELEASE (2026-11-10). A runner is built from the stable image of the day it was set up,
   and nothing moved it after that: the machine's background download leaves runners out ("a runner's image is the
   parent's decision to reconcile", machine auto-prepare.ts), and no parent ever reconciled. The editor's Update button
   shows only for an "outdated" badge, and two pulls of `:stable` a release apart read as the same build when neither side
   read a digest. So runner-omen-runner, set up on 2026-11-09 from 1.406.0, never got 1.407.0's "a runner is never
   quiet" and was slept by its machine the next morning, while its parent ran the release that had the fix.

   So this sandbox brings its runners up to its own release itself, through the same relayed update the button sends
   (`ic sandbox update runner-<name>` on the machine that asked for the runner). A runner is updated only when:
   - this sandbox and the runner both run a published release, the runner's older (a checkout build names no release);
   - it is online, and the machine that set it up is connected here (only that machine can reach its Docker);
   - no turn of this sandbox has run on it at this look or at the one before, since the update restarts its container.
   An update that did not bring the runner level (a channel with nothing newer yet, a machine refusing) is tried again
   later, each time later still, so a runner that cannot move costs a request a day, not one per look. */

// How often the runners are looked at. The second idle look is what lets an update go, so a runner is updated within
// about two of these after its last turn ends.
const RUNNER_UPDATE_EVERY_MS = 10 * 60_000;
// After an update that left the runner behind: an hour, then longer, up to a day.
const RETRY_MS = [60 * 60_000, 3 * 60 * 60_000, 6 * 60 * 60_000, 24 * 60 * 60_000] as const;

export const runnerUpdateRetryMs = (tries: number): number => (tries <= 0 ? 0 : RETRY_MS[Math.min(tries, RETRY_MS.length) - 1] ?? 0);

// The runner as this decision reads it: its summary's identity, where it lives and what it runs.
export type RunnerUpdateView = Pick<RunnerSummary, "id" | "host" | "online" | "version">;

// What is remembered of one runner between looks.
export interface RunnerUpdateWatch {
    // Whether the last look found nothing of this sandbox running on it.
    idleAtLastLook: boolean;
    // Updates asked for that have not brought it level, and the earliest the next may be.
    tries: number;
    retryAt: number;
}

export type RunnerUpdateVerdict =
    | { readonly kind: "update" }
    | { readonly kind: "leave"; readonly why: "dev-build" | "current" | "offline" | "no-host" | "host-offline" | "busy" | "settling" | "backing-off" };

// One look at one runner. Pure over this sandbox's version, the runner, whether its machine is connected here, whether a
// turn runs on it, what the last look left, and the clock.
export const judgeRunnerUpdate = (
    own: string,
    runner: RunnerUpdateView,
    hostConnected: boolean,
    busy: boolean,
    watch: RunnerUpdateWatch,
    now: number,
): RunnerUpdateVerdict => {
    if (own === DEV_VERSION || runner.version === undefined || runner.version === DEV_VERSION) {
        return { kind: "leave", why: "dev-build" };
    }
    if (!isNewer(own, runner.version)) {
        return { kind: "leave", why: "current" };
    }
    if (!runner.online) {
        return { kind: "leave", why: "offline" };
    }
    if (runner.host === undefined) {
        return { kind: "leave", why: "no-host" };
    }
    if (!hostConnected) {
        return { kind: "leave", why: "host-offline" };
    }
    if (busy) {
        return { kind: "leave", why: "busy" };
    }
    if (!watch.idleAtLastLook) {
        return { kind: "leave", why: "settling" };
    }
    if (now < watch.retryAt) {
        return { kind: "leave", why: "backing-off" };
    }
    return { kind: "update" };
};

export interface RunnerUpdateDeps {
    // This daemon's own release.
    readonly own: string;
    readonly runners: () => Promise<readonly RunnerUpdateView[]>;
    // Whether the machine with this host id is connected to this sandbox now.
    readonly hostConnected: (host: string) => boolean;
    // Whether a turn of this sandbox runs on this runner now.
    readonly busy: (runnerId: string) => boolean;
    // The relayed update, streamed as the machine prints it.
    readonly update: (host: string, slug: string) => AsyncIterable<DeviceFlowLine>;
    readonly logger: Pick<Logger, "info" | "warn">;
    readonly now: () => number;
}

export interface RunnerUpdateState {
    readonly watches: Map<string, RunnerUpdateWatch>;
}

export const newRunnerUpdateState = (): RunnerUpdateState => ({ watches: new Map() });

// The machine's own last word on the relayed update: its error, or undefined when it finished without one (a stream that
// ends with no terminal frame is the runner restarting under it, which is the update going ahead).
const updateError = async (lines: AsyncIterable<DeviceFlowLine>): Promise<string | undefined> => {
    let error: string | undefined;
    for await (const line of lines) {
        if (line.kind === "error") {
            error = line.message;
        }
    }
    return error;
};

// One look at every runner: each one behind this sandbox's release, idle for two looks, is updated, one at a time.
export const runRunnerUpdates = async (state: RunnerUpdateState, deps: RunnerUpdateDeps): Promise<void> => {
    const runners = await deps.runners();
    const enrolled = new Set(runners.map((runner) => runner.id));
    for (const id of state.watches.keys()) {
        if (!enrolled.has(id)) {
            state.watches.delete(id);
        }
    }
    for (const runner of runners) {
        const now = deps.now();
        const busy = deps.busy(runner.id);
        const before = state.watches.get(runner.id) ?? { idleAtLastLook: false, tries: 0, retryAt: 0 };
        const hostConnected = runner.host !== undefined && deps.hostConnected(runner.host);
        const verdict = judgeRunnerUpdate(deps.own, runner, hostConnected, busy, before, now);
        if (verdict.kind === "leave") {
            // Level again (by this, by a person's button, or by a newer release of its own): the ladder starts over.
            const level = verdict.why === "current" || verdict.why === "dev-build";
            state.watches.set(runner.id, level ? { idleAtLastLook: !busy, tries: 0, retryAt: 0 } : { ...before, idleAtLastLook: !busy });
            continue;
        }
        // Spent before the update runs, so one that hangs or throws still waits out the ladder.
        const tries = before.tries + 1;
        state.watches.set(runner.id, { idleAtLastLook: false, tries, retryAt: now + runnerUpdateRetryMs(tries) });
        const slug = runnerSlug(runner.id);
        deps.logger.info({ runner: runner.id, host: runner.host, from: runner.version, to: deps.own }, "runners: updating a runner to this sandbox's release");
        try {
            const error = await updateError(deps.update(runner.host ?? "", slug));
            if (error !== undefined) {
                deps.logger.warn({ runner: runner.id, host: runner.host, error }, "runners: the machine refused the runner's update; tried again later");
            }
        } catch (error) {
            deps.logger.warn({ runner: runner.id, host: runner.host, err: errorMessage(error) }, "runners: the runner's update did not run; tried again later");
        }
    }
};

// The look on the daemon's housekeeping clock (chore-clock.ts), with its memory of the last look kept for the daemon's life.
export const runnerUpdatesChore = (deps: RunnerUpdateDeps): Chore => {
    const state = newRunnerUpdateState();
    return { name: "runners-follow-release", everyMs: RUNNER_UPDATE_EVERY_MS, run: () => runRunnerUpdates(state, deps) };
};
