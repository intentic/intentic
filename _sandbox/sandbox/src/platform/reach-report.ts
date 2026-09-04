import type { Logger } from "pino";
import { sandboxIdFromToken } from "@intentic/sandbox-contract/tunnel-ids";
import type { Config } from "../env.config.js";
import type { BootTracker } from "./boot.js";
import { readCpuThrottle } from "./cpu-throttle.js";
import { postToPlatform } from "./platform-post.js";

/* CAN ANYBODY ACTUALLY REACH THIS SANDBOX, the question the announce next door does not answer and was read
 * as answering, at a cost measured in stranded users.
 *
 * The announce says "the daemon started". The setup wizard took that for "the sandbox is usable" and handed
 * people into a workspace on the strength of it. Those came apart during the tunnel migration: the daemon
 * booted and registered exactly as designed while its public name served nobody, so the registry showed a
 * healthy sandbox, the wizard handed over, and the person met a spinner with no reason attached to it. Every
 * link of that chain was individually fine; the missing one was never checked by anyone.
 *
 * Nobody else CAN check it. The platform never dials a sandbox (that is the whole trust model, a breach
 * cannot reach into a box), the browser was deliberately kept off the hostname during setup, and the tunnel
 * agent's own opinion of itself is not evidence. What is left is the box asking its own PUBLIC address
 * whether it answers, out through the hub and back in, which is the same round trip a browser makes and is
 * therefore the only probe that proves the thing users care about.
 *
 * The verdict goes to the platform over the connect token, on the daemon's outbound channel and pointedly not
 * through the tunnel, so the report still arrives when the tunnel is exactly what is broken. */

// The probe reaches its own public name, so the answer's `sandboxId` must be OURS: a name that resolves to
// somebody else's box, or to a proxy's cheerful default page, is not reachability. Matching the id is what
// makes this a proof rather than a ping.
interface HealthAnswer {
    readonly sandboxId?: unknown;
}

// One probe may not hang around: this runs on a loop, and an address that accepts connections and never
// answers (a tunnel with nothing bound behind it) would otherwise stall the whole report.
const PROBE_TIMEOUT_MS = 10_000;
// Retry while unreachable, backing off 3s → 6s → … to here. The share the entrypoint binds can take a few
// seconds to come up on a cold box, so the first answers are EXPECTED to be no.
const MAX_BACKOFF_MS = 30_000;
/* Stop after this long. Not a guess, it is how long the wizard is willing to hold somebody on the setup page
 * before it stops promising the sandbox is coming, and the two must agree or the page would wait on a report
 * that stopped being written. A restart re-arms the whole thing. */
const REACH_GIVE_UP_MS = 5 * 60_000;

// Where reachability stands, in the same shape (and for the same readers) as the announce block beside it:
// /health carries both, so `ic sandbox doctor` and the connect postflight can name whichever link is broken
// without a tunnel in the loop, which matters most precisely when it is this link.
export interface ReachState {
    // "off", nothing to probe (headless, loopback dev, no public address); "checking", no verdict yet;
    // "reachable", its own public address answered, with our id on it; "unreachable", it did not.
    readonly state: "off" | "checking" | "reachable" | "unreachable";
    // Why, for "unreachable", already in the user's terms, because the wizard renders it verbatim.
    readonly detail?: string;
    // False once the give-up window is spent and only a restart retries.
    readonly retrying?: boolean;
    readonly at?: number;
}

export interface ReachReporter {
    readonly start: () => void;
    readonly stop: () => void;
    readonly status: () => ReachState;
}

/* One round trip to our own public address. Deliberately plain `fetch`: this goes out to the real internet
 * and comes back through the hub, so it must verify TLS like any browser would, the platform's local-dev
 * escape hatch has no business on this path.
 *
 * Every failure is worded for the person reading the setup page, because that is where it lands. */
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
    // A 200 from something that is not us is the worst of the failures to leave unnamed: everything looks
    // healthy and the traffic goes somewhere else entirely.
    if (expectedId !== undefined && typeof body?.sandboxId === "string" && body.sandboxId !== expectedId) {
        return { ok: false, detail: `${publicUrl} is answering for a different sandbox, this address is not (or not yet) ours.` };
    }
    return { ok: true };
};

/* `bootOf` is the boot tracker, fetched at call time because the reporter is composed in the same literal the
 * tracker is (composition.ts). Two things ride the report because of it: where the chain stands, so the
 * setup wait can hold and narrate one wait instead of handing over to a second card; and the machine's CPU
 * throttling so far (cpu-throttle.ts), so a slow first boot can be read against the host's quota. Both are
 * optional on the wire and absent from a daemon older than this. */
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

    // Telling the platform is best-effort by construction: this is narration for a screen, and a platform that
    // cannot be reached right now is the announce's problem to report, not this one's to duplicate.
    const tell = async (reach: ReachState["state"], detail?: string): Promise<void> => {
        if (reach === "off") {
            return;
        }
        const boot = bootSnapshot();
        const cpu = readCpuThrottle();
        const answer = await postToPlatform(config, "/sandbox/boot-report", {
            reach,
            ...(detail === undefined ? {} : { detail }),
            ...(boot === undefined ? {} : { boot }),
            ...(cpu === undefined ? {} : { cpu }),
        });
        if ("error" in answer) {
            logger.debug({ err: answer.error }, "reachability report could not be delivered");
        }
    };

    /* The chain converging is its own event to report: the reach verdict may have landed minutes earlier, and
     * a wait holding on `boot.ready` would otherwise learn it only from the next unrelated post, which is never.
     * One re-post of whatever the verdict currently is, then the subscription is spent. */
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
            void tell(status.state, status.detail);
        });
    };

    const attempt = async (): Promise<void> => {
        const verdict = await probeSelf(publicUrl, expectedId);
        if (verdict.ok) {
            logger.info({ publicUrl }, "sandbox is reachable at its public address");
            status = { state: "reachable", at: Date.now() };
            await tell("reachable");
            return; // proved: go quiet, exactly like the announce does on its ack
        }
        const spent = Date.now() >= deadline;
        logger.warn({ publicUrl, detail: verdict.detail }, "sandbox is not reachable at its public address yet");
        status = { state: "unreachable", detail: verdict.detail, retrying: !spent, at: Date.now() };
        await tell("unreachable", verdict.detail);
        if (spent) {
            return;
        }
        timer = setTimeout(() => void attempt(), backoff);
        backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
    };

    return {
        start: () => {
            deadline = Date.now() + REACH_GIVE_UP_MS;
            status = { state: "checking", at: Date.now() };
            reportWhenConverged();
            /* Say "checking" BEFORE the first probe resolves. That first word is the whole difference between
             * a wait that is silent and one that has started: it tells the page a daemon exists and is testing
             * itself, which is already more than the spinner it replaces ever managed to say. */
            void tell("checking").then(() => attempt());
        },
        stop: () => {
            clearTimeout(timer);
            unsubscribeBoot?.();
            unsubscribeBoot = undefined;
        },
        status: () => status,
    };
};
