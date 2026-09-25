import { type AccountUsage, gatingWindows, humanizeModelId, type ModelRef, type UsageWindow } from "@intentic/sandbox-contract";
import { z } from "zod";
import { defineDocument } from "../store/evolution/documents.js";
import { jsonFile } from "../store/json-file.js";
import type { TurnLimit } from "./serviceability/fleet-limit.js";

// The reading for a plan that publishes none. Cursor's API vends /me, /models, /agents and /repositories and nothing
// about allowances, so the only measurement its accounts ever produce is a refusal — exact where a poll is a floor, but
// true only of the model it named, since a plan can meter one model on its own. Filed per account and per model at
// <historyRoot>/observed-limits.json, outside the agent's reach.
// Distinct from its two neighbours: provider-refusals.ts keeps one refusal per provider (which account last said no),
// model-refusals.ts keeps what a plan never covered. This keeps what an account has run out of.

const StoredLimitSchema = z.object({
    at: z.number(),
    // Vendor's own sentence, so a surface can say why in the words that refused.
    message: z.string(),
});
export type ObservedLimit = z.infer<typeof StoredLimitSchema>;

// `${provider}:${account}` to the models that account is out of; the account is the unit a person switches between, and
// the model is the pool.
const StoredSpendSchema = z.record(z.string(), StoredLimitSchema);
const StoredSchema = z.record(z.string(), StoredSpendSchema);

export const observedLimitsDocument = defineDocument({
    root: "history",
    path: "observed-limits.json",
    schema: StoredSpendSchema,
    granularity: "record",
});

export type ObservedSpend = Record<string, ObservedLimit>;

const keyOf = (provider: string, account: string): string => `${provider}:${account}`;

// How long a refusal is believed. Two hours, matching role-model.ts's REFUSED_FOR_MS: the ladder benches a refused rung
// for exactly this long, and a horizon shorter than that would re-offer a rung the ladder still calls spent.
export const OBSERVED_FOR_MS = 2 * 60 * 60_000;

export interface ObservedLimitStore {
    // Models this account is out of right now; empty for nearly every account, so this must cost one file read and no
    // thought. Forgotten on read, not pruned on write, like the refusal stores beside it.
    readonly spent: (provider: string, account: string) => Promise<ObservedSpend>;
    // Instant is the caller's, like the other refusal stores, so a test can place it without faking the clock.
    readonly record: (provider: string, account: string, model: string, limit: ObservedLimit) => Promise<void>;
}

export const fileObservedLimitStore = (path: string): ObservedLimitStore => {
    const file = jsonFile<Record<string, ObservedSpend>>(path, {
        parse: (raw) => StoredSchema.safeParse(raw).data,
        fallback: () => ({}),
        document: observedLimitsDocument,
    });
    return {
        spent: async (provider, account) => {
            const cutoff = Date.now() - OBSERVED_FOR_MS;
            const stored = (await file.read())[keyOf(provider, account)] ?? {};
            return Object.fromEntries(Object.entries(stored).filter(([, limit]) => limit.at > cutoff));
        },
        record: async (provider, account, model, limit) => {
            const key = keyOf(provider, account);
            await file.update((current) => ({ ...current, [key]: { ...current[key], [model]: limit } }));
        },
    };
};

// Pool key for a model's observed allowance; namespaced so it can't collide with a kind a provider publishes itself.
const kindOf = (model: string): string => `observed:${model}`;

/** Display name for a model id, from the provider's own catalog; undefined names the pool by the id, humanized. */
export type ModelLabels = (model: string) => string | undefined;

// One window per model the account is out of. No reset instant and no window length: the provider published neither,
// and a guessed one would date a sentence someone acts on. What retires a reading is this store's own horizon.
export const observedWindows = (spent: ObservedSpend, labels?: ModelLabels): UsageWindow[] =>
    Object.keys(spent).map((model) => ({
        kind: kindOf(model),
        label: labels?.(model) ?? humanizeModelId(model),
        utilization: 100,
        // Scoped to the model that was refused: nothing here says whether the pool behind it covers anything else.
        gates: { models: [model] },
    }));

export const observedUsage = (spent: ObservedSpend, labels?: ModelLabels, measuredAt: number = Date.now()): AccountUsage | undefined => {
    const windows = observedWindows(spent, labels);
    return windows.length === 0 ? undefined : { windows, measuredAt };
};

/** One account's ledger, as the two readers below take it. */
export interface ObservedReading {
    readonly account: string;
    readonly spent: ObservedSpend;
}

// The entries whose model gates the one being asked, read through the same gate every other surface uses, so a pool
// filed for `composer-2.5` answers for a turn on `composer-2.5` and for nothing else.
const gatingLimits = (spent: ObservedSpend, model: ModelRef, labels: ModelLabels | undefined): readonly { model: string; pool: string }[] => {
    const gating = new Set(gatingWindows({ windows: observedWindows(spent, labels), measuredAt: 0 }, model).map((window) => window.kind));
    return Object.keys(spent)
        .filter((entry) => gating.has(kindOf(entry)))
        .map((entry) => ({ model: entry, pool: labels?.(entry) ?? humanizeModelId(entry) }));
};

// What the ledger says about a fleet for one model, in fleet-limit's own shape. Not fleetLimit itself: there an account
// with no window is unmeasured, which is right for a provider whose poll may simply have failed. Here the ledger IS the
// measurement, so an account with no entry for this model has room, measured now — which is what lets a rung benched by
// one account's refusal be asked again on the other.
// Never names a reopening instant: nothing published one, and the ladder prints whatever this says as fact.
export const observedTurnLimit = (
    readings: readonly ObservedReading[],
    model: ModelRef,
    labels?: ModelLabels,
    now: number = Date.now(),
): TurnLimit => {
    const full = readings.flatMap((reading) => gatingLimits(reading.spent, model, labels).slice(0, 1));
    const withHeadroom = readings.length - full.length;
    return {
        ...(full[0] === undefined ? {} : { pool: full[0].pool }),
        spent: full.length,
        withHeadroom,
        ...(withHeadroom === 0 ? {} : { roomMeasuredAt: now }),
    };
};

// Which account serves this model: one with no standing refusal for it, else the one refused longest ago, since that is
// the one likeliest to have reopened. Ties keep the caller's order, so a fleet with nothing on file runs where it
// always did.
export const pickObservedAccount = <T extends ObservedReading>(readings: readonly T[], model: ModelRef): T | undefined =>
    readings
        .map((reading) => {
            // Unnamed: only which entries gate the model matters here, never what a pool would be called on screen.
            const gating = gatingLimits(reading.spent, model, undefined);
            const at = gating.map((entry) => reading.spent[entry.model]?.at ?? 0);
            return { reading, refusedAt: at.length === 0 ? undefined : Math.max(...at) };
        })
        .reduce<{ reading: T; refusedAt: number | undefined } | undefined>((best, next) => {
            if (best === undefined || best.refusedAt === undefined) {
                return best ?? next;
            }
            return next.refusedAt === undefined || next.refusedAt < best.refusedAt ? next : best;
        }, undefined)?.reading;
