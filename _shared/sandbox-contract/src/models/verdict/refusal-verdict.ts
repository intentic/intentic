import type { AccountUsage, ModelCooldown, ProviderRefusal, UsageWindow } from "../../schemas/providers/plan-limits.js";
import { factsAt } from "./current-windows.js";
import { bindingWindow, gatingWindows, SPENT_UTILIZATION } from "./pool-gates.js";
import { windowPeriod } from "./window-period.js";

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
    // The model ids the account runs, where its source can say (TranslatorAccount.models). Absent or empty: unknown,
    // never none.
    readonly models?: readonly string[] | undefined;
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

// How far apart two instants may be and still name one reset: a reading's reset and a refusal's are each worked out
// from a countdown at the moment it was said.
const SAME_RESET_SECONDS = 30 * 60;

// A pool the instant rule can judge: its reset and its window's length both known.
interface JudgedPool {
    readonly window: UsageWindow;
    readonly reset: number;
    readonly period: number;
}

// The current pools the refused model spends, each with its reset and length; undefined where there are none, or where
// one lacks either, since then the refusal's instant may be that pool's.
const judgedPools = (refusal: ProviderRefusal, usage: AccountUsage): readonly JudgedPool[] | undefined => {
    const current = gatingWindows(usage, refusal.model === undefined ? undefined : { id: refusal.model }).filter((window) => window.lapsedAt === undefined);
    const judged = current.flatMap((window) => {
        const period = windowPeriod(window)?.seconds;
        return window.resetsAt === undefined || period === undefined ? [] : [{ window, reset: window.resetsAt, period }];
    });
    return current.length > 0 && judged.length === current.length ? judged : undefined;
};

// A pool whose window opened after the refusal was filed, with room: the provider renewed it early.
const renewedAfter = (refusal: ProviderRefusal, { window, reset, period }: JudgedPool): boolean =>
    reset - period > refusal.at / 1000 + SAME_RESET_SECONDS && window.utilization < SPENT_UTILIZATION;

// Whether every pool that could have held the refusal renewed since: a pool held it only if its window is at least as
// long as the wait the provider named.
const holdersRenewed = (refusal: ProviderRefusal, pools: readonly JudgedPool[], resetsAt: number): boolean => {
    const holders = pools.filter(({ period }) => period + SAME_RESET_SECONDS >= resetsAt - refusal.at / 1000);
    return holders.length > 0 && holders.every((pool) => renewedAfter(refusal, pool));
};

/**
 * What a reading of the refused account taken since says about the instant a spent allowance named, judged on the pools
 * the refused model spends. Only for a refusal the ledger could not resolve as it filed it (refusedPoolOf): one filed
 * before 2026-11-19, a translator's bench, or one whose account's reading could not say then.
 * - `published`: one of them resets at that instant, so the refusal is that pool's, and the instant outranks the room
 *   the reading shows (verdictOn).
 * - `renewed`: none resets there, and every pool long enough to have held the refusal opened after it was filed, with
 *   room: the provider renewed the allowance early. 2026-11-13, OpenAI reset ChatGPT allowances days ahead; a Codex
 *   refusal kept naming the old weekly reset, and every model stayed held for four more days while each window read
 *   open, since nothing but a turn could answer it and every turn was held at the door.
 * - `unpublished`: none resets there and none is a pool renewed since: the refusal is a pool the reading does not name
 *   (a model's own cap), so it holds that model alone (plan-pools.ts judgedReading).
 * - `unjudged`: no such reading, or a pool that publishes no reset or no length to judge by.
 */
export type RefusedInstant = "published" | "renewed" | "unpublished" | "unjudged";

export const refusedInstant = (refusal: ProviderRefusal, usage: AccountUsage | undefined): RefusedInstant => {
    const { resetsAt } = refusal;
    if (refusal.kind !== "limit" || resetsAt === undefined || usage === undefined || usage.measuredAt <= refusal.at) {
        return "unjudged";
    }
    const pools = judgedPools(refusal, usage);
    if (pools === undefined) {
        return "unjudged";
    }
    if (pools.some(({ reset }) => Math.abs(reset - resetsAt) <= SAME_RESET_SECONDS)) {
        return "published";
    }
    return holdersRenewed(refusal, pools, resetsAt) ? "renewed" : "unpublished";
};

/* WHICH POOL A SPENT ALLOWANCE THAT NAMED ITS INSTANT WAS REFUSED IN, resolved once, as the daemon's ledger files it
   (provider-refusals.ts), from the refused account's reading as it stood when the provider refused (factsAt): the pool
   the refused model spends whose reset is that instant (the fullest, where several reset then), stamped `pool`; or, where
   every such pool is current and publishes its reset and its length and none resets then, none of them
   (`poolUnpublished`: a pool the reading does not name, such as one model's own cap). Until 2026-11-19 every judgement
   worked this out again, in the daemon and in every open window, from whatever reading it held, and a reading taken once
   the pool had moved said something else: a Codex refusal on GPT 6.1 Sol was pinned on the weekly pool, which gates
   every model, for four days (2026-11-14). Re-inferring it on each judgement was rejected for that: the reading that can
   say is the one beside the refusal, and only the ledger holds both at once.

   Nothing is stamped where the reading cannot say, and the rule then still works it out as it judges (refusedInstant):
   a refusal naming no instant (its pool is the one a reading since shows full, refusedPoolReset), one no reading
   measures, a person's mark, one naming no account over several (each account's own pool may differ), an account with
   no reading, and a reading in which a pool the model spends has closed since it was read or publishes no reset or no
   length, since the instant may be that pool's. */
export const refusedPoolOf = (refusal: ProviderRefusal, accounts: readonly ServiceFacts[]): Pick<ProviderRefusal, "pool" | "poolUnpublished"> => {
    const { resetsAt } = refusal;
    if (refusal.kind !== "limit" || resetsAt === undefined || refusal.unmetered === true || refusal.byHand === true) {
        return {};
    }
    const refused = refusal.account === undefined ? (accounts.length === 1 ? accounts[0] : undefined) : accounts.find((facts) => facts.account === refusal.account);
    const usage = refused === undefined ? undefined : factsAt(refused, refusal.at).usage;
    const model = refusal.model === undefined ? undefined : { id: refusal.model };
    const pools = gatingWindows(usage, model);
    if (usage === undefined || pools.some((window) => window.lapsedAt !== undefined)) {
        return {};
    }
    const matched = pools
        .filter((window) => window.resetsAt !== undefined && Math.abs(window.resetsAt - resetsAt) <= SAME_RESET_SECONDS)
        .reduce<UsageWindow | undefined>((fullest, window) => (fullest === undefined || window.utilization > fullest.utilization ? window : fullest), undefined);
    if (matched !== undefined) {
        return { pool: matched.kind };
    }
    return judgedPools(refusal, usage) === undefined ? {} : { poolUnpublished: true };
};

/**
 * A refusal as the daemon's ledger files it: a spent allowance stamped with what the accounts' readings say of it now and
 * will not say once its pool has moved on, the reset of the pool it was refused in where it named no instant
 * (refusedPoolReset) and the pool its instant is the reset of where it named one (refusedPoolOf). Anything else as it came.
 */
export const stampedRefusal = (refusal: ProviderRefusal, accounts: readonly ServiceFacts[]): ProviderRefusal => {
    const stamped: ProviderRefusal = { ...refusal, ...refusedPoolOf(refusal, accounts) };
    const poolResetsAt = refusedPoolReset(refusal, accounts);
    if (poolResetsAt !== undefined) {
        stamped.poolResetsAt = poolResetsAt;
    }
    return stamped;
};

// Whether a reading since shows the allowance a refusal named its instant for renewed early, so it is over before then.
// Resolved as it was filed: the very pool it was refused in opened since with room (a pool the reading no longer names,
// or one with no reset or length, says nothing, and the instant stands). Resolved to no published pool, or filed before
// refusals were resolved: every pool long enough to have held it did (refusedInstant `renewed`).
const renewedSince = (refusal: ProviderRefusal, usage: AccountUsage | undefined): boolean => {
    const { resetsAt } = refusal;
    if (refusal.pool === undefined && refusal.poolUnpublished !== true) {
        return refusedInstant(refusal, usage) === "renewed";
    }
    if (resetsAt === undefined || usage === undefined || usage.measuredAt <= refusal.at) {
        return false;
    }
    if (refusal.poolUnpublished === true) {
        const pools = judgedPools(refusal, usage);
        return pools !== undefined && holdersRenewed(refusal, pools, resetsAt);
    }
    const window = usage.windows.find((entry) => entry.kind === refusal.pool && entry.lapsedAt === undefined);
    const period = window === undefined ? undefined : windowPeriod(window)?.seconds;
    return window?.resetsAt !== undefined && period !== undefined && renewedAfter(refusal, { window, reset: window.resetsAt, period });
};

/*
 * How one refusal stands over ONE account, judged from that account's facts alone: nothing read of another account
 * answers it there (2026-11-08: one Google account reading room answered every nameless refusal for all 31, within
 * seconds of each, so a refused model read 0% and then 100% again while every turn on it was refused). Over once the
 * instant it named has passed (or, where it named none, the reset of the pool it was refused in, stamped as it was filed:
 * refusedPoolReset, unless this account was read since and a reading outranks a stamp: 2026-10-21). Where it is known to
 * be this account's (it named it, or the provider has no other), the provider's own instant outranks a usage endpoint
 * that kept showing room while it refused, so it stands until then, unless a reading since shows that pool renewed
 * early (renewedSince); else this account's reading of the refused pool
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
        return renewedSince(refusal, facts.usage) ? "answered" : "standing";
    }
    return answers(refusal, facts, known ? undefined : true) ? "answered" : "standing";
};

/**
 * How a refusal on file stands over a provider's accounts: `gone` once the account it named is disconnected, `standing`
 * while it stands over any account it covers (verdictOn), else `answered`. An empty list is one not loaded yet, so the
 * refusal stands. Judged by the daemon and every open window at the same instant (`now`, the sandbox's clock in epoch ms)
 * from what the refusal carries and each account's reading as it stands then (factsAt).
 */
export const refusalVerdict = (refusal: ProviderRefusal, accounts: readonly ServiceFacts[], now: number): "standing" | "answered" | "gone" => {
    const covered = accounts.map((facts) => factsAt(facts, now)).filter((facts) => (refusal.account ?? facts.account) === facts.account);
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
export const cooldownRefusals = (facts: ServiceFacts, now: number): ProviderRefusal[] =>
    (facts.cooldowns ?? []).flatMap((cooldown) =>
        cooldown.until * 1000 > now
            ? [{ at: 0, kind: "limit", account: facts.account, model: cooldown.model, resetsAt: cooldown.until, message: `Out of allowance for ${cooldown.model} on this account.` }]
            : [],
    );

/**
 * The refusals still standing over each of a provider's accounts (those naming it, those naming none, and the
 * translator's per-model benches of it), each judged on that account's own facts as they stand at `now` (factsAt).
 */
export const standingOver = (accounts: readonly ServiceFacts[], refusals: RefusalsOnFile, now: number): ((account: string) => RefusalsOnFile) => {
    const current = accounts.map((facts) => factsAt(facts, now));
    const live = refusals.filter((refusal) => refusalVerdict(refusal, current, now) !== "gone");
    return (account) => {
        const facts = current.find((entry) => entry.account === account) ?? { account };
        const filed = live
            .filter((refusal) => (refusal.account ?? account) === account && verdictOn(refusal, facts, current.length, now) === "standing")
            .map((refusal) => unstampedPast(refusal, now));
        return [...cooldownRefusals(facts, now), ...filed];
    };
};
