import type { AgentProvider } from "@intentic/sandbox-contract/schemas/agent";
import type { AccountState } from "@intentic/sandbox-contract/schemas/providers/plan-limits";
import { type RefusalsOnFile, serviceStates, standingOver } from "@intentic/sandbox-contract/models/plan-pools";
import { sandboxNow } from "../../agent-status/sandboxClock";
import { type AccountFacts, providerFacts, refusalsOf } from "./doorFacts";

/* ONE JUDGEMENT OF A PROVIDER FOR ALL ITS ROWS (usageStatus.ts planLimitRows). accountState and liveUsage each judge the
   account's whole provider, since a refusal naming no account is answered by any of them, so a list of N accounts built
   from them judged the provider 2N times over: 30 accounts took 26 ms a call, the chat's capacity rail made three calls
   whenever any reading moved, and the garbage they left was most of what an idle window allocated (2026-11-21). A row
   whose account the provider's facts list once, exactly as the row's own facts (doorFacts.ts factsOf) hold it, changes
   nothing either judgement reads, so it reads the provider's one judgement. Any other row (an account connected a moment
   ago that no capacity has judged yet, or a caller's accounts that are not the stores') is judged alone, as before. */
export interface ProviderJudgement {
    readonly facts: readonly AccountFacts[];
    // Every account's verdict with no model named, as accountState reaches it.
    readonly states: ReadonlyMap<string, AccountState>;
    // The refusals standing over each account, as liveUsage lays them on its reading.
    readonly standing: (account: string) => RefusalsOnFile;
}

const judgeProvider = (provider: AgentProvider, now: number): ProviderJudgement => {
    const at = sandboxNow(now);
    const facts = providerFacts(provider);
    const refusals = refusalsOf(provider);
    return { facts, states: serviceStates(facts, refusals, undefined, at), standing: standingOver(facts, refusals, at) };
};

/** Each provider judged once, on first asking, at `now` (this browser's clock): for one pass over many rows. */
export const judgementsAt = (now: number): ((provider: AgentProvider) => ProviderJudgement) => {
    const judged = new Map<AgentProvider, ProviderJudgement>();
    return (provider) => {
        const known = judged.get(provider) ?? judgeProvider(provider, now);
        judged.set(provider, known);
        return known;
    };
};

// Field by field; a key one side lacks reads as undefined, as the rule reads it.
const sameFacts = (left: AccountFacts, right: AccountFacts): boolean =>
    // SAFETY: every key compared is one of the two AccountFacts' own; one only a side holds reads as undefined there.
    [...new Set([...Object.keys(left), ...Object.keys(right)])].every((key) => left[key as keyof AccountFacts] === right[key as keyof AccountFacts]);

/** Whether the judgement already holds this account exactly as `held` (factsOf), so judging it alone would change nothing. */
export const heldAlike = (judgement: ProviderJudgement, held: AccountFacts): boolean => {
    const listed = judgement.facts.filter((entry) => entry.account === held.account);
    return listed.length === 1 && listed[0] !== undefined && sameFacts(listed[0], held);
};
