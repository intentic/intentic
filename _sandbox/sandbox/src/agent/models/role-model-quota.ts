import type { FleetCapacity } from "@intentic/sandbox-contract/models/plan-pools";
import type { ModelChoice } from "@intentic/sandbox-contract/models/model-pins";
import { renewsInWords } from "@intentic/sandbox-contract/models/model-offer";
import type { Services } from "../../composition.js";
import { fleetCapacityOf } from "../../usage/serviceability/serviceability.js";

// Reads a rung's capacity on file instead of discovering it by asking and being refused: a rung no connected account can
// serve is stepped over, judged by the one rule the spawn listing, the account rows and the picker read (fleetCapacityOf),
// so a gate never refuses what the listing offers, nor lets through what it calls spent. Only ever says spent —
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

/** A rung's capacity on file, or undefined where the read failed: a failed lookup never fails the helper, it asks. */
export const rungCapacity = async (services: Services, choice: ModelChoice, now: number = Date.now()): Promise<FleetCapacity | undefined> =>
    // allow(silent-catch): a failed quota lookup should not fail the helper; it falls through to asking normally.
    fleetCapacityOf(services, choice.provider, choice.model === "" ? undefined : { id: choice.model }, now).catch(() => undefined);

// Whether a rung is known-spent; undefined means ask it.
export const spentRung = async (services: Services, choice: ModelChoice, now: number = Date.now()): Promise<SpentRung | undefined> => {
    const capacity = await rungCapacity(services, choice, now);
    if (capacity?.kind !== "spent") {
        return undefined;
    }
    const vendor = choice.provider === `claude` ? ` Claude` : ``;
    const accounts = capacity.accounts === 1 ? `The connected${vendor} account is` : `All ${capacity.accounts} connected${vendor} accounts are`;
    return {
        reason: spentSentence(accounts, capacity.pool, capacity.reopensAt, now),
        ...(capacity.reopensAt === undefined ? {} : { reopensAt: capacity.reopensAt }),
    };
};
