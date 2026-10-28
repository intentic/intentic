import { type ProviderRefusal, ProviderRefusalSchema } from "@intentic/sandbox-contract/schemas/providers/plan-limits";
import type { AgentProvider } from "@intentic/sandbox-contract/schemas/agent";
import { reportsPlanLimits } from "@intentic/sandbox-contract/models/agent-catalog";
import { refusedPoolReset, type ServiceFacts } from "@intentic/sandbox-contract/models/plan-pools";
import { defineDocument } from "../store/evolution/documents.js";
import { openDocument } from "../store/open-document.js";
import { type EntitlementHistory, memoryEntitlementHistory } from "./entitlement-history.js";

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

export const providerRefusalsDocument = defineDocument({
    root: "history",
    path: "provider-refusals.json",
    portability: "carry",
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
    // The provider's accounts switched off for their entitlement twice or more this week (entitlement-history.ts), still
    // counted once a turn on them has settled the refusal: what a pick ranks behind every steady account.
    readonly flapping: (provider: string) => Promise<ReadonlySet<string>>;
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
// refusal collapse into one entry. One filed in the future (a bench the boot step filed at its `until`, before
// 2026-10-21) reads as filed just before this ledger opened, whenever it really came: no request sent since preceded it,
// and filed days ahead, no answer could settle it (settledBy) until then.
const scoped = (stored: Record<string, ProviderRefusal>, openedAt: number): Map<string, ProviderRefusal> => {
    const now = Date.now();
    const byScope = new Map<string, ProviderRefusal>();
    for (const [key, filed] of Object.entries(stored)) {
        const refusal = filed.at > now ? { ...filed, at: openedAt - 1 } : filed;
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
    // A provider's accounts as the verdict reads them, for stamping a spent allowance that named no instant with the
    // reset of the pool it was refused in (refusedPoolReset). Without it nothing is stamped, and such a refusal stands
    // until a reading answers it.
    readonly accountsOf?: (provider: string) => Promise<readonly ServiceFacts[]>;
    // Where each account's switch-offs are kept; in memory where none is given.
    readonly history?: EntitlementHistory;
}

const described = (refusal: ProviderRefusal): Record<string, unknown> => ({
    kind: refusal.kind,
    at: new Date(refusal.at).toISOString(),
    ...(refusal.account === undefined ? {} : { account: refusal.account }),
    ...(refusal.model === undefined ? {} : { model: refusal.model }),
    ...(refusal.resetsAt === undefined ? {} : { resetsAt: new Date(refusal.resetsAt * 1000).toISOString() }),
    ...(refusal.poolResetsAt === undefined ? {} : { poolResetsAt: new Date(refusal.poolResetsAt * 1000).toISOString() }),
    ...(refusal.byHand === true ? { byHand: true } : {}),
});

type Stored = Record<string, ProviderRefusal>;

// What the ledger is kept in: its file, or a record in memory for a caller with nothing to persist to.
interface LedgerBacking {
    readonly read: () => Promise<Stored>;
    readonly update: (change: (current: Stored) => Stored) => Promise<Stored>;
}

export const fileProviderRefusalStore = (path: string, options: ProviderRefusalStoreOptions = {}): ProviderRefusalStore =>
    refusalStoreOver(openDocument(providerRefusalsDocument, path, { fallback: (): Stored => ({}) }), options);

/** The same ledger over a record in memory, seeded with what each provider has on file: a test harness, the demo daemon. */
export const memoryProviderRefusalStore = (
    seed: Readonly<Record<string, readonly ProviderRefusal[]>> = {},
    options: ProviderRefusalStoreOptions = {},
): ProviderRefusalStore => {
    let held: Stored = Object.fromEntries(Object.entries(seed).flatMap(([provider, filed]) => filed.map((refusal) => [scopeOf(provider, refusal), refusal])));
    return refusalStoreOver(
        {
            read: async () => held,
            update: async (change) => {
                held = change(held);
                return held;
            },
        },
        options,
    );
};

// A spent allowance naming no instant, filed with the reset of the pool it was refused in, read now while the readings
// still show that pool open: past its reset a reading lapses it and another binds, so the instant is never read back
// later. The verdict ends the refusal there (plan-pools.ts refusalVerdict), in the daemon and every open window at once,
// rather than when the next reading lands.
const stamped = async (accountsOf: ProviderRefusalStoreOptions["accountsOf"], provider: string, refusal: ProviderRefusal): Promise<ProviderRefusal> => {
    if (accountsOf === undefined || refusal.kind !== "limit" || refusal.resetsAt !== undefined) {
        return refusal;
    }
    // allow(silent-catch): accounts that cannot be read file the refusal unstamped, standing until a reading answers it
    const poolResetsAt = refusedPoolReset(refusal, await accountsOf(provider).catch((): readonly ServiceFacts[] => []));
    return poolResetsAt === undefined ? refusal : { ...refusal, poolResetsAt };
};

// A settle heard while a refusal was being stamped, and when.
interface HeardSettle {
    readonly provider: string;
    readonly answer: RefusalAnswer;
    readonly at: number;
}

// The ledger with a refusal filed in its scope, or undefined where it is not to be: a newer one of the scope is on file
// already (one stating its instant is filed without the wait a stamp takes, so it can land first), or a turn answered
// while it was being stamped proves it over, as that settle found nothing on file to settle yet (2026-10-21).
const filedIn = (scopes: Map<string, ProviderRefusal>, provider: string, refusal: ProviderRefusal, heard: readonly HeardSettle[]): Stored | undefined => {
    const scope = scopeOf(provider, refusal);
    const held = scopes.get(scope);
    const answered = heard.some((said) => said.provider === provider && refusal.at < said.at && settledBy(refusal, said.answer));
    return (held !== undefined && held.at > refusal.at) || answered ? undefined : { ...Object.fromEntries(scopes), [scope]: refusal };
};

// The account a refusal switches off (entitlement-history.ts): an entitlement refusal naming an account no entitlement
// refusal of the provider's stood over when it was filed, whatever model either named. One filed while another stands
// (the next turn refused, a probe re-testing the seat) is the same switch-off; one naming no account switches off none.
const switchedOff = (scopes: Map<string, ProviderRefusal>, provider: string, refusal: ProviderRefusal): string | undefined => {
    const { account } = refusal;
    if (refusal.kind !== "entitlement" || account === undefined) {
        return undefined;
    }
    const now = Date.now();
    const standing = [...scopes].some(
        ([scope, held]) => providerOf(scope) === provider && held.kind === "entitlement" && held.account === account && held.at > now - horizon(provider, held),
    );
    return standing ? undefined : account;
};

// What filing one refusal did: whether it went on file, and the account it switched off where it did.
interface Filing {
    readonly filed: boolean;
    readonly off: string | undefined;
}

// Files a stamped refusal onto the ledger, judging the switch-off against the very ledger it lands in.
const filedOnto = async (
    file: LedgerBacking,
    openedAt: number,
    { provider, refusal, heard }: { readonly provider: string; readonly refusal: ProviderRefusal; readonly heard: readonly HeardSettle[] },
): Promise<Filing> => {
    let outcome: Filing = { filed: false, off: undefined };
    await file.update((current) => {
        const scopes = scoped(current, openedAt);
        const next = filedIn(scopes, provider, refusal, heard);
        outcome = { filed: next !== undefined, off: next === undefined ? undefined : switchedOff(scopes, provider, refusal) };
        return next ?? current;
    });
    return outcome;
};

// When each refusal on file passes its horizon, by its provider.
const horizonsOf = (scopes: Map<string, ProviderRefusal>): { readonly provider: string; readonly ends: number }[] =>
    [...scopes].map(([scope, refusal]) => ({ provider: providerOf(scope), ends: refusal.at + horizon(providerOf(scope), refusal) }));

/*
 * Tells `announce` each provider whose refusal passes its horizon, at that instant. Forgotten on read, it would otherwise
 * go unheard: nothing re-judged capacity then, and every open window kept the list last pushed to it (2026-10-21; the sweep
 * that announced Cursor's went with the ledger it swept). Answers what (re)arms it after a change; armed while `listening`.
 */
const horizonWatch = (
    read: () => Promise<Map<string, ProviderRefusal>>,
    announce: (provider: string) => Promise<void>,
    listening: () => boolean,
    log: NonNullable<ProviderRefusalStoreOptions["log"]>,
): (() => Promise<void>) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let swept = Date.now();
    let armed = Promise.resolve();
    // One step at a time, so an older read never sets the timer over a newer one. allow(silent-catch): a ledger that
    // cannot be read now is read again at its next change, and the line says so meanwhile.
    const serially = (step: () => Promise<void>): Promise<void> =>
        (armed = armed.then(step).catch((error) => log({ err: error }, "provider refusal: horizon watch failed")));
    const armNow = async (): Promise<void> => {
        const next = Math.min(...horizonsOf(await read()).flatMap(({ ends }) => (ends > swept ? [ends] : [])));
        clearTimeout(timer);
        timer = listening() && Number.isFinite(next) ? setTimeout(() => void serially(sweep), Math.max(0, next - Date.now())).unref() : undefined;
    };
    const sweep = async (): Promise<void> => {
        const now = Date.now();
        const passed = new Set(horizonsOf(await read()).flatMap(({ provider, ends }) => (ends > swept && ends <= now ? [provider] : [])));
        swept = now;
        await Promise.all([...passed].map(announce));
        await armNow();
    };
    return () => serially(armNow);
};

const refusalStoreOver = (file: LedgerBacking, options: ProviderRefusalStoreOptions = {}): ProviderRefusalStore => {
    const log = options.log ?? (() => undefined);
    const openedAt = Date.now();
    const read = async (): Promise<Map<string, ProviderRefusal>> => scoped(await file.read(), openedAt);

    const listeners = new Set<(provider: string, refusals: readonly ProviderRefusal[]) => void>();
    const onFile = async (): Promise<Record<string, readonly ProviderRefusal[]>> => {
        const now = Date.now();
        const byProvider: Record<string, ProviderRefusal[]> = {};
        for (const [scope, refusal] of await read()) {
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
    const rearm = horizonWatch(read, announce, () => listeners.size > 0, log);
    // Removes the provider's entries `drops` picks, answering what went; the file is re-keyed by scope as it is written.
    const remove = async (provider: string, drops: (refusal: ProviderRefusal) => boolean): Promise<ProviderRefusal[]> => {
        const removed: ProviderRefusal[] = [];
        await file.update((current) => {
            const kept = [...scoped(current, openedAt)].filter(([scope, refusal]) => {
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
            await rearm();
        }
        return removed;
    };
    // The settles heard while each refusal is being stamped.
    const filing = new Set<HeardSettle[]>();
    const history = options.history ?? memoryEntitlementHistory();
    // allow(silent-catch): a switch-off that cannot be noted costs only the ranking it would feed, and the line says so.
    const noteSwitchOff = (provider: string, account: string, at: number): Promise<void> =>
        history.switchedOff(provider, account, at).catch((error) => log({ err: error, provider, account }, "provider refusal: the switch-off could not be noted"));

    return {
        onFile,
        record: async (provider, asFiled) => {
            const heard: HeardSettle[] = [];
            filing.add(heard);
            let refusal = asFiled;
            let outcome: Filing = { filed: false, off: undefined };
            try {
                refusal = await stamped(options.accountsOf, provider, asFiled);
                outcome = await filedOnto(file, openedAt, { provider, refusal, heard });
            } finally {
                filing.delete(heard);
            }
            const what = `${provider} ${refusal.kind}${refusal.account === undefined ? "" : ` for ${refusal.account}`}`;
            log({ provider, ...described(refusal), said: refusal.message }, outcome.filed ? `provider refusal: recorded ${what}` : `provider refusal: not filed ${what}, newer on file or answered since`);
            if (outcome.off !== undefined) {
                await noteSwitchOff(provider, outcome.off, refusal.at);
            }
            if (outcome.filed) {
                await announce(provider);
                await rearm();
            }
        },
        settle: async (provider, answer) => {
            for (const heard of filing) {
                heard.push({ provider, answer, at: Date.now() });
            }
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
        flapping: (provider) => history.flapping(provider),
        onChange: (listener) => {
            listeners.add(listener);
            void rearm();
            return () => listeners.delete(listener);
        },
    };
};
