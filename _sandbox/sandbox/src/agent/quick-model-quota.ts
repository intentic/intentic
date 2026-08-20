import { KeyedProviderSchema, type QuickModelChoice } from "@intentic/sandbox-contract";
import type { Services } from "../composition.js";

/* WHAT THE RECORDED QUOTA ALREADY SAYS ABOUT A RUNG, BEFORE ANYTHING IS SPENT ON IT.
 *
 * The walk next door learned which models were refusing by asking them and being refused, one wasted call per
 * rung per window, re-bought every time the memo expired. For most providers that is a fact we already hold:
 * every connected account's headroom is on file, refreshed in the background, and it carries the provider's OWN
 * renewal instant. Measured on this workspace the day this was written: the ChatGPT plan read 100% of its weekly
 * pool with a renewal three days out, and a single landing still spent three attempts on it, each answered 429.
 * Nothing had to be discovered. It was written down.
 *
 * So a rung whose every account is spent is stepped over on the READING, and comes back when the provider said
 * it would rather than when a timer we invented runs out. The refusal memo stays underneath as the fallback it
 * always should have been: providers that publish no quota (Grok, a user's own endpoint), a snapshot that never
 * refreshed, and the refusals that were never about allowance at all, a revoked token, an outage, or a vendor
 * that objects to the request and answers with a quota-shaped error anyway (Google does exactly this).
 *
 * IT ONLY EVER SAYS "SPENT", never "healthy". A reading with headroom means the allowance is not the blocker,
 * not that the call will work, so `undefined` here is "nothing on file stands in the way", which is also what
 * an unmeasured provider, an unreachable translator and an endpoint all answer. Every one of those goes on to
 * be asked, which is the safe direction: the cost of asking is one call, and the cost of wrongly skipping is a
 * helper that does nothing while an account sits ready. */

export interface SpentRung {
    // The sentence the walk reports this rung as skipped with, it reaches the user in the landing report, so it
    // says which allowance and when it comes back, not which internal reading produced it.
    readonly reason: string;
    readonly reopensAt?: number;
}

/* Claude's pools, split by whether they gate THIS call. `five_hour` and `seven_day` are the plan's undivided
 * allowances and every model spends them. The rest are scoped, `model:Fable`, `surface:…`, and a scoped pool
 * cannot be matched to the model id we are about to run: the provider names those pools by display name and
 * nothing connects the two (claude-usage.ts says so where it maps them). A per-model pool at 100% therefore
 * proves nothing about the cheap model this helper runs, so it is not allowed to block it. Erring this way costs
 * one call; erring the other way silently retires the most reliable rung in the chain. */
const GATES_EVERY_CLAUDE_CALL = new Set([`five_hour`, `seven_day`]);

// How long until it comes back, in words, because the daemon cannot know the reader's timezone and an absolute
// instant formatted in the container's would be wrong for most of them. Deliberately vague at every scale, the
// number is a snapshot of a provider's own estimate, and stating it to the minute would overclaim it.
const inWords = (reopensAt: number, now: number): string => {
    const seconds = reopensAt - Math.floor(now / 1000);
    if (seconds <= 60) {
        return `any moment`;
    }
    if (seconds < 60 * 60) {
        return `in about ${Math.round(seconds / 60)} min`;
    }
    if (seconds < 36 * 60 * 60) {
        return `in about ${Math.round(seconds / 3600)}h`;
    }
    return `in about ${Math.round(seconds / 86_400)} days`;
};

const spentSentence = (subject: string, pool: string | undefined, reopensAt: number | undefined, now: number): string => {
    const allowance = pool === undefined ? `allowance` : `${pool} allowance`;
    const renews = reopensAt === undefined ? `` : ` — renews ${inWords(reopensAt, now)}`;
    return `${subject} out of ${allowance}${renews}.`;
};

/* A ROUTED PROVIDER'S FLEET, from the translator's own reading, already scoped to the pool this model spends,
 * which is the part that cannot be re-derived here. Google meters Gemini separately from the Claude/GPT models
 * on one sign-in, so "is the fleet spent" is only answerable per model, and turnLimit is where that lives.
 *
 * `withHeadroom > 0` ⇒ some account can serve it, so the allowance is not the blocker. Both counts zero ⇒
 * nothing on file measures this pool, which is the unmeasured case and not a block. */
const spentRoutedRung = async (services: Services, choice: QuickModelChoice, now: number): Promise<SpentRung | undefined> => {
    const provider = KeyedProviderSchema.safeParse(choice.provider);
    if (!provider.success) {
        return undefined;
    }
    const limit = await services.cliProxy.turnLimit(provider.data, choice.model).catch(() => undefined);
    if (limit === undefined || limit.withHeadroom > 0 || limit.spent === 0) {
        return undefined;
    }
    const accounts = limit.spent === 1 ? `The connected account is` : `All ${limit.spent} connected accounts are`;
    return {
        reason: spentSentence(accounts, limit.pool, limit.reopensAt, now),
        ...(limit.reopensAt === undefined ? {} : { reopensAt: limit.reopensAt }),
    };
};

/* NATIVE CLAUDE'S ACCOUNTS, from the same store the account picker ranks by. The picker already prefers the
 * account with the most room, so this only has something to say when EVERY account is at its cap, the one case
 * the picker cannot rescue, and the one where the call is certain to be refused.
 *
 * An account with no reading is not counted as spent, and that is what keeps a fresh sandbox (nothing measured
 * yet) from skipping its own Claude rung on no evidence. */
const spentClaudeRung = async (services: Services, now: number): Promise<SpentRung | undefined> => {
    const [connected, usage] = await Promise.all([services.claudeStore.list(), services.accountUsage.read()]);
    if (connected.length === 0) {
        return undefined;
    }
    const resets: number[] = [];
    let measured = 0;
    for (const account of connected) {
        const windows = (usage[account.id]?.windows ?? []).filter((window) => GATES_EVERY_CLAUDE_CALL.has(window.kind));
        if (windows.length === 0) {
            // Unmeasured, so unproven, one such account is enough for the rung to be worth asking.
            return undefined;
        }
        measured += 1;
        const exhausted = windows.filter((window) => window.utilization >= 100);
        if (exhausted.length === 0) {
            return undefined;
        }
        resets.push(...exhausted.flatMap((window) => (window.resetsAt === undefined ? [] : [window.resetsAt])));
    }
    if (measured === 0) {
        return undefined;
    }
    // The earliest, because any one account reopening is enough to unblock the rung.
    const reopensAt = resets.length === 0 ? undefined : Math.min(...resets);
    const accounts = measured === 1 ? `The connected Claude account is` : `All ${measured} connected Claude accounts are`;
    return { reason: spentSentence(accounts, undefined, reopensAt, now), ...(reopensAt === undefined ? {} : { reopensAt }) };
};

/* Is this rung known-spent right now? Undefined ⇒ ask it.
 *
 * Never throws: every reading behind this is a convenience, and a helper that died because a quota lookup did
 * would be strictly worse than one that spent a call finding out the ordinary way. */
export const spentRung = async (services: Services, choice: QuickModelChoice, now: number = Date.now()): Promise<SpentRung | undefined> => {
    const spent = choice.provider === `claude` ? spentClaudeRung(services, now) : spentRoutedRung(services, choice, now);
    return spent.catch(() => undefined);
};
