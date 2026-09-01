import {
    type AccountUsage,
    type AgentProvider,
    type OauthAccount,
    type ProviderRefusal,
    reportsPlanLimits,
    type TranslatorAccounts,
    type UsageWindow,
} from "@intentic/sandbox-contract";
import { formatWeekdayTime, timeAgo } from "@intentic/ui/format";
import { ref } from "vue";
import { providerAccounts, providerRefusals, translatorAccounts } from "./providerAccounts";

// Every plan-limit window a turn ENDING IN THIS TAB reported, keyed by the account the daemon says served it,
// the `account_usage` frame, read from the provider's usage endpoint at turn end. Account-wide within an
// account, not per-conversation: the last turn on any tab updates its account's entry. Only half of what is
// known about an account, and the half that only exists while this window stays open, the durable half rides
// the account lists (see usageStatusFor). A module singleton so the composer chip, the rate-limit notice and
// the account picker can read it without threading it through each conversation.
export const usageStatusByAccount = ref<Record<string, AccountUsage>>({});

/* Naming the pools. Every one of these is a SEPARATE allowance, and conflating two of them is exactly the bug
 * this vocabulary exists to prevent: an account can sit at 1% of its weekly Opus pool while its weekly
 * all-models pool is at 98%, and calling either of them "Weekly limit" makes the screen lie. The provider's own
 * display name wins where it gives one (the per-model buckets do), because those names are its to change. */
const WINDOW_NAMES: Record<string, string> = {
    five_hour: `5-hour session`,
    seven_day: `Weekly · all models`,
    seven_day_opus: `Weekly · Opus`,
    seven_day_sonnet: `Weekly · Sonnet`,
    seven_day_oauth_apps: `Weekly · third-party apps`,
    seven_day_overage_included: `Weekly · included overage`,
    overage: `Overage credits`,
};

// A pool the provider scopes to one model or one surface is always a slice of the WEEKLY allowance, and reads
// as one: "Weekly · Fable" beside "Weekly · all models", rather than a bare "Fable" that says nothing about
// which allowance it is a slice of.
const SCOPED_KINDS = [`model:`, `surface:`];
export const usageWindowLabel = (window: UsageWindow): string =>
    window.label !== undefined
        ? SCOPED_KINDS.some((prefix) => window.kind.startsWith(prefix))
            ? `Weekly · ${window.label}`
            : window.label
        : (WINDOW_NAMES[window.kind] ?? window.kind);

// Display order: the window that bites soonest first, then the broad weekly pool, then the per-model ones, then
// anything the provider has added since. Stable across accounts so rows line up when several are listed.
const WINDOW_ORDER = [`five_hour`, `seven_day`, `seven_day_opus`, `seven_day_sonnet`, `seven_day_oauth_apps`];
export const orderedWindows = (usage: AccountUsage): UsageWindow[] =>
    usage.windows.toSorted((left, right) => {
        const rank = (window: UsageWindow): number => {
            const index = WINDOW_ORDER.indexOf(window.kind);
            return index === -1 ? WINDOW_ORDER.length : index;
        };
        return rank(left) - rank(right) || usageWindowLabel(left).localeCompare(usageWindowLabel(right));
    });

// The pool that will gate the next turn: the fullest one. A single headroom number can only ever be this one,
// the account is as constrained as its tightest allowance, whichever that happens to be today.
export const bindingWindow = (usage: AccountUsage | undefined): UsageWindow | undefined =>
    usage?.windows.reduce<UsageWindow | undefined>(
        (worst, window) => (worst === undefined || window.utilization > worst.utilization ? window : worst),
        undefined,
    );

// The one-number summary a chip or a picker row shows. Undefined when the account has no usable reading, never
// measured, or every window it had has since reset, so the row shows nothing rather than a confident 0%.
export const usagePercent = (usage: AccountUsage | undefined): number | undefined => {
    const window = bindingWindow(usage);
    return window === undefined ? undefined : Math.round(window.utilization);
};

/* Severity, shared by every surface that draws one of these numbers, so a percentage never means one thing in
 * the composer and another on the Usage tab. Danger is reserved for a pool that is effectively spent. */
export const usageTone = (percent: number): string =>
    percent >= SPENT_PERCENT ? `text-danger` : percent >= TIGHT_PERCENT ? `text-warning` : `text-link`;

/* Where "effectively spent" is defined, once. The account list dims a spent row and sinks it below the ones
 * with headroom, and the ring above it turns red, three decisions that have to agree, and did not while each
 * surface carried its own 90. TIGHT is the same idea one step earlier: the point at which an account stops
 * being one you'd start a long turn on. Named rather than left as the bare 75 this tone scale used to carry,
 * because the capacity counts below have to draw their bands on the SAME two thresholds. */
export const SPENT_PERCENT = 90;
const TIGHT_PERCENT = 75;
export const isSpent = (usage: AccountUsage | undefined): boolean => {
    const percent = usagePercent(usage);
    return percent !== undefined && percent >= SPENT_PERCENT;
};

// The same threshold read the other way round, as the one thing that can answer a spent allowance: a reading
// with room left in it. Named because the note that decides whether a refusal still stands turns on it
// (answersRefusal), and the pin that reads a standing refusal as a full pool rides that same judgement rather
// than carrying a second copy of this comparison.
const hasRoom = (percent: number | undefined): boolean => percent !== undefined && percent < SPENT_PERCENT;

/* The freshest reading for an account, given what the server attached to its row. Both sources are the same
 * AccountUsage; they differ only in how they arrive. The daemon's rides the accounts list (any provider, a
 * Claude snapshot it persisted, a routed subscription's quota it pulled), while the streamed one is pushed by a
 * turn ending in THIS tab, which no list fetched a moment earlier can know about. Newer `measuredAt` wins,
 * which for every provider but Claude simply means the daemon's. */
const freshest = (account: string, attached: AccountUsage | undefined): AccountUsage | undefined => {
    const streamed = usageStatusByAccount.value[account];
    if (streamed === undefined || attached === undefined) {
        return streamed ?? attached;
    }
    return streamed.measuredAt >= attached.measuredAt ? streamed : attached;
};

/* AND WHAT THE PLAN HAS SINCE REFUSED, which outranks both readings above, because a refusal knows the one
 * thing no reading can produce.
 *
 * Every percentage here is POLLED and account-wide: read at a turn's end or on the five-minute sweep, and spent
 * meanwhile by every other client on the same plan. The moment a pool actually runs out is therefore also the
 * moment the reading describing it stops arriving, the endpoint has its own limits and the snapshot simply
 * freezes at whatever it last said. That is how a weekly pool that had refused a turn went on reading "≥99%" on
 * the composer for hours afterwards: honest as a floor, and no answer at all to the only question being asked
 * in front of it, which is whether there is anything left. There is not. The plan said so.
 *
 * So a standing `limit` refusal reads its pool as FULL, the plain 100% the 5-hour window reaches by itself while
 * the provider is still answering. The pool is the account's fullest one, the same rule the daemon uses to look
 * up when the wait ends (accountLimitReset), because the pool that refused the turn is the pool that was
 * binding it.
 *
 * BY PROVIDER, which is the resolution a refusal actually has, and the whole reason this reaches past Claude.
 * The store is keyed by provider (see providerRefusals) because a ROUTED turn cannot name an account at all:
 * CLIProxyAPI picks the auth file itself, so the daemon has nobody to write down. Matching a refusal to an
 * account by NAME therefore fired for exactly one shape of connection, a native Claude account, and silently did
 * nothing for every subscription the translator holds: Kimi's own "403 You've reached your 5-hour usage limit"
 * sat over a 5-hour meter reading 93%, on the same screen, saying the opposite thing.
 *
 * WHO A REFUSAL SPEAKS FOR is then the only question, and it is settled once, here and in refusalAnswer, so the
 * pinned figure and the sentence printed beside it can never describe different events (limitStandsFor). It
 * names an account ⇒ that account alone; it names none ⇒ every connection the provider holds, which is what a
 * routed refusal MEANS rather than a guess about it, since the translator refuses only once every credential it
 * holds is cooling down.
 *
 * ONLY A SPENT ALLOWANCE (`limit`). A rejected credential and a revoked seat say nothing whatever about a pool,
 * and drawing them as a full one would answer a question nobody asked with a fact nobody has.
 *
 * IT SETTLES ITSELF, on the rule that settles the note: a reading taken since the refusal with room in it
 * answers it, and an answered refusal pins nothing. Nor can it feed itself and so outlive its own evidence,
 * because the judgement runs on the RAW readings (providerReadings), never on the pinned ones it produces. */
const spentByRefusal = (provider: AgentProvider, account: string, usage: AccountUsage | undefined): AccountUsage | undefined => {
    const binding = bindingWindow(usage);
    if (usage === undefined || binding === undefined || binding.utilization >= 100 || !limitStandsFor(provider, account, usage)) {
        return usage;
    }
    return { ...usage, windows: usage.windows.map((entry) => (entry === binding ? { ...entry, utilization: 100 } : entry)) };
};

// The provider rides along because the refusal that corrects a reading is filed under it, not under the account
// (see spentByRefusal): every caller here holds one, the tab it is drawing being what picked it.
export const liveUsage = (provider: AgentProvider, account: string, attached: AccountUsage | undefined): AccountUsage | undefined =>
    spentByRefusal(provider, account, freshest(account, attached));

/* The same merge for a caller that holds an account ID AND NOTHING ELSE, the composer chip, the picker's rows,
 * the sentence a refused turn prints. They are handed an account by the conversation, never the row it came
 * from, so the attached half has to be looked up rather than passed in.
 *
 * That lookup is the whole point. This used to answer from the streamed map alone, which meant the chat
 * surfaces reported whatever the last turn IN THIS BROWSER TAB happened to see: a tab left open showed an
 * hours-old floor ("≥87%") while the account rows two routes away, same store, same account, drew the
 * current number. A reading nobody can reconcile is worse than no reading, because it is the one the user
 * checks before deciding whether to send. */
// The subscriptions the translator holds for a provider, or none: it keeps auth files for four of them, and
// every other provider key simply has no half here. Written once because both the lookup below and the readings
// a refusal is judged against need the same "and its routed connections too".
const routedAccounts = (provider: AgentProvider): TranslatorAccounts[keyof TranslatorAccounts] =>
    translatorAccounts.value[provider as keyof TranslatorAccounts] ?? [];

const attachedUsage = (provider: AgentProvider, account: string): AccountUsage | undefined =>
    // A provider's own account is keyed by id and a translator subscription by its auth-file name, the same
    // two keys planLimitRows files them under, because it is the same shared store on the daemon's side.
    (providerAccounts.value[provider] ?? []).find((entry) => entry.id === account)?.usage ??
    routedAccounts(provider).find((entry) => entry.name === account)?.usage;

export const usageStatusFor = (provider: AgentProvider, account: string | undefined): AccountUsage | undefined =>
    account === undefined ? undefined : liveUsage(provider, account, attachedUsage(provider, account));

export interface PlanLimitPool {
    readonly kind: string;
    readonly label: string;
    // Rounded once here, so a meter's width and its printed number can't disagree.
    readonly percent: number;
    readonly resetsAt: number | undefined;
}

/* ONE READING, AS THE POOLS IT IS MADE OF, named, ordered worst-first, rounded once. Everything that draws
 * plan limits starts here: the Usage tab's meters (planLimitRow), the ring's hover card, the sentence a screen
 * reader hears. A pool that reads "Weekly · Opus 91% (resets Sun 5:00 AM)" in one of them therefore reads the
 * same in the others, which is the whole reason this is a projection rather than three formatters. */
const usagePools = (usage: AccountUsage): readonly PlanLimitPool[] =>
    orderedWindows(usage).map((window) => ({
        kind: window.kind,
        label: usageWindowLabel(window),
        percent: Math.round(window.utilization),
        resetsAt: window.resetsAt,
    }));

/* ---- which pool a MODEL spends ---------------------------------------------------------------------------
 * A plan that meters models separately publishes one pool per model (`model:Opus`, `model:Fable`; see the
 * sandbox's claude-usage.ts, where the scope's own display name becomes the kind). That is the only place in
 * this product where "what does picking this model cost" has a real answer rather than a guess, so the match
 * from a picked model to its pool is written once, here, beside the pools it reads.
 *
 * TOKENS, NOT SUBSTRINGS. The pool is named by the plan ("Opus"), the model by its vendor ("claude-opus-4-6",
 * "Claude Opus 4.6"), and the two only ever agree on a word. A substring test would match "opus" inside an id
 * that merely mentions it, and a normalized-string equality would match nothing at all. */
const wordsOf = (text: string): readonly string[] =>
    text
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter(Boolean);

// Whether `needle` appears as a run of whole words in `words`: "claude opus" is in "claude-opus-4-6", "opus"
// is in "Claude Opus 4.6", and "sonnet" is in neither.
const runOfWords = (words: readonly string[], needle: readonly string[]): boolean =>
    needle.length > 0 && words.some((_, at) => needle.every((word, index) => words[at + index] === word));

const MODEL_SCOPE = `model:`;

/* WHAT ONE MODEL SPENDS, as much of it as the plan publishes. The pool's own figures, plus the plan's NAME for
 * the model it meters ("Opus"), which is what a sentence about it has to say: the pool's label reads
 * "Weekly · Opus", written for a meter's heading and not for prose. */
export interface ModelAllowance {
    readonly name: string;
    readonly percent: number;
    readonly resetsAt: number | undefined;
}

/* The pool the given model draws on, or undefined when this plan doesn't meter it separately (every provider
 * but Claude today) or when nothing has been read yet. Both the id the wire carries and the label the picker
 * shows are offered to the match, because which of them names the tier differs by vendor.
 *
 * AMBIGUITY ANSWERS NOTHING. Two pools matching one model (a plan that meters "Opus" and "Claude Opus"
 * separately) means we cannot say which allowance a turn spends, so the more specific one wins and a tie
 * returns undefined: no sentence beats a sentence naming the wrong pool. */
export const modelAllowance = (
    pools: readonly PlanLimitPool[],
    model: { readonly id: string; readonly label: string },
): ModelAllowance | undefined => {
    const id = wordsOf(model.id);
    const label = wordsOf(model.label);
    const matched = pools
        .filter((pool) => pool.kind.startsWith(MODEL_SCOPE))
        .map((pool) => ({ pool, scope: wordsOf(pool.kind.slice(MODEL_SCOPE.length)) }))
        .filter((entry) => runOfWords(id, entry.scope) || runOfWords(label, entry.scope))
        .toSorted((left, right) => right.scope.length - left.scope.length);
    const best = matched[0];
    if (best === undefined || matched[1]?.scope.length === best.scope.length) {
        return undefined;
    }
    return { name: best.pool.kind.slice(MODEL_SCOPE.length), percent: best.pool.percent, resetsAt: best.pool.resetsAt };
};

// The fullest of them, the pool that will gate the next turn, off the ROUNDED figures the meters draw, so a
// headline number and the pool it names can never come from different arithmetic.
const bindingPool = (pools: readonly PlanLimitPool[]): PlanLimitPool | undefined =>
    pools.reduce<PlanLimitPool | undefined>((worst, pool) => (worst === undefined || pool.percent > worst.percent ? pool : worst), undefined);

export interface PlanHeadroom {
    // The binding pool's figure, what the ring draws, and what its tone is taken from.
    readonly percent: number;
    readonly tone: string;
    readonly stale: boolean;
    readonly measuredAt: number;
    readonly pools: readonly PlanLimitPool[];
    // The pool `percent` came from. Undefined when every pool has reset, the one state where the account has
    // been measured and there is nothing left to name.
    readonly binding: PlanLimitPool | undefined;
}

/* AN ACCOUNT'S HEADROOM, PROJECTED ONCE, the one number a ring draws, its severity, and the per-pool
 * breakdown the card behind it lists. Undefined only when there is NO reading: that is the state the connection
 * row answers with a plain dot, and it must stay distinguishable from a measured 0%.
 *
 * Structured, not a sentence. This used to hand every surface a pre-joined tooltip string, which is how the
 * rings ended up wearing a four-line slab of prose, "5-hour session 56% (resets Mon 12:30 AM) · Weekly · all
 * models 15% (resets Sun 5:00 AM) · …", over the very rows the reader was comparing. Pools, figures and
 * resets travel as data so the card can draw them as a list of meters and the sentence survives only where a
 * sentence is the right medium (usageDetail, spoken to a screen reader).
 *
 * The `?? 0` is the one deliberate difference from the composer chip. `usagePercent` returns undefined when
 * every window has reset (an empty array), which is right for a chip that should not be pinned by a stale
 * reading, but wrong for an account row, where a reset account IS at 0%: it was measured, its pools reopened,
 * and "you have room" beats "we don't know". */
export const planHeadroom = (usage: AccountUsage | undefined): PlanHeadroom | undefined => {
    if (usage === undefined) {
        return undefined;
    }
    const pools = usagePools(usage);
    const binding = bindingPool(pools);
    const percent = binding?.percent ?? 0;
    return { percent, tone: usageTone(percent), stale: isStale(usage), measuredAt: usage.measuredAt, pools, binding };
};

// Format an epoch-seconds reset instant as a short local weekday + time (e.g. "Mon 15:20"), unambiguous for
// both the 5-hour and weekly windows without a ticking relative clock.
export const formatReset = (epochSeconds: number): string => formatWeekdayTime(epochSeconds * 1000);

/* The same instant as a RELATIVE wait, for the outage retry, where a wall-clock time would be the wrong answer
 * to the right question. A limit reset is hours out, so naming the hour lets someone decide whether to wait; an
 * outage retry is thirty seconds to twenty minutes out, and "Tue 9:41 PM" makes the reader do arithmetic to learn
 * something they'd have understood instantly as "about 30s".
 *
 * Deliberately coarse ("about"), and not a ticking countdown: the schedule has jitter and the daemon polls on its
 * own cadence, so a second-accurate clock here would be precision this cannot honour. The live countdown belongs
 * on the in-turn retry status, where the harness really does name its own next attempt. */
export const formatWait = (epochSeconds: number, now: number = Date.now()): string => {
    const seconds = Math.max(0, Math.round((epochSeconds * 1000 - now) / 1000));
    if (seconds < 90) {
        return `about ${Math.max(5, Math.round(seconds / 5) * 5)}s`;
    }
    return `about ${Math.round(seconds / 60)} min`;
};

/* How old a reading is, the KIT'S age words (timeAgo), asked to keep counting in days rather than handing over
 * to an absolute date the way a log row does: how stale a snapshot is stays the question at any distance, and a
 * date would make the reader do the subtraction. This is a name, not a second implementation; it used to be the
 * latter, and the copy had drifted on every tier below the day, rounding down where the kit rounded up, calling
 * two minutes "just now", so one gap read differently on two screens a click apart.
 *
 * A reading is taken at the end of a turn, so an idle sandbox's is as old as its last turn, and utilization
 * only ever climbs within a window, so the number it dates is a floor, not a live figure. */
export const formatAge = (measuredAt: number, now: number = Date.now()): string => timeAgo(measuredAt, { now, days: true });

/* Past this, a reading stops being a figure and becomes a FLOOR. Two reasons it can only ever climb away from
 * us: utilization never falls inside a window, and these pools are ACCOUNT-wide, another Claude Code, the
 * desktop app, claude.ai itself all spend the same allowance without this sandbox hearing about it. Ten minutes
 * is roughly "since the last turn": inside that, the reading is what the provider just told us. */
const STALE_AFTER_MS = 10 * 60_000;
export const isStale = (usage: AccountUsage, now: number = Date.now()): boolean => now - usage.measuredAt > STALE_AFTER_MS;

/* A percentage, marked as a floor when the reading is old enough to have been overtaken elsewhere.
 *
 * Never at 100. The mark says "this can only have climbed since", and a full pool has nowhere left to climb to,
 * so "≥100%" claims a thing that cannot happen while reading as though the number were still in doubt. The one
 * figure on this screen that is not a floor is the one that says the allowance is gone. */
export const formatUtilization = (percent: number, stale: boolean): string => `${stale && percent < 100 ? `≥` : ``}${percent}%`;

/* THE SAME BREAKDOWN AS ONE SENTENCE, the ring's accessible name, and nothing else. A screen reader gets no
 * hover, so the card that lists these pools as meters (UsageRing.vue) never reaches it; this line is how the
 * same facts arrive there, and it is the reason the string form still exists after the card replaced it on
 * screen. Every pool, because "which one is binding" is what the single number can't answer, and the reset
 * rides in parentheses because "wait 20 minutes" and "wait until Thursday" are different answers to the same
 * percentage. */
export const usageDetail = (headroom: PlanHeadroom): string =>
    [
        ...headroom.pools.map(
            (pool) =>
                `${pool.label} ${formatUtilization(pool.percent, headroom.stale)}${pool.resetsAt === undefined ? `` : ` (resets ${formatReset(pool.resetsAt)})`}`,
        ),
        `measured ${formatAge(headroom.measuredAt)}`,
    ].join(` · `);

/* ---- plan limits, as rows ---------------------------------------------------------------------------------
 * EVERY connection this sandbox holds, drawn from the same snapshot type, the projection behind the Usage
 * tab's meters, and the counterpart to the Agent tab's rings (AiAccountSection's rowsOf, which decorates the
 * same two lists with the same liveUsage merge).
 *
 * Both lists, because a sandbox's connections come two ways and the reader has one question: a provider's own
 * account (Claude) and a subscription the translator holds (ChatGPT, Google, Kimi, SuperGrok). The Usage tab
 * read only the first, and only through the STREAMED map at that, so Google's headroom, which the daemon
 * pulls and hands over on the account row, could not appear there however well it was read. One list, one
 * merge, one shape.
 *
 * An account with NO reading is a row too. Absence rendered as absence is indistinguishable from an account
 * with room to spare, and those mean opposite things, so the row is listed and says which of the two states
 * it is in: a plan that publishes no limits at all (`readable: false`. SuperGrok alone, now that Kimi's own
 * endpoint is read), or one that simply
 * has not been measured yet. */

export interface PlanLimitRow {
    // Unique across providers: a native account id is a uuid, a routed one is an auth-file name unique only
    // within its own provider.
    readonly id: string;
    readonly provider: AgentProvider;
    // The key the DAEMON knows this account by, the account id or the auth-file name, which is what `id` is
    // made unique from, and the key a refusal names the account it was serving with (see refusalNote).
    readonly account: string;
    readonly label: string;
    // Who this account signs in as, when the LABEL does not already say it. The label is the user's to rename
    // and starts life as whatever the provider offered, so a row can read "Claude" beside two emails and answer
    // nothing; the identity rides alongside rather than inside it, exactly as it does on the Agent tab.
    readonly identity: string | undefined;
    // Undefined ⇒ no reading at all; `readable` then says whether one is even obtainable.
    readonly percent: number | undefined;
    readonly pools: readonly PlanLimitPool[];
    // The pool the percentage came from, the one that will gate this account's next turn. Carried rather than
    // re-derived, so a summary line naming a pool and the meter under it can't pick different ones.
    readonly binding: PlanLimitPool | undefined;
    readonly measuredAt: number | undefined;
    readonly stale: boolean;
    readonly readable: boolean;
    // A credential that can no longer be refreshed. Nothing to do with headroom, everything to do with whether
    // this account can serve a turn, so it rides the same row and surfaces in the same attention list.
    readonly needsReauth: boolean;
}

// What a row is built from, in the two lists' common terms, the daemon's key for the account, who it says it
// is, and the reading it arrived with. Named rather than passed as five positionals, because `label` and
// `identity` are both strings and swapping them silently produces a plausible-looking wrong screen.
interface PlanLimitSource {
    readonly account: string;
    readonly label: string;
    readonly identity: string | undefined;
    readonly attached: AccountUsage | undefined;
    readonly needsReauth: boolean;
}

const planLimitRow = (provider: AgentProvider, source: PlanLimitSource): PlanLimitRow => {
    const usage = liveUsage(provider, source.account, source.attached);
    const pools = usage === undefined ? [] : usagePools(usage);
    const binding = bindingPool(pools);
    return {
        id: `${provider}:${source.account}`,
        provider,
        account: source.account,
        label: source.label,
        identity: source.identity,
        percent: binding?.percent,
        pools,
        binding,
        measuredAt: usage?.measuredAt,
        stale: usage !== undefined && isStale(usage),
        readable: reportsPlanLimits(provider),
        needsReauth: source.needsReauth,
    };
};

// Measured rows first, tightest of those at the top, the account about to gate a turn is the one worth seeing
// without scrolling. Unmeasured rows sink rather than sort as 0%: unknown is not headroom.
export const planLimitRows = (native: Record<string, readonly OauthAccount[]>, routed: TranslatorAccounts): PlanLimitRow[] =>
    [
        ...Object.entries(native).flatMap(([provider, accounts]) =>
            accounts.map((account) =>
                planLimitRow(provider, {
                    account: account.id,
                    label: account.label,
                    // Only when it adds something: an account already named by its own email must not print it
                    // twice, which is the same rule the Agent tab's identity note follows.
                    identity: account.email === account.label ? undefined : account.email,
                    attached: account.usage,
                    needsReauth: account.needsReauth === true,
                }),
            ),
        ),
        // A routed subscription has no reauth flag of its own: CLIProxyAPI drops an auth file it can no longer
        // refresh, so a broken one leaves the list rather than sitting in it. Nor a separate identity, the
        // translator reports one name per auth file, and that name IS the label.
        ...Object.entries(routed).flatMap(([provider, accounts]) =>
            accounts.map((account) =>
                planLimitRow(provider, {
                    account: account.name,
                    label: account.label,
                    identity: undefined,
                    attached: account.usage,
                    needsReauth: false,
                }),
            ),
        ),
    ].toSorted((left, right) => {
        if (left.percent === undefined || right.percent === undefined) {
            return left.percent === right.percent ? left.label.localeCompare(right.label) : left.percent === undefined ? 1 : -1;
        }
        return right.percent - left.percent || left.label.localeCompare(right.label);
    });

/* ---- plan limits, aggregated ------------------------------------------------------------------------------
 * What a row list cannot answer once there are dozens of accounts. This sandbox holds 36 connections, 31 of
 * them Google, and a row each is 36 restatements of a question nobody asked: the operator picks a PROVIDER, and
 * the translator balances turns across that provider's accounts. So the unit of the screen is the provider, and
 * the unit of the fleet's capacity is a COUNT of accounts by band.
 *
 * Counts, never a mean utilization. Averaging 31 separate pools produces a number that describes no account and
 * hides the only one that matters: 30 idle accounts and one spent one is not "3% used", it is "one account you
 * can't use". Each band is a decision: run on it, avoid a long turn on it, don't route to it, or don't know. */

// Ordered worst-first: the same order the segments are drawn and the counts are read in, so the bar, the legend
// and the sentence can't disagree about which end is bad.
export const PLAN_LIMIT_BANDS = [`spent`, `tight`, `room`, `unread`, `none`] as const;
export type PlanLimitBand = (typeof PLAN_LIMIT_BANDS)[number];

/* `none` is not a degree of fullness, it is a plan that publishes no limits at all (SuperGrok), and it
 * stays out of the capacity bar for that reason: an account whose headroom is unknowable is not headroom.
 *
 * Asked for the two fields it actually reads rather than a whole row, so the model picker's footer can band the
 * rings it has already drawn (see pickerAccounts.capacityCounts) without first rebuilding them as roster rows. */
export const planLimitBand = (row: Pick<PlanLimitRow, `percent` | `readable`>): PlanLimitBand => {
    if (row.percent === undefined) {
        return row.readable ? `unread` : `none`;
    }
    return row.percent >= SPENT_PERCENT ? `spent` : row.percent >= TIGHT_PERCENT ? `tight` : `room`;
};

// The words a count is read with. Sentence fragments, not headings: they are consumed as "3 with room · 1 tight".
export const PLAN_LIMIT_BAND_LABEL: Record<PlanLimitBand, string> = {
    spent: `spent`,
    tight: `tight`,
    room: `with room`,
    unread: `unread`,
    none: `no published limits`,
};

/* Severity for a band, on the same three tones a percentage wears everywhere else, so the capacity bar and the
 * meters under it mean the same thing by the same colour. `unread` and `none` take the achromatic slot on
 * purpose: they are the absence of a reading, and giving them a hue would seat them on the severity scale. */
export const planLimitBandTone = (band: PlanLimitBand): string =>
    band === `spent` ? `text-danger` : band === `tight` ? `text-warning` : band === `room` ? `text-link` : `text-muted`;

export type PlanLimitCounts = Record<PlanLimitBand, number>;

const countBands = (rows: readonly PlanLimitRow[]): PlanLimitCounts => {
    const counts: PlanLimitCounts = { spent: 0, tight: 0, room: 0, unread: 0, none: 0 };
    for (const row of rows) {
        counts[planLimitBand(row)] += 1;
    }
    return counts;
};

// The soonest pool to reopen, in epoch seconds, the one number that answers "when does capacity come back".
// Past resets are ignored rather than reported: a window whose instant has passed describes a pool that has
// already reopened, and naming it would send a reader to wait for something that already happened.
const nextReset = (rows: readonly PlanLimitRow[], now: number): number | undefined => {
    const upcoming = rows.flatMap((row) =>
        row.pools.flatMap((pool) => (pool.resetsAt !== undefined && pool.resetsAt * 1000 > now ? [pool.resetsAt] : [])),
    );
    return upcoming.length === 0 ? undefined : Math.min(...upcoming);
};

export interface PlanLimitGroup {
    readonly provider: AgentProvider;
    readonly rows: readonly PlanLimitRow[];
    readonly counts: PlanLimitCounts;
    // The account that gates this provider first, what the group row states instead of a percentage of its own.
    readonly tightest: PlanLimitRow | undefined;
    readonly nextResetAt: number | undefined;
    // The last turn this provider actually refused, already read against what has happened since, see
    // refusalNote.
    readonly refusal: RefusalNote | undefined;
    // The account it happened on, when the daemon named one and that account is still connected. Placement,
    // not judgement: a refusal belongs on its own account's block wherever that block is drawn, and names its
    // account in the line when it isn't.
    readonly refusedRow: PlanLimitRow | undefined;
}

// One group per provider, each group's most-constrained account first, and the groups themselves ordered by how
// close they are to gating a turn. A provider with no reading at all sinks below every provider that has one,
// the same rule the rows follow, one level up.
export const planLimitGroups = (
    rows: readonly PlanLimitRow[],
    refusals: Record<string, ProviderRefusal> = {},
    now: number = Date.now(),
): PlanLimitGroup[] => {
    const byProvider = new Map<AgentProvider, PlanLimitRow[]>();
    for (const row of rows) {
        const group = byProvider.get(row.provider) ?? [];
        group.push(row);
        byProvider.set(row.provider, group);
    }
    return [...byProvider.entries()]
        .map(([provider, groupRows]): PlanLimitGroup => {
            const tightest = groupRows.find((row) => row.percent !== undefined);
            const refusal = refusals[provider];
            return {
                provider,
                rows: groupRows,
                counts: countBands(groupRows),
                tightest,
                nextResetAt: nextReset(groupRows, now),
                refusal: refusalNote(refusal, groupRows, now),
                refusedRow: groupRows.find((row) => row.account === refusal?.account),
            };
        })
        .toSorted((left, right) => (right.tightest?.percent ?? -1) - (left.tightest?.percent ?? -1) || left.provider.localeCompare(right.provider));
};

/* WHAT A REFUSAL READS AS, once, because both surfaces that show one (the Agent tab's connection list, the
 * Usage tab's provider groups) have to say the same thing about the same event.
 *
 * Two states, and the difference between them is the whole design. While a refusal is CURRENT it is quoted: the
 * provider's own words are the only part that names which pool ran out or which credential was rejected, and
 * paraphrasing them would throw away the single most useful thing here. Once it has been answered by what
 * happened afterwards it becomes a footnote about a thing that is over, and quoting a 401 at someone whose
 * account has been serving turns all afternoon is how a surface teaches its reader to distrust it, the words
 * move to `detail`, where a hover still reaches them.
 *
 * The condition comes from the record's `kind`, read off what the provider SAID, not off the frame code,
 * precisely so a spent Kimi plan stops reading as a broken sign-in. The AGE, not the clock time, and no reset
 * instant: a reset belongs to a POOL, and this event knows only that one of them refused. */
const REFUSAL_CONDITION: Record<ProviderRefusal["kind"], string> = {
    limit: `Hit its usage limit`,
    auth: `Refused its credential`,
    // Not "refused its credential": the credential is fine, and telling someone to reconnect an account whose
    // sign-in works is the one instruction guaranteed to waste their time. The plan turned the ACCOUNT away.
    entitlement: `Turned this account away`,
};
const REFUSAL_ANSWERED: Record<ProviderRefusal["kind"], string> = {
    limit: `has had room since`,
    auth: `authenticated fine since`,
    entitlement: `has run a turn since`,
};

export interface RefusalNote {
    // The line to draw: the provider's sentence while this is current, what has happened since once it is not.
    readonly line: string;
    // The provider's own words, in both states, the hover behind a line that no longer prints them.
    readonly detail: string;
    // Alarm or footnote. Never hidden either way: "this refused a turn on Tuesday" is context worth having,
    // just not context worth alarming over.
    readonly current: boolean;
}

// One account's state, as much of it as a refusal can be judged against. Structurally what a PlanLimitRow
// already is, so the Usage tab passes its rows straight in and the Agent tab maps the same four fields off the
// snapshot it decorated its own rows with.
export interface RefusalReading {
    readonly account: string;
    readonly measuredAt: number | undefined;
    readonly percent: number | undefined;
    readonly needsReauth: boolean;
}

/* What it takes to say a refusal is OVER, which differs by kind because the two facts differ. A spent pool is
 * answered by HEADROOM, a reading taken since with room in it. A rejected credential is not: a percentage says
 * nothing about whether a token works, so what answers it is the account having been read at all since (every
 * reading is taken through that same credential) while the store still holds it as usable. That distinction is
 * what lets the daemon's own recovery show: a refused Claude token is re-minted and the turn re-run within
 * seconds, and the reading that follows is the proof it worked. */
const answersRefusal = (refusal: ProviderRefusal, reading: RefusalReading): boolean => {
    /* NOTHING A READING CONTAINS ANSWERS AN ENTITLEMENT REFUSAL, so this one is settled at the source or not at
     * all: the daemon drops it the moment a turn actually runs on the account (the refusal store's `clear`),
     * and until that happens it stands.
     *
     * It has to be said here, before the two rules below, because both of them would wave it through. An
     * organization that has switched Claude Code off for a seat changes nothing else about the account: the
     * token still authenticates, so `needsReauth` stays false, and the plan's usage endpoint still publishes
     * pools, so a fresh reading lands within the minute with room to spare. That is the exact combination the
     * `auth` rule reads as "authenticated fine since", which is how a live refusal was dismissed by the very
     * next quota sweep, leaving a full green ring on the one account in the list that could not run. */
    if (refusal.kind === `entitlement`) {
        return false;
    }
    if (reading.measuredAt === undefined || reading.measuredAt <= refusal.at) {
        return false;
    }
    return refusal.kind === `auth` ? !reading.needsReauth : hasRoom(reading.percent);
};

/* WHAT HAS ANSWERED THIS REFUSAL, if anything, the clause the line ends with, and undefined while it still
 * stands. Everything hangs off WHO may answer: a native turn names the account it was serving, and only that
 * credential's later readings say anything about it. A second Claude account polling fine proves nothing about
 * the one whose token was rejected, and letting the provider's whole list answer is what put a three-hour-old
 * 401 over three accounts that were all working, dismissed by one of them, kept standing by another sitting at
 * 95%, describing neither.
 *
 * Two cases where the named account cannot answer at all. It is GONE (disconnected since, so nothing on screen
 * is what refused), which settles the refusal rather than leaving it shouting about an account the reader no
 * longer has. Or there is no list yet, mid-load, where absence means nothing has been read: that one keeps the
 * refusal standing, because "we know nothing" must not render as "it's fine now" for a frame.
 *
 * A routed turn names nobody. CLIProxyAPI picks the auth file itself and only refuses once every credential it
 * holds is cooling down, so there the provider's whole list is the honest resolution rather than a guess. */
const refusalAnswer = (refusal: ProviderRefusal, readings: readonly RefusalReading[]): string | undefined => {
    const named = readings.filter((reading) => reading.account === refusal.account);
    if (refusal.account !== undefined && named.length === 0) {
        return readings.length === 0 ? undefined : `that account is no longer connected`;
    }
    const speaking = refusal.account === undefined ? readings : named;
    return speaking.some((reading) => answersRefusal(refusal, reading)) ? REFUSAL_ANSWERED[refusal.kind] : undefined;
};

export const refusalNote = (
    refusal: ProviderRefusal | undefined,
    readings: readonly RefusalReading[],
    now: number = Date.now(),
): RefusalNote | undefined => {
    if (refusal === undefined) {
        return undefined;
    }
    const answer = refusalAnswer(refusal, readings);
    const opening = `${REFUSAL_CONDITION[refusal.kind]} ${formatAge(refusal.at, now)}`;
    return {
        line: answer === undefined ? `${opening}, ${refusal.message}` : `${opening}, ${answer}.`,
        detail: refusal.message,
        current: answer === undefined,
    };
};

/* EVERYTHING A PROVIDER HOLDS, as the readings its refusal is judged against. Both lists, because a provider's
 * connections are one list to the reader whichever mechanism holds them, and a routed refusal is answered by any
 * of them (refusalAnswer).
 *
 * RAW: the freshest poll, WITHOUT the correction spentByRefusal lays on top. That is what stops the correction
 * feeding itself. Judged on its own output, a pool it had pinned to 100 would read back as "still no room" and
 * hold the refusal up for the week the store remembers it, long after the allowance reopened.
 *
 * It is also the list the two surfaces that print a refusal used to each build for themselves, off their own
 * already-decorated rows: one rule, two copies, and the picker and the Agent tab free to describe the same event
 * differently. */
const rawReading = (account: string, attached: AccountUsage | undefined): Pick<RefusalReading, `measuredAt` | `percent`> => {
    const raw = freshest(account, attached);
    return { measuredAt: raw?.measuredAt, percent: usagePercent(raw) };
};

const providerReadings = (provider: AgentProvider): readonly RefusalReading[] => [
    ...(providerAccounts.value[provider] ?? []).map((entry) => ({
        account: entry.id,
        ...rawReading(entry.id, entry.usage),
        needsReauth: entry.needsReauth === true,
    })),
    // A routed subscription carries no reauth flag of its own: CLIProxyAPI drops an auth file it can no longer
    // refresh, so a broken one leaves the list rather than sitting in it.
    ...routedAccounts(provider).map((entry) => ({ account: entry.name, ...rawReading(entry.name, entry.usage), needsReauth: false })),
];

/* THE PROVIDER'S REFUSAL, READ AGAINST EVERYTHING THAT HAS HAPPENED SINCE, for a caller that holds a provider
 * and nothing else. The composer's account footer and the Agent tab's connection list both draw this line, and
 * `spentByRefusal` pins a pool on the same verdict, so all three come through here. */
export const refusalFor = (provider: AgentProvider, now: number = Date.now()): RefusalNote | undefined =>
    refusalNote(providerRefusals.value[provider], providerReadings(provider), now);

/* WHETHER A SPENT ALLOWANCE IS STILL THE PROVIDER'S LAST WORD ON THIS ACCOUNT, the fact spentByRefusal pins a
 * pool on, and the note above prints, from one judgement rather than two that can drift.
 *
 * Three conditions, and the middle one is where every provider but Claude used to fall out. `limit` alone, since
 * no other refusal describes a pool. Then WHO IT SPEAKS FOR: the account it names, or, when it names none, every
 * connection the provider has, because that is precisely what a routed refusal is a statement about, the
 * translator having refused only once every auth file it holds was cooling down. And then: unanswered, on the
 * one rule that answers a spent pool anywhere in this file, a reading taken since with room in it. */
const limitStandsFor = (provider: AgentProvider, account: string, reading: AccountUsage | undefined): boolean => {
    const refusal = providerRefusals.value[provider];
    if (refusal === undefined || refusal.kind !== `limit` || (refusal.account !== undefined && refusal.account !== account)) {
        return false;
    }
    /* THE READING BEING CORRECTED GETS ITS OWN SAY, ahead of the copy of it the list may or may not hold. It is
     * the same account's, only newer: a turn ending in this tab pushes a frame the accounts list, fetched
     * minutes ago, cannot know about, and an account the list has not loaded at all is not in it to speak for
     * itself. Without this, the one reading that could answer a refusal is the one that would be ignored, and a
     * pool that had just reopened would draw as full. (`needsReauth` is unread here: only a `limit` refusal
     * reaches this line, and what answers one is headroom.) */
    const readings = [
        { account, measuredAt: reading?.measuredAt, percent: usagePercent(reading), needsReauth: false },
        ...providerReadings(provider).filter((entry) => entry.account !== account),
    ];
    return refusalAnswer(refusal, readings) === undefined;
};

export interface PlanLimitSummary {
    readonly accounts: number;
    readonly counts: PlanLimitCounts;
    readonly nextResetAt: number | undefined;
    /* Only what STAYS BROKEN until a person does something, a credential that can no longer be refreshed.
     *
     * A SPENT POOL IS NOT ON THIS LIST, and used to be. It is the plan working exactly as sold: the pool refills
     * on a schedule the account already knows, nobody can hurry it, and the one useful thing to do about it is
     * wait or route elsewhere, which the translator does by itself. Calling that "needs attention" spends the
     * loudest section of the screen on the most ordinary event on it.
     *
     * The cost was structural, not just tonal. Spend is the STEADY STATE of a fleet: this sandbox holds 36
     * connections, 31 of them one provider's, and at the end of a week nearly all of them are spent at once, so
     * the section grew to 32 near-identical lines that said, one account at a time, precisely what the capacity
     * bar three inches above says in one: how many have room, and when the next pool reopens. A section that is
     * longest when everything is most normal has inverted its own meaning, and a reader who scrolls past it every
     * day is a reader who will scroll past the dead credential in it too.
     *
     * So spend is counted (the `spent` band), summarised (`nextResetAt`) and reconcilable per account (the
     * roster), and this list holds the one state none of those can resolve on its own. */
    readonly attention: readonly PlanLimitRow[];
}

export const planLimitSummary = (rows: readonly PlanLimitRow[], now: number = Date.now()): PlanLimitSummary => ({
    accounts: rows.length,
    counts: countBands(rows),
    nextResetAt: nextReset(rows, now),
    attention: rows.filter((row) => row.needsReauth),
});
