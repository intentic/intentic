import { KeyedProviderSchema, type ModelChoice, renewsInWords } from "@intentic/sandbox-contract";
import type { Services } from "../../composition.js";
import { askableLimit, type TurnLimit } from "../../usage/serviceability/fleet-limit.js";
import { accountFactsOf } from "../../usage/serviceability/serviceability.js";
import { observedOwnLimit } from "../../usage/observed-accounts.js";

// Reads a rung's recorded quota instead of discovering it by asking and being refused; a rung whose every account is
// spent is stepped over on that reading, scoped per-model through fleet-limit's own gates. Only ever says spent —
// undefined means nothing on file blocks the call.

export interface SpentRung {
    // Sentence shown to the user in the landing report: names the allowance and when it reopens.
    readonly reason: string;
    readonly reopensAt?: number;
}

const spentSentence = (subject: string, pool: string | undefined, reopensAt: number | undefined, now: number): string => {
    const allowance = pool === undefined ? `allowance` : `${pool} allowance`;
    const renews = reopensAt === undefined ? `` : `, renews ${renewsInWords(reopensAt, now)}`;
    return `${subject} out of ${allowance}${renews}.`;
};

// Async, so a store that throws as it is called rejects beside the facts read alongside it instead of stranding them.
const refusalsOnFile = async (services: Services): Promise<Awaited<ReturnType<Services["providerRefusals"]["onFile"]>>> => services.providerRefusals.onFile();

// Fleet reading for a rung, or undefined when no quota is on file or the reading failed. Spent only when every connected
// account is at cap; an unmeasured account keeps the rung askable. Claude's and a routed provider's accounts are judged
// on the very facts and refusals the account rows and the spawn listing publish (askableLimit), so a gate never refuses
// what the listing offers, nor lets through what it calls spent.
export const rungLimit = async (services: Services, choice: ModelChoice): Promise<TurnLimit | undefined> => {
    try {
        if (choice.provider === `claude` || KeyedProviderSchema.safeParse(choice.provider).success) {
            const [facts, refusals] = await Promise.all([accountFactsOf(services, choice.provider), refusalsOnFile(services)]);
            return facts.length === 0 ? undefined : askableLimit(facts, { id: choice.model }, refusals[choice.provider]);
        }
        // A provider keeping its own reading (Cursor's, what it has already refused, per account and per model) answers
        // for itself; read from the pool instead, one account's spent Composer would bench the rung for every account.
        const module = services.providerModules.find((candidate) => candidate.id === choice.provider);
        if (module?.turnLimit !== undefined) {
            return await module.turnLimit(services, choice.model);
        }
        // Left: a provider authenticating on its own with no reading of its own either (Devin). Its ledger is still the
        // one measurement it can have, whether a refused turn filed it or somebody marked it by hand.
        const own = await observedOwnLimit(services, choice.provider);
        return own === undefined ? undefined : await own(choice.model);
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
