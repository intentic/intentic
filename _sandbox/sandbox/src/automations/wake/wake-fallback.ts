import { setTimeout as delay } from "node:timers/promises";
import type { AgentEvent } from "@intentic/sandbox-contract/events/agent-events";
import type { ModelPin } from "@intentic/sandbox-contract/schemas/agent";
import type { LimitPolicy } from "@intentic/sandbox-contract/schemas/turn-break";
import type { Services } from "../../composition.js";
import { opt } from "../../opt.js";
import { failingStreak } from "../../agent/models/role-model-health.js";
import { spentRung } from "../../agent/models/role-model-quota.js";
import type { TurnInput } from "../../seams/turn-starter.js";

/* A WAKE NOBODY WATCHES ANSWERS ITS OWN SPENT ALLOWANCE. An automation's model ladder was walked once, when it fired
   (scheduler.ts wakeModel): a rung refused after that left an ordinary held turn under the sandbox-wide answer, which
   here was to wait for a person's press. On 2026-10-19 three marketing runs sat behind it: one on Cursor's Opus 4.8,
   whose refusal named no reset, with two unspent rungs standing behind it in its own ladder; one on Claude, whose reset
   was three minutes away and still waited an hour for a press. A wake now opens its conversation as a spawned child
   does (child-spec.ts childOpening): a spent allowance goes again at its reset, a stopped turn on the bounded stop
   ladder. And a refusal no near reset answers moves the held turn, whole, onto the next rung of the automation's own
   ladder the records do not call spent. */

// A booked resend this close is waited for rather than moved off: the rung the automation put first is still its pick.
export const WAIT_FOR_RESEND_MS = 15 * 60_000;

// How long a move waits for the refused turn's hold to be filed: the stream ends as the settle is sent, and the
// conversation applies it a beat later.
const HOLD_SETTLE_TRIES = 10;
const HOLD_SETTLE_STEP_MS = 200;

/** What a wake's refusal frame said, as much of it as this needs. */
export type WakeRefusal = Pick<Extract<AgentEvent, { kind: "error" }>, "code" | "autoResume" | "nextAt">;

export const refusalOf = (event: Extract<AgentEvent, { kind: "error" }>): WakeRefusal => ({
    ...opt("code", event.code),
    ...opt("autoResume", event.autoResume),
    ...opt("nextAt", event.nextAt),
});

/**
 * The postures a wake's conversation opens with: where the sandbox waits for a press on a spent allowance, the wake
 * goes again at the reset instead; a sandbox already answering `resend` or `move` is inherited as it stands. A turn
 * that stopped short is carried on, on the stop ladder's bounded tries.
 */
export const wakePostures = (sandboxLimit: LimitPolicy): NonNullable<TurnInput["postures"]> =>
    sandboxLimit === "wait" ? { limit: "resend", stopped: "retry" } : { stopped: "retry" };

/** Whether a refusal is one the ladder answers: a spent allowance with no resend booked, or one booked far off. */
export const movesOnward = (refusal: WakeRefusal | undefined, now: number): boolean =>
    refusal?.code === "rate_limit" &&
    (refusal.autoResume !== "scheduled" || (refusal.nextAt !== undefined && refusal.nextAt * 1000 - now > WAIT_FOR_RESEND_MS));

const samePin = (a: ModelPin, b: ModelPin): boolean => a.provider === b.provider && a.model === b.model && (a.harness ?? "native") === (b.harness ?? "native");

/** The rungs after the one this wake ran on, best first. */
export const laterRungs = (ladder: readonly ModelPin[], ran: ModelPin): readonly ModelPin[] => {
    const at = ladder.findIndex((rung) => samePin(rung, ran));
    return at === -1 ? [] : ladder.slice(at + 1).filter((rung) => !samePin(rung, ran));
};

// The first of them this sandbox can start now: its provider connected, its pool not recorded spent, and not dying turn
// after turn. Unlike a fire's walk, none at all is an answer: every rung behind is spent, so the hold stays as it is.
const openRung = async (services: Services, rungs: readonly ModelPin[]): Promise<ModelPin | undefined> => {
    const ready: Readonly<Record<string, boolean>> = await services.providerReadiness();
    for (const rung of rungs) {
        // An endpoint provider is not in the native table; its rung is tried, and its own refusal says the rest.
        if (ready[rung.provider] === false) {
            continue;
        }
        if ((await spentRung(services, rung)) === undefined && (await failingStreak(services.usage, rung)) === undefined) {
            return rung;
        }
    }
    return undefined;
};

/** Where a refused wake went: the rung it moved to and the run that carries it, or undefined when it stayed held. */
export interface WakeMove {
    readonly rung: ModelPin;
    readonly run: string;
}

/**
 * Moves a wake whose rung was refused onto the next open rung of its ladder: the held turn runs again whole, as a
 * press onto that model would run it. Undefined when the refusal is not the ladder's to answer, no rung behind is open,
 * or the hold was never filed (a turn started there meanwhile).
 */
export const moveWakeOnward = async (
    services: Services,
    wake: { readonly conversationId: string; readonly ladder: readonly ModelPin[]; readonly ran: ModelPin },
    refusal: WakeRefusal | undefined,
    now: number = Date.now(),
): Promise<WakeMove | undefined> => {
    if (!movesOnward(refusal, now)) {
        return undefined;
    }
    const rung = await openRung(services, laterRungs(wake.ladder, wake.ran));
    if (rung === undefined) {
        return undefined;
    }
    for (let attempt = 0; attempt < HOLD_SETTLE_TRIES; attempt += 1) {
        const held = services.conversations.state(wake.conversationId)?.resume.held;
        if (held?.reason === "limit") {
            const run = await services.turns.resume(wake.conversationId, {
                agent: rung.provider,
                harness: rung.harness ?? "native",
                model: rung.model,
                ...opt("effort", rung.effort),
            });
            return run === undefined ? undefined : { rung, run: run.id };
        }
        await delay(HOLD_SETTLE_STEP_MS);
    }
    services.logger.warn({ conversationId: wake.conversationId }, "automation wake: refused, but no hold was filed to move onward");
    return undefined;
};

// When a booked resend goes, as the run's detail says it.
const clock = (epochSeconds: number): string => new Date(epochSeconds * 1000).toISOString().slice(11, 16);

/** How a wake's turn ended, as its automation's run records it, and whether that counts toward quarantine. */
export interface WakeEnding {
    readonly run: { readonly outcome: "completed" } | { readonly outcome: "error"; readonly detail: string };
    // A failure the sandbox is not carrying on by itself: only these count toward disabling the automation.
    readonly failed: boolean;
}

/**
 * Settles a wake's ending: a clean one completed; a refusal its ladder answers moved onto the next open rung; one a
 * booked resend answers left to go at its reset. Each of the last two names what happens next in the run's detail and
 * does not count as a failure, since the work is still under way.
 */
export const wakeEnding = async (
    services: Services,
    wake: { readonly conversationId: string; readonly ladder: readonly ModelPin[] | undefined; readonly ran: ModelPin },
    failure: string | undefined,
    refusal: WakeRefusal | undefined,
): Promise<WakeEnding> => {
    if (failure === undefined) {
        return { run: { outcome: "completed" }, failed: false };
    }
    const moved = await moveWakeOnward(services, { ...wake, ladder: wake.ladder ?? [] }, refusal);
    if (moved !== undefined) {
        return { run: { outcome: "error", detail: `${failure} Moved on to ${moved.rung.provider}/${moved.rung.model} (run ${moved.run}).` }, failed: false };
    }
    if (refusal?.autoResume === "scheduled") {
        const when = refusal.nextAt === undefined ? "once the allowance reopens" : `at ${clock(refusal.nextAt)} UTC`;
        return { run: { outcome: "error", detail: `${failure} Goes again ${when}.` }, failed: false };
    }
    return { run: { outcome: "error", detail: failure }, failed: true };
};
