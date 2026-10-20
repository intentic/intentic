import type { ProviderRefusal } from "@intentic/sandbox-contract/schemas/providers/plan-limits";
import { pino } from "pino";
import { memoryProviderRefusalStore, type ProviderRefusalStore } from "../../../usage/provider-refusals.js";
import { type ClaudeSeatCheck, createClaudeSeatCheck, type SeatProbe } from "./claude-seat-check.js";
import type { ClaudeSeatStore, SeatRefusal } from "./claude-seats.js";

// The seat check as suites stand it up: the real schedule over in-memory marks, with the provider's answer scripted.
// Not part of the build.

/** A seat store over a record the test holds and reads back: refuse and clear write into it. */
export const memorySeats = (seats: Record<string, SeatRefusal>): ClaudeSeatStore => ({
    read: async () => ({ ...seats }),
    refuse: async (id, reason) => {
        seats[id] ??= { at: Date.now(), reason };
    },
    clear: async (id) => {
        delete seats[id];
    },
});

/** The real refusal ledger, held in memory, seeded with what each provider has on file: no stand-in to drift. */
export const seededRefusals = (refusals: Record<string, readonly ProviderRefusal[]> = {}): ProviderRefusalStore => memoryProviderRefusalStore(refusals);

export interface ScriptedSeatCheck {
    readonly check: ClaudeSeatCheck;
    // Every account the provider was actually asked about, in order.
    readonly probes: string[];
}

/**
 * The real seat check over `seats`, whose provider answers with `answer` (changed between calls to play an admin turning
 * access back on). `probes` lists every account actually asked, in order.
 */
export const scriptedSeatCheck = (options: {
    readonly seats: ClaudeSeatStore;
    readonly answer: (id: string) => SeatProbe;
    readonly refusals?: ProviderRefusalStore;
    readonly now?: () => number;
}): ScriptedSeatCheck => {
    const probes: string[] = [];
    const refusals = options.refusals ?? seededRefusals();
    const check = createClaudeSeatCheck({
        seats: options.seats,
        refusals: () => refusals,
        probe: async (id) => {
            probes.push(id);
            return options.answer(id);
        },
        logger: pino({ level: "silent" }),
        now: options.now ?? Date.now,
    });
    return { check, probes };
};

export const STILL_OFF: SeatProbe = { kind: "refused", reason: "Your organization has disabled Claude subscription access for Claude Code." };
export const BACK_ON: SeatProbe = { kind: "entitled" };
