import type { AccountUsage, ModelCooldown, ProviderRefusal } from "../../schemas/providers/plan-limits.js";
import { bindingWindow, SPENT_UTILIZATION } from "./pool-gates.js";

// Which refusals on file still speak, and over which account: the half of the serviceability rule plan-pools.ts runs
// before it lays them on the readings (judgedReading). Every account is judged on its own facts, never another's.

/** Everything the serviceability rule reads of one account, as the account rows already carry it. */
export interface ServiceFacts {
    // The daemon's key: a native account's id, a routed credential's auth-file name.
    readonly account: string;
    readonly needsReauth?: boolean | undefined;
    // Why the sign-in needs renewing, where the provider said.
    readonly detail?: string | undefined;
    readonly seatRefusal?: string | undefined;
    readonly cooling?: { readonly until?: number | undefined; readonly reason?: string | undefined; readonly verify?: string | undefined } | undefined;
    // A routed account's per-model benches as the translator holds them (TranslatorAccount.cooldowns).
    readonly cooldowns?: readonly ModelCooldown[] | undefined;
    readonly usage?: AccountUsage | undefined;
    // How the account is named to a person (its label, a routed credential's address); a surface that quotes a figure
    // says whose it is.
    readonly label?: string | undefined;
}

/** Every refusal on file for one provider: what its accounts are judged against, each standing until something answers it. */
export type RefusalsOnFile = readonly ProviderRefusal[];

// A spent allowance is over once a reading with room in the pool its model spends lands after it; a refused credential
// once any reading does (the token worked). Nothing a reading says answers an entitlement refusal: a seatless account
// authenticates and reads fine. Nor does the refused account's own reading answer an allowance it does not measure
// (`unmetered`: an admin's credit). `measured` says whether this reading can speak to the allowance at all: false for
// that account's own, true for another account's where nothing says which one refused (verdictOn).
// The refused model's pool, not the account's fullest: 2026-11-08, a Google account with its Claude pool at 0% answered
// a Gemini refusal, and one with Claude at 100% could never answer a Gemini one with Gemini's pool open.
const answers = (refusal: ProviderRefusal, facts: ServiceFacts, measured: boolean = refusal.unmetered !== true): boolean => {
    const measuredAt = facts.usage?.measuredAt;
    if (refusal.kind === "entitlement" || !measured || measuredAt === undefined || measuredAt <= refusal.at) {
        return false;
    }
    if (refusal.kind === "auth") {
        return facts.needsReauth !== true;
    }
    const binding = bindingWindow(facts.usage, refusal.model === undefined ? undefined : { id: refusal.model });
    return binding !== undefined && binding.utilization < SPENT_UTILIZATION;
};

/**
 * When the pool a spent allowance that named no instant was refused in reopens, in epoch seconds: the soonest reset of
 * the binding pool for the model it named (the pool judgedReading pins full) on the accounts it may have refused, its own
 * where it named one, any where it named none, as any account's room answers a nameless one. The daemon's ledger stamps
 * it on the refusal as it files it (`poolResetsAt`), while the readings still show that pool open: once it reopens the
 * reading lapses it to an empty pool and a different one binds, so it cannot be read back off the reading later.
 * Undefined for a refusal that named its instant, one no reading measures (`unmetered`), a person's mark (lifted by a
 * person or a turn, not a window), and where no reading publishes a reset still ahead of the refusal.
 */
export const refusedPoolReset = (refusal: ProviderRefusal, accounts: readonly ServiceFacts[]): number | undefined => {
    if (refusal.kind !== "limit" || refusal.resetsAt !== undefined || refusal.unmetered === true || refusal.byHand === true) {
        return undefined;
    }
    const model = refusal.model === undefined ? undefined : { id: refusal.model };
    const resets = accounts
        .filter((facts) => refusal.account === undefined || facts.account === refusal.account)
        .flatMap((facts) => {
            const reset = bindingWindow(facts.usage, model)?.resetsAt;
            return reset !== undefined && reset * 1000 > refusal.at ? [reset] : [];
        });
    return resets.length === 0 ? undefined : Math.min(...resets);
};

/*
 * How one refusal stands over ONE account, judged from that account's facts alone: nothing read of another account
 * answers it there (2026-11-08: one Google account reading room answered every nameless refusal for all 31, within
 * seconds of each, so a refused model read 0% and then 100% again while every turn on it was refused). Over once the
 * instant it named has passed (or, where it named none, the reset of the pool it was refused in, stamped as it was filed:
 * refusedPoolReset, unless this account was read since and a reading outranks a stamp: 2026-10-21). Where it is known to
 * be this account's (it named it, or the provider has no other), the provider's own instant outranks a usage endpoint
 * that kept showing room while it refused, so it stands until then; else this account's reading of the refused pool
 * since it answers it. A nameless one is one account saying no and nothing saying which, so on each account it is only
 * that account's own reading that answers it, whatever kind of allowance or instant it named: held to its instant, one
 * team account's refusal held every Codex account spent for a day, the free ones reading 0% used (2026-10-19).
 */
const verdictOn = (refusal: ProviderRefusal, facts: ServiceFacts, accounts: number, now: number): "standing" | "answered" => {
    const over = refusal.resetsAt ?? refusal.poolResetsAt;
    const readSince = over !== undefined && (facts.usage?.measuredAt ?? 0) > over * 1000;
    if (refusal.kind === "limit" && over !== undefined && over * 1000 <= now && (refusal.resetsAt !== undefined || !readSince)) {
        return "answered";
    }
    const known = refusal.account !== undefined || accounts <= 1;
    if (refusal.kind === "limit" && refusal.resetsAt !== undefined && known) {
        return "standing";
    }
    return answers(refusal, facts, known ? undefined : true) ? "answered" : "standing";
};

/**
 * How a refusal on file stands over a provider's accounts: `gone` once the account it named is disconnected, `standing`
 * while it stands over any account it covers (verdictOn), else `answered`. An empty list is one not loaded yet, so the
 * refusal stands. Judged by the daemon and every open window at the same instant from what the refusal carries.
 */
export const refusalVerdict = (
    refusal: ProviderRefusal,
    accounts: readonly ServiceFacts[],
    now: number = Date.now(),
): "standing" | "answered" | "gone" => {
    const covered = accounts.filter((facts) => (refusal.account ?? facts.account) === facts.account);
    if (accounts.length === 0) {
        return "standing";
    }
    if (covered.length === 0) {
        return "gone";
    }
    return covered.some((facts) => verdictOn(refusal, facts, accounts.length, now) === "standing") ? "standing" : "answered";
};

// A stamp a reading has outlived (verdictOn) says nothing of when the pool now holding the refusal reopens: that pool's
// own reset does.
const unstampedPast = (refusal: ProviderRefusal, now: number): ProviderRefusal => {
    if (refusal.poolResetsAt === undefined || refusal.poolResetsAt * 1000 > now) {
        return refusal;
    }
    const { poolResetsAt: _outlived, ...standing } = refusal;
    return standing;
};

// What a translator's per-model bench says, as a refusal filed for its account: a spent allowance on that model that
// stands until the instant the provider named, and no reading answers it before then (verdictOn: named, with its
// instant). Dated before anything on file, since the translator keeps no instant it began, so a refusal filed since
// (a revoked sign-in) is the account's newer word. One past its instant is over.
export const cooldownRefusals = (facts: ServiceFacts, now: number = Date.now()): ProviderRefusal[] =>
    (facts.cooldowns ?? []).flatMap((cooldown) =>
        cooldown.until * 1000 > now
            ? [{ at: 0, kind: "limit", account: facts.account, model: cooldown.model, resetsAt: cooldown.until, message: `Out of allowance for ${cooldown.model} on this account.` }]
            : [],
    );

/**
 * The refusals still standing over each of a provider's accounts (those naming it, those naming none, and the
 * translator's per-model benches of it), each judged on that account's own facts.
 */
export const standingOver = (accounts: readonly ServiceFacts[], refusals: RefusalsOnFile, now: number = Date.now()): ((account: string) => RefusalsOnFile) => {
    const live = refusals.filter((refusal) => refusalVerdict(refusal, accounts, now) !== "gone");
    return (account) => {
        const facts = accounts.find((entry) => entry.account === account) ?? { account };
        const filed = live
            .filter((refusal) => (refusal.account ?? account) === account && verdictOn(refusal, facts, accounts.length, now) === "standing")
            .map((refusal) => unstampedPast(refusal, now));
        return [...cooldownRefusals(facts, now), ...filed];
    };
};
