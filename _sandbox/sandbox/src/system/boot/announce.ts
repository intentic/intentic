import { randomUUID } from "node:crypto";
import { Latest, SingleFlight, sleep } from "@intentic/base/async";
import { errorMessage } from "@intentic/base/errors";
import type { AnnounceBody, IngressOutput } from "@intentic/api-contract/ingress";
import type { AnnounceState, RelinkAnswer } from "@intentic/sandbox-contract";
import { INSTANCE_ENV } from "@intentic/sandbox-contract/netd-wire";
import type { Logger } from "pino";
import type { Config } from "../../env.config.js";
import { version } from "../../version.js";
import { callIngress, type IngressAnswer } from "../platform-client.js";

// Registration with the platform: tells it this sandbox's public URL at boot, then again every hour while it runs, as its
// heartbeat (the browser's own SSE probe is still what says it is reachable). Authenticated by the connect token, the
// same secret the daemon's first-bind gate uses. Doesn't claim reachability: that's reach-report.ts's fact, next door.
//
// (2026-10-05) It went silent once acked, so the platform's `lastSeenAt` was the registration and a sandbox stopped a
// month ago read the same as one up for a month. Each announce also names which copy of the sandbox this is
// (`instance`, minted once per container start, with the machine's name and side), so the platform can tell two
// containers on one token from one that restarted (api announce-copies.ts).
//
// It never gives up (2026-10-02). A platform that is down, or that answers from a database that forgot this sandbox (a
// restore, a wrong DATABASE_URL), comes back on its own time, so the daemon keeps asking: every few seconds while
// someone is likely watching setup, every few minutes after. Only a deletion record (410) ends it, since deleting is
// how an owner says they are done. Rejected: the ten-minute give-up this replaced, whose "restart to retry" was a step
// nobody knew to take while the platform said the sandbox did not exist.

// Fast retries for the first ten minutes after a start or a Reconnect, slow ones after; a success stops the loop.
const FAST_CAP_MS = 30_000;
const SLOW_CAP_MS = 5 * 60_000;
const FAST_WINDOW_MS = 10 * 60_000;
// After the fast window, a still-failing registration is logged this often rather than on every attempt.
const QUIET_LOG_MS = 30 * 60_000;
// Registered, the same announce goes again about this often: cheap (one small POST, one row update), and frequent
// enough that a sandbox gone quiet for a day reads as stopped. Jittered by a tenth either way, so a fleet that started
// together (a release, a power cut) does not announce in one burst forever after.
export const HEARTBEAT_MS = 60 * 60_000;
const heartbeatDelay = (): number => Math.round(HEARTBEAT_MS * (0.9 + Math.random() * 0.2));

/* WHICH COPY OF THIS SANDBOX IS SPEAKING. netd sets INSTANCE_ENV once per container start when it can, so a
 * daemon restarted inside one container stays the same copy; without it, this process's own id, minted once at boot and
 * kept for its life. Either way a second container holding the same token is a different instance. */
const PROCESS_INSTANCE = randomUUID();
const instanceId = (): string => {
    const set = process.env[INSTANCE_ENV]?.trim() ?? "";
    return set === "" ? PROCESS_INSTANCE : set.slice(0, 80);
};

// What the announce says about where this copy runs: the machine's own name (HOST_LABEL, which `ic` sets from the host),
// its side (HOST_ENV, a WSL distro's name where netd sets it, else HOST_PLATFORM), and the container engine under it
// (HOST_ENGINE, which `ic` stamps on every container it makes). Each left out when unset.
export const whereThisRuns = (config: Config, env: NodeJS.ProcessEnv = process.env): { host?: string; os?: string; engine?: string } => {
    const host = (config.hostLabel ?? "").trim();
    const os = (env["HOST_ENV"] ?? "").trim() || (config.hostPlatform ?? "").trim();
    const engine = (env["HOST_ENGINE"] ?? "").trim();
    return {
        ...(host === "" ? {} : { host: host.slice(0, 120) }),
        ...(os === "" ? {} : { os: os.slice(0, 40) }),
        ...(engine === "" ? {} : { engine: engine.slice(0, 40) }),
    };
};

// What the owner's Reconnect carries when the platform may need to adopt this sandbox (POST /platform/relink).
export interface Adoption {
    readonly ticket: string;
    // The owner this daemon bound; the platform makes them the row's owner, so it checks they asked.
    readonly owner: string;
    // What the owner's browser remembers of the sandbox's name and logo, which only the platform held.
    readonly name: string | undefined;
    readonly image: string | undefined;
}

export interface Announcer {
    readonly start: () => void;
    readonly stop: () => void;
    readonly status: () => AnnounceState;
    // Registers now, the owner having asked. With an adoption, a platform with no record of this sandbox (404) is
    // asked to make one first and then registered with again. Resolves with where the link ends up.
    readonly relink: (adoption?: Adoption) => Promise<RelinkAnswer>;
}

// The platform's answer, in the owner's terms; the identity rides a 200 from a platform new enough to send it, and a
// 200 whose body says nothing more (an older platform's) is a registration all the same.
const verdictOf = (answer: IngressAnswer<IngressOutput<"announce">>, at: number): AnnounceState => {
    if (answer.status === 200) {
        const identity = answer.data?.identity;
        return { state: "registered", at, ...(identity === undefined ? {} : { identity }) };
    }
    if (answer.status === 410) {
        return {
            state: "rejected",
            reason: "deleted",
            retrying: false,
            detail: "the platform says this sandbox was deleted: restore it from the trash in the app, or set up a new one",
            at,
        };
    }
    if (answer.status === 404) {
        return {
            state: "rejected",
            reason: "unknown",
            retrying: true,
            detail: "the platform has no record of this sandbox: if it lost track of it, open the app and press Reconnect",
            at,
        };
    }
    return { state: "rejected", retrying: true, detail: `the platform answered HTTP ${answer.status} to this sandbox's registration`, at };
};

export const createAnnouncer = (config: Config, logger: Logger): Announcer => {
    let fastUntil = 0;
    let backoff = 2_000;
    let lastLoggedAt = 0;
    let status: AnnounceState = { state: "off" };
    // From start() to stop(). A stop aborts it, which cuts the registration in flight and ends whatever wait is
    // pending, so nothing is announced or scheduled after one.
    const running = new Latest();
    // Whose verdict decides the next announce: the loop's, until a Reconnect takes the turn with an announce of its
    // own. Taking it ends the loop's wait, which that announce makes moot, and a loop caught mid-announce shares the
    // Reconnect's answer without acting on it a second time.
    const turn = new Latest();
    // One registration at a time: a Reconnect pressed mid-attempt shares the attempt rather than racing it.
    const flight = new SingleFlight<"announce", AnnounceState>();
    // The same body on every announce, the heartbeat's included: fixed for this process's life.
    const announceBody: AnnounceBody = { daemonUrl: config.sandbox.publicUrl, version, instance: instanceId(), ...whereThisRuns(config) };

    const register = (signal: AbortSignal): Promise<AnnounceState> =>
        flight.run("announce", () =>
            callIngress(config, { route: "announce", input: announceBody, signal }).then(
                (answer) => verdictOf(answer, Date.now()),
                (error: Error): AnnounceState => ({
                    state: "unreachable",
                    detail: `the platform could not be reached from inside the sandbox: ${errorMessage(error)}`,
                    retrying: true,
                    at: Date.now(),
                }),
            ),
        );

    // Every attempt while fast, then once per quiet window, so a sandbox the platform forgot doesn't fill its log. A
    // heartbeat that lands is logged only when it is news: the first registration, or one after a failure.
    const report = (next: AnnounceState, before: AnnounceState): void => {
        if (next.state === "registered") {
            if (before.state !== "registered" || before.identity !== next.identity) {
                logger.info({ identity: next.identity }, "registered with the platform");
            }
            return;
        }
        const now = Date.now();
        if (now < fastUntil || now - lastLoggedAt >= QUIET_LOG_MS || next.retrying === false) {
            lastLoggedAt = now;
            const message = next.state === "unreachable" ? "platform registration failed" : "platform registration rejected";
            logger.warn({ detail: next.detail, reason: next.reason, retrying: next.retrying }, message);
        }
    };

    // The wait before the next announce: an hour on (the heartbeat) once registered, the backoff while it is not, and
    // none at all after a deletion record. A heartbeat the platform does not answer, or answers 404 (it forgot this
    // sandbox), goes back to retrying from the shortest wait; a 410 is final here as anywhere.
    const gapAfter = (next: AnnounceState): number | undefined => {
        if (next.state === "registered") {
            backoff = 2_000;
            return heartbeatDelay();
        }
        if (next.retrying === false) {
            return undefined;
        }
        const gap = backoff;
        backoff = Math.min(backoff * 2, Date.now() < fastUntil ? FAST_CAP_MS : SLOW_CAP_MS);
        return gap;
    };

    // Records a verdict reached while `mine` holds the turn and waits out the gap it calls for on that same signal, so
    // a stop or a Reconnect ends the wait rather than leaving it to fire. One reached after either is theirs to act on.
    const settle = (next: AnnounceState, run: AbortSignal, mine: AbortSignal): AnnounceState => {
        if (mine.aborted) {
            return next;
        }
        const before = status;
        status = next;
        report(next, before);
        const gap = gapAfter(next);
        if (gap !== undefined) {
            void sleep(gap, { signal: mine }).then(() => cycle(run, mine));
        }
        return next;
    };

    const cycle = async (run: AbortSignal, mine: AbortSignal): Promise<void> => {
        if (!mine.aborted) {
            settle(await register(run), run, mine);
        }
    };

    // The platform's answer to an adoption: its status and reason, or 0 when it could not be reached.
    const adopt = async (adoption: Adoption, signal: AbortSignal): Promise<{ status: number; detail: string }> => {
        try {
            const answer = await callIngress(config, {
                route: "adopt",
                input: {
                    ticket: adoption.ticket,
                    grant: config.sandbox.grant,
                    daemonUrl: config.sandbox.publicUrl,
                    owner: adoption.owner,
                    version,
                    ...adoptionPresentation(adoption),
                },
                signal,
            });
            return { status: answer.status, detail: answer.status === 200 ? "adopted" : (answer.refusal ?? "").slice(0, 300) };
        } catch (error) {
            return { status: 0, detail: `the platform could not be reached from inside the sandbox: ${errorMessage(error)}` };
        }
    };

    return {
        start: () => {
            const run = running.next();
            fastUntil = Date.now() + FAST_WINDOW_MS;
            status = { state: "pending", at: Date.now() };
            void cycle(run, turn.next(run)); // the setup wizard is usually watching right now
        },
        stop: () => running.abort(),
        status: () => status,
        relink: async (adoption) => {
            // Never started (a headless run, nothing to register with) or stopped: a Reconnect starts nothing again.
            const run = running.current;
            if (run === undefined) {
                return { announce: status };
            }
            // Someone is watching again: retries go back to fast, starting from the shortest wait.
            const mine = turn.next(run);
            fastUntil = Date.now() + FAST_WINDOW_MS;
            backoff = 2_000;
            const first = await register(run);
            if (first.reason !== "unknown" || adoption === undefined) {
                return { announce: settle(first, run, mine) };
            }
            const adopted = await adopt(adoption, run);
            logger.info({ status: adopted.status, detail: adopted.detail }, "platform adoption answered");
            return { announce: settle(adopted.status === 200 ? await register(run) : first, run, mine), adoption: adopted };
        },
    };
};

// What the owner's browser remembers of the sandbox, sent only when it remembers something.
interface Presentation {
    name?: string;
    image?: string;
}

const adoptionPresentation = (adoption: Adoption): Presentation => {
    const presentation: Presentation = {};
    if (adoption.name !== undefined && adoption.name !== "") {
        presentation.name = adoption.name;
    }
    if (adoption.image !== undefined && adoption.image !== "") {
        presentation.image = adoption.image;
    }
    return presentation;
};
