import { type ProviderRefusal, ProviderRefusalSchema } from "@intentic/sandbox-contract/schemas/providers/plan-limits";
import { z } from "zod";
import { defineDocument } from "../store/evolution/documents.js";
import { jsonFile } from "../store/json-file.js";
import { ENTITLEMENT_FOR_MS, OBSERVED_FOR_MS } from "./observed-limits.js";

// Last refusal per provider, at <historyRoot>/provider-refusals.json, outside the agent's reach. account-usage.ts holds
// polled headroom; this holds the moment a plan actually said no, which polling can't produce. Written from the turn's
// own error path; last one wins, answering "when did this last happen", not "how often".
// Beside it, under `provider:account`, each account's own last limit refusal. A spent allowance is a fact about one
// account, and the provider's last refusal moves on to whichever account says no next: without this copy, an account
// refused and still read at 100 by a provider that rounds (only a refusal proves such a pool empty) read as ready again
// the moment another account was refused. Sign-in and seat refusals need no copy, since each already leaves a mark of
// its own on the account (a revoke mark, a seat mark).

const StoredRefusalsSchema = z.record(z.string(), ProviderRefusalSchema);

export const providerRefusalsDocument = defineDocument({
    root: "history",
    path: "provider-refusals.json",
    schema: ProviderRefusalSchema,
    granularity: "record",
});

export interface ProviderRefusalStore {
    // Every provider's last refusal, keyed by provider; one old enough to describe a reopened window is omitted, not
    // served. What the wire carries and the refusal notes are written from.
    readonly read: () => Promise<Record<string, ProviderRefusal>>;
    // Every refusal on file, by provider: its last one and each account's own last limit refusal, in no particular order.
    // What a verdict on an account is judged against (serviceStates), so one account's spent allowance outlives a
    // refusal on another.
    readonly onFile: () => Promise<Record<string, readonly ProviderRefusal[]>>;
    readonly record: (provider: string, refusal: ProviderRefusal) => Promise<void>;
    // Settles a provider's refusal when a scoped turn runs on the account it named, the only proof an entitlement
    // refusal gets since it outlives any contradicting reading. A routed (nameless) refusal is settled by any success.
    // Settles that account's own limit refusal too: it served a turn. `model` is what the answered turn ran on: a spent
    // allowance filed for one model is settled only by an answer on that model, since a title job on a cheap model
    // proves nothing about the pool an expensive one spends (2026-10-17: a Composer title call settled an Opus refusal
    // two seconds after it was filed, and a Gemini flash-lite one settled an Opus 4.6 refusal). `askedAt` is when the
    // answered request went out: a refusal filed at or after it stands, since that request was already in flight (an
    // answer to it settled a "try again at 1:53 PM" five seconds after it was filed, 2026-10-19).
    readonly clear: (provider: string, account: string | undefined, model?: string | undefined, askedAt?: number) => Promise<void>;
    // Fires on every write, with the refusal as it now stands or undefined once settled; what /events forwards, so open
    // windows update within the same beat.
    readonly onChange: (listener: (provider: string, refusal: ProviderRefusal | undefined) => void) => () => void;
}

// A week, the longest pool cycle any provider sells: past it a refusal's window has certainly reopened or its
// credential churned, so a stale one is worse than nothing. Forgotten on read, not pruned on write.
const FORGET_AFTER_MS = 7 * 24 * 60 * 60_000;

/* How long a refusal nothing else can retire is believed, where a week is far too long:
   - An account refused outright, for as long as the mark that holds it is (observed-limits.ts): a day, unless a turn on
     the account is answered first. Kept a week, a Cursor account the ledger had let go of after a day still read
     "blocked, an admin's to fix" on its card for six more. A Claude seat refused outright is held by its seat mark,
     re-tested by a probe (claude-seat-check.ts), not by this entry.
   - An allowance no reading measures (`unmetered`) refused with no instant to try again at, in a wording nothing here
     reads: as long as any refusal no reading can check (OBSERVED_FOR_MS). No reading answers it and only a turn settles
     it, so one refused in Codex's then-unread dated wording stood a week against the spawn gate and the ladder, for an
     allowance back in three and a half hours (2026-10-15). */
const forgetAfter = (refusal: ProviderRefusal): number => {
    if (refusal.kind === "entitlement") {
        return ENTITLEMENT_FOR_MS;
    }
    return refusal.unmetered === true && refusal.resetsAt === undefined ? OBSERVED_FOR_MS : FORGET_AFTER_MS;
};

// Where an account's own copy is filed; a provider's name never holds a colon, so the two kinds of key never meet.
const accountKey = (provider: string, account: string): string => `${provider}:${account}`;
const providerOf = (key: string): string | undefined => (key.includes(":") ? key.slice(0, key.indexOf(":")) : undefined);

// Kept per account: a spent allowance, on an account the refusal names. A routed refusal names none; the translator
// benches the credential it refused itself.
const accountCopy = (refusal: ProviderRefusal): string | undefined => (refusal.kind === "limit" ? refusal.account : undefined);

/*
 * Whether a turn answered on `model`, by a request that went out at `askedAt`, proves this refusal over. Only a request
 * sent after the refusal was filed can. A refused credential or a refused account is answered by any turn the account
 * served; a spent allowance only by a turn on the model it named, or by any turn where it named none. An answer whose
 * model is unknown proves nothing about a model-scoped allowance.
 */
const answeredBy = (refusal: ProviderRefusal, model: string | undefined, askedAt: number | undefined): boolean =>
    (askedAt === undefined || refusal.at < askedAt) &&
    (refusal.kind !== "limit" || refusal.model === undefined || (model !== undefined && model !== "" && refusal.model === model));

// Every write to this file decided which account a picker skips, and none of it was logged: one account's refusal took
// over the provider's slot from another's and the only trace was the file as it stood afterwards. Each change writes one
// line through `log`: recorded (and whose refusal it superseded in the provider's slot), and settled (by which account's
// turn). A settle that finds nothing to remove, the case on nearly every answered turn, writes nothing.
export interface ProviderRefusalStoreOptions {
    readonly log?: (fields: Record<string, unknown>, message: string) => void;
}

const described = (refusal: ProviderRefusal): Record<string, unknown> => ({
    kind: refusal.kind,
    at: new Date(refusal.at).toISOString(),
    ...(refusal.account === undefined ? {} : { account: refusal.account }),
    ...(refusal.model === undefined ? {} : { model: refusal.model }),
    ...(refusal.resetsAt === undefined ? {} : { resetsAt: new Date(refusal.resetsAt * 1000).toISOString() }),
});

export const fileProviderRefusalStore = (path: string, options: ProviderRefusalStoreOptions = {}): ProviderRefusalStore => {
    const log = options.log ?? (() => undefined);
    const file = jsonFile<Record<string, ProviderRefusal>>(path, {
        parse: (raw) => StoredRefusalsSchema.safeParse(raw).data,
        fallback: () => ({}),
        document: providerRefusalsDocument,
    });

    const listeners = new Set<(provider: string, refusal: ProviderRefusal | undefined) => void>();
    const announce = (provider: string, refusal: ProviderRefusal | undefined): void => {
        for (const listener of listeners) {
            listener(provider, refusal);
        }
    };

    const recent = async (): Promise<[string, ProviderRefusal][]> => {
        const now = Date.now();
        return Object.entries(await file.read()).filter(([, refusal]) => refusal.at > now - forgetAfter(refusal));
    };

    return {
        read: async () => Object.fromEntries((await recent()).filter(([key]) => providerOf(key) === undefined)),
        onFile: async () => {
            const byProvider: Record<string, ProviderRefusal[]> = {};
            for (const [key, refusal] of await recent()) {
                (byProvider[providerOf(key) ?? key] ??= []).push(refusal);
            }
            return byProvider;
        },
        record: async (provider, refusal) => {
            const account = accountCopy(refusal);
            let previous: ProviderRefusal | undefined;
            await file.update((current) => {
                previous = current[provider];
                return {
                    ...current,
                    [provider]: refusal,
                    ...(account === undefined ? {} : { [accountKey(provider, account)]: refusal }),
                };
            });
            // Another account's refusal leaving the provider's slot is the change worth naming: its own limit copy, where
            // it has one, keeps it judged spent; any other kind it held is now off file.
            const superseded = previous !== undefined && previous.account !== refusal.account ? previous : undefined;
            log(
                {
                    provider,
                    ...described(refusal),
                    said: refusal.message,
                    ...(superseded === undefined ? {} : { superseded: { ...described(superseded), keptForAccount: accountCopy(superseded) !== undefined } }),
                },
                `provider refusal: recorded ${provider} ${refusal.kind}${refusal.account === undefined ? "" : ` for ${refusal.account}`}${
                    superseded === undefined ? "" : `, superseding ${superseded.account ?? "an unnamed account"}'s ${superseded.kind}`
                }`,
            );
            announce(provider, refusal);
        },
        clear: async (provider, account, model, askedAt) => {
            let settled = false;
            const removed: ProviderRefusal[] = [];
            await file.update((current) => {
                const stored = current[provider];
                // A refusal naming a different account belongs to someone else, and is still true; one about another
                // model's allowance is still true of that model.
                settled = stored !== undefined && (stored.account === undefined || stored.account === account) && answeredBy(stored, model, askedAt);
                // The account's own copy goes whatever the provider's last says, where this answer is about its model.
                const own = account === undefined ? undefined : accountKey(provider, account);
                const ownCopy = own === undefined ? undefined : current[own];
                const ownSettled = ownCopy !== undefined && answeredBy(ownCopy, model, askedAt);
                const settles = (key: string): boolean => (settled && key === provider) || (ownSettled && key === own);
                removed.splice(0, removed.length, ...Object.entries(current).flatMap(([key, refusal]) => (settles(key) ? [refusal] : [])));
                return removed.length > 0 ? Object.fromEntries(Object.entries(current).filter(([key]) => !settles(key))) : current;
            });
            const cleared = removed[0];
            if (cleared !== undefined) {
                log(
                    { provider, ...described(cleared), ...(account === undefined ? {} : { settledBy: account }) },
                    `provider refusal: settled ${provider} ${cleared.kind}${cleared.account === undefined ? "" : ` for ${cleared.account}`} (${account ?? "a turn"} served)`,
                );
            }
            if (settled) {
                announce(provider, undefined);
            }
        },
        onChange: (listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
    };
};
