import { KeyedProviderSchema, type QuickModelChoice } from "@intentic/sandbox-contract";
import type { Services } from "../composition.js";
import { fleetLimit, type TurnLimit } from "../usage/fleet-limit.js";

/* WHAT THE RECORDED QUOTA ALREADY SAYS ABOUT A RUNG, BEFORE ANYTHING IS SPENT ON IT.
 *
 * The walk next door learned which models were refusing by asking them and being refused, one wasted call per
 * rung per window, re-bought every time the memo expired. For most providers that is a fact we already hold:
 * every connected account's headroom is on file, refreshed whenever something happened to it, and it carries
 * the provider's OWN renewal instant. Measured on this workspace the day this was written: the ChatGPT plan
 * read 100% of its weekly pool with a renewal three days out, and a single landing still spent three attempts
 * on it, each answered 429. Nothing had to be discovered. It was written down.
 *
 * So a rung whose every account is spent is stepped over on the READING, and comes back when the provider said
 * it would rather than when a timer we invented runs out. The refusal memo stays underneath as the fallback it
 * always should have been: providers that publish no quota (Grok, a user's own endpoint), a snapshot that never
 * refreshed, and the refusals that were never about allowance at all, a revoked token, an outage, or a vendor
 * that objects to the request and answers with a quota-shaped error anyway (Google does exactly this).
 *
 * ONE RULE FOR EVERY PROVIDER (usage/fleet-limit.ts), scoped to the pools this rung's MODEL spends through the
 * windows' own gates: a Claude account whose Opus slice is full still answers a Haiku call, and a Google
 * account spent for Gemini still serves Claude Opus. The two readings differ only in where the accounts come
 * from: Claude's from its own store, a routed provider's from the translator, which also carries the proxy's
 * own bench of each credential.
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
    const renews = reopensAt === undefined ? `` : `, renews ${inWords(reopensAt, now)}`;
    return `${subject} out of ${allowance}${renews}.`;
};

/* THE FLEET'S READING FOR THIS RUNG, or undefined for a provider nothing on file describes (an endpoint, Grok,
 * Cursor) or a reading that could not be taken. The walk reads it twice over: to step a spent rung over, and
 * to let a memo of a refusal yield to a reading taken since (`roomMeasuredAt`).
 *
 * Claude's accounts count as spent only when EVERY connected one is at its cap, and an account with no reading
 * keeps the rung askable: a fresh sandbox has measured nothing, and unmeasured is not spent, or the feature
 * would disable itself before it had ever run a turn. The translator's fleet is read the same way through its
 * own reader (turnLimit), which folds in the proxy's own bench of each credential. */
export const rungLimit = async (services: Services, choice: QuickModelChoice): Promise<TurnLimit | undefined> => {
    try {
        if (choice.provider === `claude`) {
            const [connected, usage] = await Promise.all([services.claudeStore.list(), services.accountUsage.read()]);
            if (connected.length === 0) {
                return undefined;
            }
            const limit = fleetLimit(
                connected.map((account) => ({ account: account.id, usage: usage[account.id] })),
                { id: choice.model },
            );
            // One unmeasured account is one that may answer: report the fleet as not spent rather than as
            // "spent by everyone who was measured".
            return limit.spent + limit.withHeadroom < connected.length ? { ...limit, withHeadroom: limit.withHeadroom + 1 } : limit;
        }
        const provider = KeyedProviderSchema.safeParse(choice.provider);
        return provider.success ? await services.cliProxy.turnLimit(provider.data, choice.model) : undefined;
    } catch {
        // Every reading behind this is a convenience, and a helper that died because a quota lookup did would
        // be strictly worse than one that spent a call finding out the ordinary way.
        return undefined;
    }
};

/* Is this rung known-spent right now? Undefined ⇒ ask it.
 *
 * `withHeadroom > 0` ⇒ some account can serve it, so the allowance is not the blocker. Both counts zero ⇒
 * nothing on file measures this pool, which is the unmeasured case and not a block. */
export const spentRung = async (services: Services, choice: QuickModelChoice, now: number = Date.now()): Promise<SpentRung | undefined> => {
    const limit = await rungLimit(services, choice);
    if (limit === undefined || limit.withHeadroom > 0 || limit.spent === 0) {
        return undefined;
    }
    const vendor = choice.provider === `claude` ? ` Claude` : ``;
    const accounts = limit.spent === 1 ? `The connected${vendor} account is` : `All ${limit.spent} connected${vendor} accounts are`;
    return {
        reason: spentSentence(accounts, limit.pool, limit.reopensAt, now),
        ...(limit.reopensAt === undefined ? {} : { reopensAt: limit.reopensAt }),
    };
};
