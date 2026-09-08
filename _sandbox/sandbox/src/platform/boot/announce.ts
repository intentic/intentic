import type { Logger } from "pino";
import type { Config } from "../../env.config.js";
import { postToPlatform } from "../platform-post.js";

// One-time boot registration: tells the platform this sandbox's public URL, then goes silent once acked (liveness after
// that is the browser's own SSE probe). Authenticated by the connect token, the same secret the daemon's first-bind
// gate uses. Doesn't claim reachability: that's reach-report.ts's fact, next door.

// Backoff cap for retrying until the platform acks (2s → 4s → …); a success stops the loop immediately.
const MAX_BACKOFF_MS = 30_000;
// Gives up after this long unacked, so an isolated sandbox doesn't poll forever; a restart re-arms it.
const GIVE_UP_MS = 10 * 60_000;

// Registration status, as /health reports it: the one link in the setup chain nothing outside the container can probe.
// `ic sandbox doctor` and the connect postflight read this to name the link when it's the broken one.
export interface AnnounceState {
    // - off: nothing to register with yet
    // - pending: attempting, no verdict yet
    // - registered: the platform acked
    // - rejected: the platform answered no
    // - unreachable: could not reach the platform
    readonly state: "off" | "pending" | "registered" | "rejected" | "unreachable";
    // Why, for the failing states, already in the user's terms.
    readonly detail?: string;
    // On a failing state: false once the 10-minute window is spent and only a restart retries.
    readonly retrying?: boolean;
    // When this state was last confirmed, ms since epoch.
    readonly at?: number;
}

export interface Announcer {
    readonly start: () => void;
    readonly stop: () => void;
    readonly status: () => AnnounceState;
}

export const createAnnouncer = (config: Config, logger: Logger): Announcer => {
    let timer: NodeJS.Timeout | undefined;
    let deadline = 0;
    let backoff = 2_000;
    let status: AnnounceState = { state: "off" };

    // Schedules the next attempt unless the give-up window is spent; `status` keeps the last failure's why either way.
    const retry = (): void => {
        if (Date.now() >= deadline) {
            logger.warn("platform registration gave up: restart to retry");
            status = { ...status, retrying: false };
            return;
        }
        timer = setTimeout(() => void attempt(), backoff);
        backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
    };

    const attempt = async (): Promise<void> => {
        const answer = await postToPlatform(config, "/sandbox/announce", { daemonUrl: config.sandbox.publicUrl });
        if ("error" in answer) {
            logger.warn({ err: answer.error }, "platform registration failed");
            status = {
                state: "unreachable",
                detail: `the platform could not be reached from inside the sandbox: ${answer.error}`,
                retrying: true,
                at: Date.now(),
            };
            retry();
            return;
        }
        if (answer.status === 200) {
            logger.info("registered with the platform");
            status = { state: "registered", at: Date.now() };
            return; // acked: go silent, no reschedule
        }
        logger.warn({ status: answer.status }, "platform registration rejected");
        status = {
            state: "rejected",
            detail: `the platform answered HTTP ${answer.status} to this sandbox's registration`,
            retrying: true,
            at: Date.now(),
        };
        retry();
    };

    return {
        start: () => {
            deadline = Date.now() + GIVE_UP_MS;
            status = { state: "pending", at: Date.now() };
            void attempt(); // the setup wizard is usually watching right now
        },
        stop: () => clearTimeout(timer),
        status: () => status,
    };
};
