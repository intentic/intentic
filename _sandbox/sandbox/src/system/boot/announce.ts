import { errorMessage } from "@intentic/base/errors";
import type { AnnounceState, RelinkAnswer } from "@intentic/sandbox-contract";
import type { Logger } from "pino";
import { z } from "zod";
import type { Config } from "../../env.config.js";
import { version } from "../../version.js";
import { exchangeWithPlatform } from "../platform-client.js";

// Registration with the platform: tells it this sandbox's public URL at boot, then goes silent once acked (liveness after
// that is the browser's own SSE probe). Authenticated by the connect token, the same secret the daemon's first-bind
// gate uses. Doesn't claim reachability: that's reach-report.ts's fact, next door.
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
// A platform that accepts the connection and never answers must not stall the loop: this cuts a quiet socket.
const PLATFORM_IDLE_MS = 60_000;
// After the fast window, a still-failing registration is logged this often rather than on every attempt.
const QUIET_LOG_MS = 30 * 60_000;

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

// The platform's answer, in the owner's terms; the identity rides a 200 from a platform new enough to send it.
const verdictOf = (answer: { status: number; body: string }, at: number): AnnounceState => {
    if (answer.status === 200) {
        return { state: "registered", at, ...identityOf(answer.body) };
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

// A 200's body as a platform new enough to say which database took the registration sends it.
const AcceptedSchema = z.object({ identity: z.string().min(1) });

const identityOf = (body: string): Pick<AnnounceState, "identity"> => {
    try {
        const accepted = AcceptedSchema.safeParse(JSON.parse(body));
        return accepted.success ? { identity: accepted.data.identity } : {};
    } catch {
        // allow(silent-catch): an older platform answers a bare ok, which carries no identity.
        return {};
    }
};

export const createAnnouncer = (config: Config, logger: Logger): Announcer => {
    let timer: NodeJS.Timeout | undefined;
    let fastUntil = 0;
    let backoff = 2_000;
    let lastLoggedAt = 0;
    let status: AnnounceState = { state: "off" };
    let inFlight: Promise<AnnounceState> | undefined;
    const headers = { "x-intentic-connect": config.connectToken };

    const post = (path: string, payload: string) => exchangeWithPlatform(config, { method: "POST", path, headers, payload, idleMs: PLATFORM_IDLE_MS });

    // One registration at a time: a Reconnect pressed mid-attempt shares the attempt rather than racing it.
    const register = (): Promise<AnnounceState> => {
        inFlight ??= post("/sandbox/announce", JSON.stringify({ daemonUrl: config.sandbox.publicUrl, version }))
            .then(
                (answer) => verdictOf(answer, Date.now()),
                (error: Error): AnnounceState => ({
                    state: "unreachable",
                    detail: `the platform could not be reached from inside the sandbox: ${errorMessage(error)}`,
                    retrying: true,
                    at: Date.now(),
                }),
            )
            .finally(() => {
                inFlight = undefined;
            });
        return inFlight;
    };

    // Every attempt while fast, then once per quiet window, so a sandbox the platform forgot doesn't fill its log.
    const report = (next: AnnounceState): void => {
        if (next.state === "registered") {
            logger.info({ identity: next.identity }, "registered with the platform");
            return;
        }
        const now = Date.now();
        if (now < fastUntil || now - lastLoggedAt >= QUIET_LOG_MS || next.retrying === false) {
            lastLoggedAt = now;
            const message = next.state === "unreachable" ? "platform registration failed" : "platform registration rejected";
            logger.warn({ detail: next.detail, reason: next.reason, retrying: next.retrying }, message);
        }
    };

    const schedule = (): void => {
        clearTimeout(timer);
        timer = setTimeout(() => void cycle(), backoff);
        backoff = Math.min(backoff * 2, Date.now() < fastUntil ? FAST_CAP_MS : SLOW_CAP_MS);
    };

    const settle = (next: AnnounceState): AnnounceState => {
        status = next;
        report(next);
        if (next.state !== "registered" && next.retrying !== false) {
            schedule();
        }
        return next;
    };

    const cycle = async (): Promise<void> => {
        settle(await register());
    };

    // The platform's answer to an adoption: its status and reason, or 0 when it could not be reached.
    const adopt = async (adoption: Adoption): Promise<{ status: number; detail: string }> => {
        try {
            const answer = await post(
                "/sandbox/adopt",
                JSON.stringify({
                    ticket: adoption.ticket,
                    grant: config.sandbox.grant,
                    daemonUrl: config.sandbox.publicUrl,
                    owner: adoption.owner,
                    version,
                    ...adoptionPresentation(adoption),
                }),
            );
            return { status: answer.status, detail: answer.status === 200 ? "adopted" : answer.body.replace(/^error: /, "").slice(0, 300) };
        } catch (error) {
            return { status: 0, detail: `the platform could not be reached from inside the sandbox: ${errorMessage(error)}` };
        }
    };

    return {
        start: () => {
            fastUntil = Date.now() + FAST_WINDOW_MS;
            status = { state: "pending", at: Date.now() };
            void cycle(); // the setup wizard is usually watching right now
        },
        stop: () => clearTimeout(timer),
        status: () => status,
        relink: async (adoption) => {
            if (status.state === "off") {
                return { announce: status };
            }
            // Someone is watching again: retries go back to fast, starting from the shortest wait.
            clearTimeout(timer);
            fastUntil = Date.now() + FAST_WINDOW_MS;
            backoff = 2_000;
            const first = await register();
            if (first.reason !== "unknown" || adoption === undefined) {
                return { announce: settle(first) };
            }
            const adopted = await adopt(adoption);
            logger.info({ status: adopted.status, detail: adopted.detail }, "platform adoption answered");
            return { announce: settle(adopted.status === 200 ? await register() : first), adoption: adopted };
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
