import { request } from "node:https";
import type { Logger } from "pino";
import type { Config } from "../env.config.js";

/* The daemon's boot-time registration. ONCE, on start, it tells the platform where this sandbox lives (its
 * public URL); the platform records daemonUrl + lastSeenAt and the setup wizard watches for that stamp to
 * advance — the browser never resolves the sandbox hostname during setup, so a not-yet-propagated DNS record
 * can't wedge onboarding. It is NOT a heartbeat: once the platform acknowledges, the daemon goes silent
 * (post-setup liveness is the browser's own SSE probe, which the platform isn't part of). So platform traffic
 * is proportional to boot events, not to sandbox count × a constant tick. Authenticated by possession of the
 * connect token (x-intentic-connect), the same secret the daemon's own first-bind gate uses. */

// Retry the boot register until the platform acks, backing off 2s → 4s → … capped here. Only failures wait
// this long; a success stops the loop immediately.
const MAX_BACKOFF_MS = 30_000;
// Give up after this long unacked: a daemon that can't reach the platform in 10 min won't later, and a restart
// re-arms the whole thing. Keeps a permanently-isolated sandbox from polling forever.
// ponytail: bounded boot retry; restart re-registers if it ever does come back.
const GIVE_UP_MS = 10 * 60_000;

// Hosts whose TLS is a local self-signed dev cert — the only places certificate verification is skipped
// (mirrors connect.sh's `curl -k` gate for localhost platforms). Everything else verifies normally.
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "host.docker.internal"]);

/* Where registration stands, as /health reports it. This is the one link of the setup chain nothing outside
 * the container can probe — the browser can reach the daemon and the platform but cannot see whether the
 * daemon reached the platform — so a failed announce used to surface only as a wizard that never advanced.
 * ic's connect postflight and `ic sandbox doctor` read this block (docker exec + curl, no tunnel in the
 * loop) and name the link when it is the broken one. */
export interface AnnounceState {
    // "off" — headless, nothing to register with; "pending" — attempting, no verdict yet; "registered" —
    // the platform acked; "rejected" — the platform answered no (a daemonUrl the registry won't accept);
    // "unreachable" — the platform could not be reached from inside the container.
    readonly state: "off" | "pending" | "registered" | "rejected" | "unreachable";
    // Why, for the failing states — already in the user's terms.
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
    const body = JSON.stringify({ daemonUrl: config.sandbox.publicUrl });

    // Schedule the next attempt unless we've spent the give-up window; either way `status` keeps the last
    // failure's why, so /health names the problem even after the retries stop.
    const retry = (): void => {
        if (Date.now() >= deadline) {
            logger.warn("platform registration gave up — restart to retry");
            status = { ...status, retrying: false };
            return;
        }
        timer = setTimeout(attempt, backoff);
        backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
    };

    // node:https instead of fetch: undici can't skip TLS verification per-request, and the process-global
    // escape hatch would also disable it for Google/Anthropic/OpenAI calls.
    const attempt = (): void => {
        // Built here, not at creation: an unset PLATFORM_URL (headless run — start() is never called) must not
        // throw while composing the daemon.
        const url = new URL("/sandbox/announce", config.platform.url);
        const register = request(
            url,
            {
                method: "POST",
                headers: { "content-type": "application/json", "x-intentic-connect": config.connectToken },
                rejectUnauthorized: !LOCAL_HOSTS.has(url.hostname),
            },
            (response) => {
                response.resume();
                if (response.statusCode === 200) {
                    logger.info("registered with the platform");
                    status = { state: "registered", at: Date.now() };
                    return; // acked — go silent, no reschedule
                }
                logger.warn({ status: response.statusCode }, "platform registration rejected");
                status = {
                    state: "rejected",
                    detail: `the platform answered HTTP ${response.statusCode} to this sandbox's registration`,
                    retrying: true,
                    at: Date.now(),
                };
                retry();
            },
        );
        register.on("error", (error: unknown) => {
            logger.warn({ err: error }, "platform registration failed");
            status = {
                state: "unreachable",
                detail: `the platform could not be reached from inside the sandbox: ${error instanceof Error ? error.message : String(error)}`,
                retrying: true,
                at: Date.now(),
            };
            retry();
        });
        register.end(body);
    };

    return {
        start: () => {
            deadline = Date.now() + GIVE_UP_MS;
            status = { state: "pending", at: Date.now() };
            attempt(); // the setup wizard is usually watching right now
        },
        stop: () => clearTimeout(timer),
        status: () => status,
    };
};
