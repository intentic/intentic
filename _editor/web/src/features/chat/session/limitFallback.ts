import type { AgentProvider, ModelRef, OauthAccount } from "@intentic/sandbox-contract";
import { SPENT_PERCENT, usagePercent, usageStatusFor } from "./usageStatus";

// Offers an account with headroom to continue a refused turn on, as a free alternative to the session-limit reset
// (limitReset.ts), which reopens the same account's window via a weekly grant instead. usageStatusFor folds in
// refusals, so a just-refused account reads as spent here immediately, before its own next poll would show it.

// An offerable account and the headroom that qualified it.
interface Candidate {
    readonly account: OauthAccount;
    readonly percent: number;
}

const offerable = (provider: AgentProvider, model: ModelRef | undefined, account: OauthAccount): Candidate | undefined => {
    // A credential needing reauth is not headroom, even if its last poll said otherwise.
    if (account.needsReauth === true) {
        return undefined;
    }
    const percent = usagePercent(usageStatusFor(provider, account.id, model), model);
    return percent !== undefined && percent < SPENT_PERCENT ? { account, percent } : undefined;
};

// Account to continue this conversation on, or undefined when none qualifies. Picks the emptiest account first, not
// the first-connected, so one refusal doesn't chain into three; ties keep the list's order for a stable re-render.
export const fallbackAccount = (
    provider: AgentProvider,
    current: string | undefined,
    accounts: readonly OauthAccount[],
    model?: ModelRef,
): OauthAccount | undefined => {
    const candidates = accounts
        .filter((account) => account.id !== current)
        .map((account) => offerable(provider, model, account))
        .filter((candidate): candidate is Candidate => candidate !== undefined);
    return candidates.reduce<Candidate | undefined>(
        (best, candidate) => (best === undefined || candidate.percent < best.percent ? candidate : best),
        undefined,
    )?.account;
};

// Short identifier for a button: the email's local part when there is one, otherwise the label — the fallback for
// a credential with no identity of its own, such as a pasted API key.
export const fallbackLabel = (account: OauthAccount): string => account.email?.split(`@`)[0] ?? account.label;
