import { z } from "zod";
import { FLAPPING_WINDOW_MS, flappingAccounts, type SwitchOffs } from "@intentic/sandbox-contract/models/plan-pools";
import { defineDocument } from "../store/evolution/documents.js";
import { openDocument } from "../store/open-document.js";

/* WHEN EACH ACCOUNT WAS SWITCHED OFF THIS WEEK, at <historyRoot>/entitlement-refusals.json, beside the ledger that feeds
   it (provider-refusals.ts). The ledger keeps only the latest refusal of each scope, believes an entitlement refusal for
   a day, and forgets it the moment a turn on the account is answered. Each time such an account serves again it reads as
   healthy, with the most room, and a pick lands on it. Claude account d8561075…'s organisation switched Claude Code off
   at 2026-10-27 08:44, let it serve from 21:17 to 00:39, and switched it off again at 10-28 08:48.

   An instant here is a switch-off: an entitlement refusal filed for the account while none stood over it. Another one
   filed while one stands (the next refused turn, a probe re-testing the seat) is the same switch-off. An account with
   two in a week is flapping, and a pick ranks it behind every steady account of its tier (plan-pools.ts
   preferredAccount), even once it serves again. The rule is the contract's (plan-pools.ts flappingAccounts) and the
   instants ride the refusals feed, so every window ranks the accounts as the daemon's pick does. */

export const entitlementRefusalsDocument = defineDocument({
    root: "history",
    path: "entitlement-refusals.json",
    // Describes the account's organisation, not the machine that saw it, so it travels with the ledger.
    portability: "carry",
    // Epoch ms of each switch-off within the week, oldest first, keyed `${provider}:${account}`.
    schema: z.array(z.number()),
    granularity: "record",
});

export interface EntitlementHistory {
    // Notes that the account was switched off at `at`; forgets every switch-off older than a week as it writes.
    readonly switchedOff: (provider: string, account: string, at: number) => Promise<void>;
    // The provider's accounts' switch-offs in the week before `now`, by account id: what the refusals feed publishes.
    readonly switchOffs: (provider: string, now?: number) => Promise<SwitchOffs>;
    // The same for every provider with any, by provider id.
    readonly everySwitchOff: (now?: number) => Promise<Readonly<Record<string, SwitchOffs>>>;
    // The provider's accounts switched off FLAPPING_AFTER times or more in the week before `now` (flappingAccounts).
    readonly flapping: (provider: string, now?: number) => Promise<ReadonlySet<string>>;
}

type Stored = Record<string, number[]>;

// What the history is kept in: its file, or a record in memory for a ledger with nothing to persist to.
interface HistoryBacking {
    readonly read: () => Promise<Stored>;
    readonly update: (change: (current: Stored) => Stored) => Promise<Stored>;
}

const keyOf = (provider: string, account: string): string => `${provider}:${account}`;

// Every account's switch-offs after `since`; an account left with none is dropped.
const within = (stored: Stored, since: number): Stored =>
    Object.fromEntries(
        Object.entries(stored).flatMap(([key, instants]) => {
            const kept = instants.filter((at) => at > since);
            return kept.length === 0 ? [] : [[key, kept]];
        }),
    );

// One provider's switch-offs in the week before `now`, keyed by account id.
const switchOffsOf = (stored: Stored, provider: string, now: number): SwitchOffs => {
    const prefix = `${provider}:`;
    return Object.fromEntries(
        Object.entries(within(stored, now - FLAPPING_WINDOW_MS)).flatMap(([key, instants]) => {
            const kept = instants.filter((at) => at <= now);
            return key.startsWith(prefix) && kept.length > 0 ? [[key.slice(prefix.length), kept]] : [];
        }),
    );
};

const historyOver = (backing: HistoryBacking): EntitlementHistory => ({
    switchedOff: async (provider, account, at) => {
        const key = keyOf(provider, account);
        await backing.update((current) => {
            const kept = within(current, Date.now() - FLAPPING_WINDOW_MS);
            const noted = kept[key] ?? [];
            return noted.includes(at) ? kept : { ...kept, [key]: [...noted, at].toSorted((left, right) => left - right) };
        });
    },
    switchOffs: async (provider, now = Date.now()) => switchOffsOf(await backing.read(), provider, now),
    everySwitchOff: async (now = Date.now()) => {
        const stored = await backing.read();
        const providers = new Set(Object.keys(stored).map((key) => key.slice(0, key.indexOf(":"))));
        return Object.fromEntries(
            [...providers].flatMap((provider) => {
                const offs = switchOffsOf(stored, provider, now);
                return Object.keys(offs).length === 0 ? [] : [[provider, offs]];
            }),
        );
    },
    flapping: async (provider, now = Date.now()) => flappingAccounts(switchOffsOf(await backing.read(), provider, now), now),
});

export const fileEntitlementHistory = (path: string): EntitlementHistory =>
    historyOver(openDocument(entitlementRefusalsDocument, path, { fallback: (): Stored => ({}) }));

/** The same history over a record in memory: a ledger held in memory, a test. */
export const memoryEntitlementHistory = (): EntitlementHistory => {
    let held: Stored = {};
    return historyOver({
        read: async () => held,
        update: async (change) => {
            held = change(held);
            return held;
        },
    });
};
