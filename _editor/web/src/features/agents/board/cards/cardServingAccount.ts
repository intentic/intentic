import type { AgentProvider } from "@intentic/sandbox-contract/schemas/agent";
import type { OauthAccount } from "@intentic/sandbox-contract/schemas/providers/provider-oauth";
import type { ServingAccount } from "../../../../models/agent-status/agentStatus-chips";
import { accountFacts, accountState } from "../../../../models/providers/usageStatus";

/**
 * The account a card runs on now, judged by the same verdict the picker reads (accountState): ready or unmeasured
 * serves, anything else does not. Undefined where the card names no account, or one this window has no row for. Kept
 * here rather than in models/agent-status, which the account verdicts' own layer depends on.
 */
export const cardServingAccount = (provider: AgentProvider, account: string | undefined, accounts: readonly OauthAccount[]): ServingAccount | undefined => {
    const row = account === undefined ? undefined : accounts.find((entry) => entry.id === account);
    if (row === undefined) {
        return undefined;
    }
    const kind = accountState(provider, accountFacts(row)).kind;
    return { label: row.label, serves: kind === `ready` || kind === `unknown` };
};
