import { type ProviderRefusal, ProviderRefusalSchema } from "@intentic/sandbox-contract/schemas/providers/plan-limits";
import type { AgentProvider } from "@intentic/sandbox-contract/schemas/agent";
import { reportsPlanLimits } from "@intentic/sandbox-contract/models/agent-catalog";
import { z } from "zod";
import { defineDocument } from "../store/evolution/documents.js";
import { jsonFile } from "../store/json-file.js";

/* EVERY TIME A PROVIDER SAID NO, IN ONE LEDGER, at <historyRoot>/provider-refusals.json, outside the agent's reach.
   account-usage.ts holds polled headroom; this holds the moments a plan actually refused, which polling can't produce: a
   spent allowance (for the account and model it named, or the provider's fleet where it named no account), a refused
   sign-in, an account refused outright, and a plan marked spent by hand. Written from the turn's own error path, settled
   by the turn that proves it over. Each is kept as the latest of its kind for the account and model it names.

   One ledger, because one refusal used to be filed three times: as the provider's last refusal (one per provider, last
   one wins, so a second account's refusal erased the first's, 2026-10-11), as a routed model's cooldown
   (model-cooldowns.json, which only the picker read, 2026-10-09), and as a Cursor account's run-out (observed-limits.json,
   which only the role ladder and the spawn listing read, 2026-10-13). Each copy had its own horizon and its own settle
   rule, and each reader judged by its own subset, so one surface greyed a model another spawned onto. Every verdict now
   reads this ledger whole (plan-pools.ts serviceStates), the daemon's and the editor's alike. */

const StoredRefusalsSchema = z.record(z.string(), ProviderRefusalSchema);

export const providerRefusalsDocument = defineDocument({
    root: "history",
    path: "provider-refusals.json",
    schema: ProviderRefusalSchema,
    granularity: "record",
});

/** What an answered turn proves: on which account (none for a routed turn) and model, and when its request went out. */
export interface RefusalAnswer {
    readonly account: string | undefined;
    readonly model: string | undefined;
    // A refusal filed at or after this instant stands: that request was already in flight (an answer to it settled a
    // "try again at 1:53 PM" five seconds after it was filed, 2026-10-19). Undefined settles whatever stands.
    readonly askedAt?: number | undefined;
    // Another model's spent allowance this answer proves open too: every pool that model spends gates the answered one
    // (plan-pools.ts answerCovers). Codex meters every model from one allowance: a Luna turn going through proves Sol's.
    readonly covers?: ((model: string) => boolean) | undefined;
}

export interface ProviderRefusalStore {
    // Every refusal on file, by provider, each past its horizon omitted rather than served: what every verdict on an
    // account is judged against (serviceStates), and what the wire carries.
    readonly onFile: () => Promise<Record<string, readonly ProviderRefusal[]>>;
    // Instant is the caller's, so a test can place it without faking the clock. Replaces the one of the same kind on
    // file for the same account and model.
    readonly record: (provider: string, refusal: ProviderRefusal) => Promise<void>;
    // Settles what an answered turn proves over (settledBy): content on the wire is the only evidence a refusal no poll
    // can re-check yields to.
    readonly settle: (provider: string, answer: RefusalAnswer) => Promise<void>;
    // Drops what `which` picks of a provider's refusals, whatever answered them: an account disconnected, a mark a
    // person took back, a seat a probe found restored. Answers whether anything was on file.
    readonly drop: (provider: string, which: (refusal: ProviderRefusal) => boolean) => Promise<boolean>;
    // Fires on every change, with the provider's refusals as they now stand; what /events forwards, so open windows
    // judge by exactly what the daemon does within the same beat.
    readonly onChange: (listener: (provider: string, refusals: readonly ProviderRefusal[]) => void) => () => void;
}

const HOUR_MS = 60 * 60_000;
// A week, the longest pool cycle any provider sells: past it a refusal's window has certainly reopened or its credential
// churned, so a stale one is worse than nothing.
const WEEK_MS = 7 * 24 * HOUR_MS;
// An account refused outright, or a plan marked spent by hand: a role or a seat is switched back on by a person, not by
// a window reopening, and two hours of belief let a whole fan-out be placed on the refused account again (2026-10-17).
// A day, so one forgotten never grounds a provider for good; a turn answered on the account settles it sooner.
const ENTITLEMENT_FOR_MS = 24 * HOUR_MS;
// A spent allowance nothing can read back: no instant named, and no reading measures it (a plan that publishes none,
// Cursor's or Devin's, or an admin's credit). Only a turn settles it, so it is believed as long as the role ladder
// benches a refused rung (role-model.ts REFUSED_FOR_MS): one held a week stood against the spawn gate for an allowance
// back in three and a half hours (2026-10-15).
const OBSERVED_FOR_MS = 2 * HOUR_MS;

// How long a refusal is believed when nothing settles or answers it first. Forgotten on read, not pruned on write.
const horizon = (provider: string, refusal: ProviderRefusal): number => {
    if (refusal.kind === "entitlement" || refusal.byHand === true) {
        return ENTITLEMENT_FOR_MS;
    }
    // SAFETY: a provider id is a string on the wire and in this file; reportsPlanLimits only tests membership.
    const unread = refusal.unmetered === true || !reportsPlanLimits(provider as AgentProvider);
    return refusal.kind === "limit" && refusal.resetsAt === undefined && unread ? OBSERVED_FOR_MS : WEEK_MS;
};

// The scope a refusal is the latest of: its provider, kind, account and model. A provider's name never holds a colon,
// so the provider is the key's first field, whichever release wrote it (one keyed `provider` or `provider:account`
// reads as an entry like any other, and is re-keyed by the next write).
const scopeOf = (provider: string, refusal: ProviderRefusal): string => `${provider}:${refusal.kind}:${refusal.account ?? ""}:${refusal.model ?? ""}`;
const providerOf = (key: string): string => key.split(":", 1)[0] ?? key;

// The file as scopes, each holding its newest refusal: an older release's provider slot and its account copy of one
// refusal collapse into one entry.
const scoped = (stored: Record<string, ProviderRefusal>): Map<string, ProviderRefusal> => {
    const byScope = new Map<string, ProviderRefusal>();
    for (const [key, refusal] of Object.entries(stored)) {
        const scope = scopeOf(providerOf(key), refusal);
        const held = byScope.get(scope);
        if (held === undefined || held.at < refusal.at) {
            byScope.set(scope, refusal);
        }
    }
    return byScope;
};

/*
 * Whether an answered turn proves this refusal over. Only a request sent after it was filed can. A refusal naming another
 * account is that account's, and still true. A refused credential or account is answered by any turn the account served;
 * a spent allowance only by a turn on the model it named or one whose pools cover it (a title job on a cheap model
 * proves nothing about the pool an expensive one spends, 2026-10-17), or by any turn where it named none. An answer whose
 * model is unknown proves nothing about a model-scoped allowance.
 */
const settledBy = (refusal: ProviderRefusal, answer: RefusalAnswer): boolean =>
    (answer.askedAt === undefined || refusal.at < answer.askedAt) &&
    (refusal.account === undefined || refusal.account === answer.account) &&
    (refusal.kind !== "limit" ||
        refusal.model === undefined ||
        (answer.model !== undefined && (refusal.model === answer.model || answer.covers?.(refusal.model) === true)));

// Every write to this file decides which account a picker skips: each change writes one line through `log`, recorded
// and settled. A settle that finds nothing, the case on nearly every answered turn, writes nothing.
export interface ProviderRefusalStoreOptions {
    readonly log?: (fields: Record<string, unknown>, message: string) => void;
}

const described = (refusal: ProviderRefusal): Record<string, unknown> => ({
    kind: refusal.kind,
    at: new Date(refusal.at).toISOString(),
    ...(refusal.account === undefined ? {} : { account: refusal.account }),
    ...(refusal.model === undefined ? {} : { model: refusal.model }),
    ...(refusal.resetsAt === undefined ? {} : { resetsAt: new Date(refusal.resetsAt * 1000).toISOString() }),
    ...(refusal.byHand === true ? { byHand: true } : {}),
});

type Stored = Record<string, ProviderRefusal>;

// What the ledger is kept in: its file, or a record in memory for a caller with nothing to persist to.
interface LedgerBacking {
    readonly read: () => Promise<Stored>;
    readonly update: (change: (current: Stored) => Stored) => Promise<Stored>;
}

export const fileProviderRefusalStore = (path: string, options: ProviderRefusalStoreOptions = {}): ProviderRefusalStore =>
    refusalStoreOver(
        jsonFile<Stored>(path, { parse: (raw) => StoredRefusalsSchema.safeParse(raw).data, fallback: () => ({}), document: providerRefusalsDocument }),
        options,
    );

/** The same ledger over a record in memory, seeded with what each provider has on file: a test harness, the demo daemon. */
export const memoryProviderRefusalStore = (seed: Readonly<Record<string, readonly ProviderRefusal[]>> = {}): ProviderRefusalStore => {
    let held: Stored = Object.fromEntries(Object.entries(seed).flatMap(([provider, filed]) => filed.map((refusal) => [scopeOf(provider, refusal), refusal])));
    return refusalStoreOver({
        read: async () => held,
        update: async (change) => {
            held = change(held);
            return held;
        },
    });
};

const refusalStoreOver = (file: LedgerBacking, options: ProviderRefusalStoreOptions = {}): ProviderRefusalStore => {
    const log = options.log ?? (() => undefined);

    const listeners = new Set<(provider: string, refusals: readonly ProviderRefusal[]) => void>();
    const onFile = async (): Promise<Record<string, readonly ProviderRefusal[]>> => {
        const now = Date.now();
        const byProvider: Record<string, ProviderRefusal[]> = {};
        for (const [scope, refusal] of scoped(await file.read())) {
            const provider = providerOf(scope);
            if (refusal.at > now - horizon(provider, refusal)) {
                (byProvider[provider] ??= []).push(refusal);
            }
        }
        return byProvider;
    };
    const announce = async (provider: string): Promise<void> => {
        const refusals = (await onFile())[provider] ?? [];
        for (const listener of listeners) {
            listener(provider, refusals);
        }
    };
    // Removes the provider's entries `drops` picks, answering what went; the file is re-keyed by scope as it is written.
    const remove = async (provider: string, drops: (refusal: ProviderRefusal) => boolean): Promise<ProviderRefusal[]> => {
        const removed: ProviderRefusal[] = [];
        await file.update((current) => {
            const kept = [...scoped(current)].filter(([scope, refusal]) => {
                const drop = providerOf(scope) === provider && drops(refusal);
                if (drop) {
                    removed.push(refusal);
                }
                return !drop;
            });
            return removed.length === 0 ? current : Object.fromEntries(kept);
        });
        if (removed.length > 0) {
            await announce(provider);
        }
        return removed;
    };

    return {
        onFile,
        record: async (provider, refusal) => {
            await file.update((current) => ({ ...Object.fromEntries(scoped(current)), [scopeOf(provider, refusal)]: refusal }));
            log({ provider, ...described(refusal), said: refusal.message }, `provider refusal: recorded ${provider} ${refusal.kind}${refusal.account === undefined ? "" : ` for ${refusal.account}`}`);
            await announce(provider);
        },
        settle: async (provider, answer) => {
            for (const settled of await remove(provider, (refusal) => settledBy(refusal, answer))) {
                log(
                    { provider, ...described(settled), ...(answer.account === undefined ? {} : { settledBy: answer.account }) },
                    `provider refusal: settled ${provider} ${settled.kind}${settled.account === undefined ? "" : ` for ${settled.account}`} (${answer.account ?? "a turn"} served)`,
                );
            }
        },
        drop: async (provider, which) => {
            const dropped = await remove(provider, which);
            for (const refusal of dropped) {
                log({ provider, ...described(refusal) }, `provider refusal: dropped ${provider} ${refusal.kind}${refusal.account === undefined ? "" : ` for ${refusal.account}`}`);
            }
            return dropped.length > 0;
        },
        onChange: (listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
    };
};
