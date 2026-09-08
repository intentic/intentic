import type { Logger } from "pino";
import { containerDrift } from "@intentic/sandbox-contract";
import { sandboxIdFromToken } from "@intentic/sandbox-contract/tunnel-ids";
import type { Config } from "../../env.config.js";
import type { BootTracker } from "../boot/boot.js";
import type { ReachPosture } from "./ingress-tunnel.js";
import { readCpuThrottle } from "../resources/cpu-throttle.js";
import { postToPlatform } from "../platform-post.js";

// Whether anybody can actually reach this sandbox, which announce next door does not answer: a daemon can boot and
// register while its public tunnel serves nobody. Nothing else can check this from outside, so the box probes its own
// public address and reports the verdict over its outbound channel, not through the tunnel that might be what's broken.

// The probe's own public name must answer with our sandboxId; matching it is what makes this a proof, not a ping.
interface HealthAnswer {
    readonly sandboxId?: unknown;
}

// This runs on a loop, so one hung probe (a tunnel with nothing bound behind it) must not stall the whole report.
const PROBE_TIMEOUT_MS = 10_000;
// Backoff ceiling while unreachable; a cold box's share can take seconds to come up, so early misses are expected.
const MAX_BACKOFF_MS = 30_000;
// How long the setup wizard waits before giving up; the two must agree, or the page waits on a report that stopped.
const REACH_GIVE_UP_MS = 5 * 60_000;

// Same shape as the announce block beside it (/health carries both), so doctor/postflight can name whichever link
// broke.
export interface ReachState {
    // off, nothing to probe
    // checking, no verdict yet
    // reachable, its own public address answered with our id
    // unreachable, it did not
    readonly state: "off" | "checking" | "reachable" | "unreachable";
    // Why, for "unreachable", already in the user's terms since the wizard renders it verbatim.
    readonly detail?: string;
    // False once the give-up window is spent; only a restart retries after that.
    readonly retrying?: boolean;
    readonly at?: number;
}

export interface ReachReporter {
    /* WHETHER THERE IS ANYTHING TO WAIT FOR is the posture's to say (ingress-tunnel.ts), so it is asked for
     * here rather than guessed at from config: the give-up window below is patience for a dial in flight, and
     * a container that dials nothing has no dial to be patient about. */
    readonly start: (posture: ReachPosture) => void;
    readonly stop: () => void;
    readonly status: () => ReachState;
}

// One round trip to our own public address, over plain fetch since this must verify TLS like a real browser would.
// Every failure is worded for the setup page it lands on.
export const probeSelf = async (publicUrl: string, expectedId: string | undefined): Promise<{ ok: true } | { ok: false; detail: string }> => {
    let response: Response;
    try {
        response = await fetch(`${publicUrl}/health`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    } catch (error) {
        const timedOut = error instanceof DOMException && error.name === "TimeoutError";
        return {
            ok: false,
            detail: timedOut
                ? `${publicUrl} accepted the connection but never answered: its tunnel is up with nothing behind it yet.`
                : `${publicUrl} could not be reached from inside the sandbox, its tunnel has not come up.`,
        };
    }
    if (!response.ok) {
        return { ok: false, detail: `${publicUrl} answered ${response.status} instead of this sandbox, its tunnel is not routing here yet.` };
    }
    const body = (await response.json().catch(() => undefined)) as HealthAnswer | undefined;
    // A 200 from something else is the worst failure to leave unnamed: traffic looks healthy and goes elsewhere.
    if (expectedId !== undefined && typeof body?.sandboxId === "string" && body.sandboxId !== expectedId) {
        return { ok: false, detail: `${publicUrl} is answering for a different sandbox, this address is not (or not yet) ours.` };
    }
    return { ok: true };
};

// `bootOf` is fetched at call time since the reporter and tracker are composed in the same literal (composition.ts); it
// rides boot progress and CPU throttling onto the report, both optional and absent from an older daemon.
export const createReachReporter = (config: Config, logger: Logger, bootOf: () => BootTracker | undefined = () => undefined): ReachReporter => {
    let timer: NodeJS.Timeout | undefined;
    let deadline = 0;
    let backoff = 3_000;
    let status: ReachState = { state: "off" };
    let unsubscribeBoot: (() => void) | undefined;
    const publicUrl = config.sandbox.publicUrl;
    const expectedId = sandboxIdFromToken(config.connectToken);

    const bootSnapshot = (): { ready: boolean; step?: string; done: number; total: number } | undefined => {
        const progress = bootOf()?.progress();
        if (progress === undefined) {
            return undefined;
        }
        const running = progress.steps.find((step) => step.state === "running");
        return {
            ready: progress.ready,
            ...(running === undefined ? {} : { step: running.label }),
            done: progress.steps.filter((step) => step.state === "done" || step.state === "failed").length,
            total: progress.steps.length,
        };
    };

    // Best-effort by construction: a platform that can't be reached is the announce's problem to report, not this one's
    // to duplicate.
    // retrying is the caller's to state: the converged re-post sends an earlier verdict on purpose.
    const tell = async (reach: ReachState["state"], detail?: string, retrying?: boolean): Promise<void> => {
        if (reach === "off") {
            return;
        }
        const boot = bootSnapshot();
        const cpu = readCpuThrottle();
        // Sent on every report: this is the only channel that still works when the tunnel itself is broken.
        // Computed per post, not cached: a pure read of process.env, so nothing can go stale.
        const drift = containerDrift(process.env);
        const answer = await postToPlatform(config, "/sandbox/boot-report", {
            reach,
            ...(detail === undefined ? {} : { detail }),
            ...(retrying === undefined ? {} : { retrying }),
            ...(boot === undefined ? {} : { boot }),
            ...(cpu === undefined ? {} : { cpu }),
            ...(drift.length === 0 ? {} : { drift }),
        });
        if ("error" in answer) {
            logger.debug({ err: answer.error }, "reachability report could not be delivered");
        }
    };

    // Reports again once the boot chain converges, since the reach verdict may have landed minutes earlier and a wait
    // on `boot.ready` would otherwise never learn it. One re-post, then the subscription is spent.
    const reportWhenConverged = (): void => {
        const tracker = bootOf();
        if (tracker === undefined || tracker.progress().ready) {
            return;
        }
        unsubscribeBoot = tracker.subscribe((progress) => {
            if (!progress.ready) {
                return;
            }
            unsubscribeBoot?.();
            unsubscribeBoot = undefined;
            void tell(status.state, status.detail, status.retrying);
        });
    };

    const attempt = async (): Promise<void> => {
        const verdict = await probeSelf(publicUrl, expectedId);
        if (verdict.ok) {
            logger.info({ publicUrl }, "sandbox is reachable at its public address");
            status = { state: "reachable", at: Date.now() };
            await tell("reachable");
            return; // Proved: go quiet, like the announce does after its ack.
        }
        const spent = Date.now() >= deadline;
        logger.warn({ publicUrl, detail: verdict.detail }, "sandbox is not reachable at its public address yet");
        status = { state: "unreachable", detail: verdict.detail, retrying: !spent, at: Date.now() };
        // retrying stays true until spent: only the last post promotes a quiet wait into a standing card.
        await tell("unreachable", verdict.detail, !spent);
        if (spent) {
            return;
        }
        timer = setTimeout(() => void attempt(), backoff);
        backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
    };

    return {
        start: (posture) => {
            /* THE ONE VERDICT THAT IS SETTLED THE MOMENT IT IS ASKED, and getting it wrong cost somebody an
             * evening. A container handed a public name but no grant and no edge to dial will not start
             * answering there in five minutes or in five days — the values it needs ride in with a setup
             * command, and until one does, every probe spends ten seconds to reprint the same 502. What the
             * wizard read while that happened was "its tunnel has not come up", which is a sentence about
             * waiting, so people waited; the daemon log said the same thing every thirty seconds and then
             * fell silent, and the address kept being handed to device-pairing commands that could never
             * work. `ic sandbox doctor` has drawn pending apart from settled for a while (doctor.rs's
             * classify_public). This is the daemon drawing it too, at the one moment it is free to. */
            if (posture.by === "loopback") {
                const detail =
                    `nothing will answer at ${publicUrl}: this sandbox has no reachability — ${posture.reason} — so its daemon dials no edge. ` +
                    `Re-run its setup command from the setup screen, which carries the values it is missing; until then it answers on its own machine only.`;
                logger.warn({ publicUrl, detail }, "sandbox has a public address it cannot serve");
                status = { state: "unreachable", detail, retrying: false, at: Date.now() };
                // retrying: false because a posture refusal never enters the probe loop; there's nothing to retry.
                void tell("unreachable", detail, false);
                return;
            }
            deadline = Date.now() + REACH_GIVE_UP_MS;
            status = { state: "checking", at: Date.now() };
            reportWhenConverged();
            // Says "checking" before the first probe resolves, so the page knows a daemon exists and is testing itself.
            void tell("checking", undefined, true).then(() => attempt());
        },
        stop: () => {
            clearTimeout(timer);
            unsubscribeBoot?.();
            unsubscribeBoot = undefined;
        },
        status: () => status,
    };
};
