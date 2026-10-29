import type { AgentProvider } from "@intentic/sandbox-contract/schemas/agent";
import { reportsPlanLimits } from "@intentic/sandbox-contract/models/agent-catalog";
import { moveDestination } from "@intentic/sandbox-contract/models/account-moves";
import type { ModelRef } from "@intentic/sandbox-contract/models/plan-pools";
import type { OauthAccount } from "@intentic/sandbox-contract/schemas/providers/provider-oauth";
import { accountFacts, accountState } from "../../../models/providers/usageStatus";

// Offers an account to continue a refused turn on, as a free alternative to the session-limit reset (limitReset.ts), which
// reopens the same account's window via a weekly grant instead. The same verdict and the same pick the daemon's own limit
// move makes (accountState, account-moves.ts moveDestination): a revoked, seatless, refused or spent account is never
// offered, and a just-refused account reads as spent at once, before its next poll. An unmeasured one is offered only
// where the provider publishes no allowance to measure (Devin, Cursor, the minted keys): a Devin chat refused for its
// weekly quota was offered nothing, with two accounts beside it that nothing had refused (2026-10-29).

// Account to continue this conversation on, or undefined when none qualifies. Picks the emptiest account first, not
// the first-connected, so one refusal doesn't chain into three; ties keep the list's order for a stable re-render.
export const fallbackAccount = (
    provider: AgentProvider,
    current: string | undefined,
    accounts: readonly OauthAccount[],
    model?: ModelRef,
): OauthAccount | undefined =>
    moveDestination(
        accounts.filter((account) => account.id !== current).map((account) => ({ account, state: accountState(provider, accountFacts(account), model) })),
        reportsPlanLimits(provider),
    )?.account;

// Short identifier for a button: the email's local part when there is one, otherwise the label — the fallback for
// a credential with no identity of its own, such as a pasted API key.
export const fallbackLabel = (account: OauthAccount): string => account.email?.split(`@`)[0] ?? account.label;
