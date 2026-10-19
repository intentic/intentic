import { gatingWindows, type ModelRef } from "@intentic/sandbox-contract/models/plan-pools";
import { humanizeModelId } from "@intentic/sandbox-contract/models/model-label";
import type { UsageWindow } from "@intentic/sandbox-contract/schemas/providers/plan-limits";
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
    // Set by hand rather than by a refused turn: believed far longer, since nobody marks a plan spent by accident and
    // the plan it describes may not reopen for weeks. Absent means a turn's own refusal filed it.
    byHand: z.literal(true).optional(),
    // The account itself is refused, not one model's allowance: it signs in and the provider will not serve it at all
    // (Cursor's `[role_forbidden] … non-billable admins`). Filed under ACCOUNT_WIDE. No wait lifts it, so it is believed
    // for a day unless a turn on the account is answered first. Absent means a spent allowance.
    refused: z.literal("entitlement").optional(),
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

/**
 * The entry an account-wide refusal is filed under in place of a model id: it gates every model the account serves. No
 * provider names a model `*`. A release older than this reads it as a model nobody asks for, which is harmless.
 */
export const ACCOUNT_WIDE = "*";

/** The account's own refusal, where the provider refused the account itself rather than one model's allowance. */
export const accountRefusal = (spent: ObservedSpend): ObservedLimit | undefined => spent[ACCOUNT_WIDE];

// How long a refusal is believed. Two hours, matching role-model.ts's REFUSED_FOR_MS: the ladder benches a refused rung
// for exactly this long, and a horizon shorter than that would re-offer a rung the ladder still calls spent.
export const OBSERVED_FOR_MS = 2 * 60 * 60_000;

// How long a mark set BY HAND is believed. A day: long enough to cover a plan that resets monthly without the mark
// having to be re-applied every couple of hours, short enough that one forgotten never grounds a provider for good.
// Cleared the moment someone unmarks it.
export const BY_HAND_FOR_MS = 24 * 60 * 60_000;

// How long an account-wide refusal is believed: a day, like a hand-set mark. A role or a seat is switched back on by a
// person, not by a window reopening, and two hours of belief let a whole fan-out be placed on the refused account again
// (2026-10-17: three Cursor children, two of them on an account Cursor refuses outright). A turn answered on the account
// clears it sooner (forget, from providerAnswered).
export const ENTITLEMENT_FOR_MS = 24 * 60 * 60_000;

/** When this entry stops being believed; a hand-set mark or an account refusal outlives a refused turn's by a long way. */
export const observedUntil = (limit: ObservedLimit): number =>
    limit.at + (limit.byHand === true ? BY_HAND_FOR_MS : limit.refused === "entitlement" ? ENTITLEMENT_FOR_MS : OBSERVED_FOR_MS);

export interface ObservedLimitStore {
    // Models this account is out of right now; empty for nearly every account, so this must cost one file read and no
    // thought. Forgotten on read, not pruned on write, like the refusal stores beside it.
    readonly spent: (provider: string, account: string) => Promise<ObservedSpend>;
    // Instant is the caller's, like the other refusal stores, so a test can place it without faking the clock.
    readonly record: (provider: string, account: string, model: string, limit: ObservedLimit) => Promise<void>;
    // Drops one account's ledger whole: a forgotten account's refusals describe nothing any more.
    readonly clear: (provider: string, account: string) => Promise<void>;
    // Drops one model's entry, leaving the account's others standing: what unmarking by hand does, where clearing the
    // whole ledger would throw away refusals nobody asked about. Answers whether there was one to drop. `askedAt`, from a
    // turn's answer, is when its request went out: an entry recorded at or after it stands (provider-refusals.ts clear).
    readonly forget: (provider: string, account: string, model: string, askedAt?: number) => Promise<boolean>;
}

export const fileObservedLimitStore = (path: string): ObservedLimitStore => {
    const file = jsonFile<Record<string, ObservedSpend>>(path, {
        parse: (raw) => StoredSchema.safeParse(raw).data,
        fallback: () => ({}),
        document: observedLimitsDocument,
    });
    return {
        spent: async (provider, account) => {
            const now = Date.now();
            const stored = (await file.read())[keyOf(provider, account)] ?? {};
            return Object.fromEntries(Object.entries(stored).filter(([, limit]) => observedUntil(limit) > now));
        },
        record: async (provider, account, model, limit) => {
            const key = keyOf(provider, account);
            await file.update((current) => ({ ...current, [key]: { ...current[key], [model]: limit } }));
        },
        clear: async (provider, account) => {
            const key = keyOf(provider, account);
            await file.update((current) => {
                if (!(key in current)) {
                    return current;
                }
                const { [key]: _dropped, ...rest } = current;
                return rest;
            });
        },
        forget: async (provider, account, model, askedAt) => {
            const key = keyOf(provider, account);
            let had = false;
            await file.update((current) => {
                const stored = current[key];
                const entry = stored?.[model];
                if (stored === undefined || entry === undefined || (askedAt !== undefined && entry.at >= askedAt)) {
                    return current;
                }
                had = true;
                const { [model]: _dropped, ...kept } = stored;
                // An account whose last entry goes leaves no empty record behind, so the file reads as it did before.
                if (Object.keys(kept).length === 0) {
                    const { [key]: _emptied, ...rest } = current;
                    return rest;
                }
                return { ...current, [key]: kept };
            });
            return had;
        },
    };
};

// Pool key for a model's observed allowance; namespaced so it can't collide with a kind a provider publishes itself.
const kindOf = (model: string): string => `observed:${model}`;

/** Display name for a model id, from the provider's own catalog; undefined names the pool by the id, humanized. */
export type ModelLabels = (model: string) => string | undefined;

// One window per model the account is out of. No reset instant and no window length: the provider published neither,
// and a guessed one would date a sentence someone acts on. What retires a reading is this store's own horizon.
// What an account-wide refusal's pool is called wherever a pool is named.
const ACCOUNT_REFUSED = "Account refused";

// An account-wide refusal is one window gating every model, named for what it is rather than for a model.
export const observedWindows = (spent: ObservedSpend, labels?: ModelLabels): UsageWindow[] =>
    Object.keys(spent).map((model) =>
        model === ACCOUNT_WIDE
            ? { kind: kindOf(model), label: ACCOUNT_REFUSED, utilization: 100, gates: "all" }
            : {
                  kind: kindOf(model),
                  label: labels?.(model) ?? humanizeModelId(model),
                  utilization: 100,
                  // Scoped to the model that was refused: nothing here says whether the pool behind it covers anything else.
                  gates: { models: [model] },
              },
    );

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
        .map((entry) => ({ model: entry, pool: entry === ACCOUNT_WIDE ? ACCOUNT_REFUSED : (labels?.(entry) ?? humanizeModelId(entry)) }));
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

const pickAmong = <T extends ObservedReading>(readings: readonly T[], model: ModelRef): T | undefined =>
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

// Which account serves this model: one with no standing refusal for it, else the one refused longest ago, since that is
// the one likeliest to have reopened. An account the provider refused outright comes after every spent one: a spent
// allowance reopens by itself, a refused account does not. Ties keep the caller's order, so a fleet with nothing on file
// runs where it always did.
export const pickObservedAccount = <T extends ObservedReading>(readings: readonly T[], model: ModelRef): T | undefined => {
    const serving = readings.filter((reading) => accountRefusal(reading.spent) === undefined);
    return pickAmong(serving.length > 0 ? serving : readings, model);
};
