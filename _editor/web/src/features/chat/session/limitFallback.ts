import { type AgentProvider, type ModelRef, type OauthAccount, roomiestAccount } from "@intentic/sandbox-contract";
import { accountFacts, accountState } from "./usageStatus";

// Offers an account with headroom to continue a refused turn on, as a free alternative to the session-limit reset
// (limitReset.ts), which reopens the same account's window via a weekly grant instead. The same verdict and the same
// pick the daemon's own limit move makes (accountState, roomiestAccount): a revoked, seatless, refused, spent or
// unmeasured account is never offered, and a just-refused account reads as spent at once, before its next poll.

// Account to continue this conversation on, or undefined when none qualifies. Picks the emptiest account first, not
// the first-connected, so one refusal doesn't chain into three; ties keep the list's order for a stable re-render.
export const fallbackAccount = (
    provider: AgentProvider,
    current: string | undefined,
    accounts: readonly OauthAccount[],
    model?: ModelRef,
): OauthAccount | undefined =>
    roomiestAccount(
        accounts.filter((account) => account.id !== current).map((account) => ({ account, state: accountState(provider, accountFacts(account), model) })),
    )?.account;

// Short identifier for a button: the email's local part when there is one, otherwise the label — the fallback for
// a credential with no identity of its own, such as a pasted API key.
export const fallbackLabel = (account: OauthAccount): string => account.email?.split(`@`)[0] ?? account.label;
