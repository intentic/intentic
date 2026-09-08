import { KeyedProviderSchema, type ModelChoice } from "@intentic/sandbox-contract";
import type { Services } from "../../composition.js";
import { fleetLimit, type TurnLimit } from "../../usage/fleet-limit.js";

// Reads a rung's recorded quota instead of discovering it by asking and being refused; a rung whose every account is
// spent is stepped over on that reading, scoped per-model through fleet-limit's own gates. Only ever says spent —
// undefined means nothing on file blocks the call.

export interface SpentRung {
    // Sentence shown to the user in the landing report: names the allowance and when it reopens.
    readonly reason: string;
    readonly reopensAt?: number;
}

// Relative phrasing (a provider's own renewal estimate), since an absolute instant would need the reader's timezone;
// deliberately coarse at every scale.
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

// Fleet reading for a rung, or undefined when no quota is on file or the reading failed. Claude counts spent only when
// every connected account is at cap; an unmeasured account keeps the rung askable.
export const rungLimit = async (services: Services, choice: ModelChoice): Promise<TurnLimit | undefined> => {
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
            // An unmeasured account may still answer, so it counts as headroom rather than as spent.
            return limit.spent + limit.withHeadroom < connected.length ? { ...limit, withHeadroom: limit.withHeadroom + 1 } : limit;
        }
        const provider = KeyedProviderSchema.safeParse(choice.provider);
        return provider.success ? await services.cliProxy.turnLimit(provider.data, choice.model) : undefined;
    } catch {
        // A failed quota lookup should not fail the helper; fall through to asking normally.
        return undefined;
    }
};

// Whether a rung is known-spent; undefined means ask it. withHeadroom>0 means some account can serve it; both counts
// zero means the pool is unmeasured, not blocked.
export const spentRung = async (services: Services, choice: ModelChoice, now: number = Date.now()): Promise<SpentRung | undefined> => {
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
