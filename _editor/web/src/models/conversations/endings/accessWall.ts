import type { AgentProvider } from "@intentic/sandbox-contract/schemas/agent";
import type { AccountState } from "@intentic/sandbox-contract/schemas/providers/plan-limits";
import { computed, type ComputedRef } from "vue";
import { usePaneView } from "../panel/useChat-view";
import { anotherProviderReady } from "../../providers/access";
import { accountFacts, accountState } from "../../providers/usageStatus";

/* WHEN A PERSON IS TRULY NEEDED. A provider refused the conversation's account outright (its organization or plan turned
   access off), and no other account of that provider can serve it. Where another one can, the sandbox moves the
   conversation by itself on the next press (the daemon's blocked-account route), so pressing on is right. Where none can,
   pressing on only sends the message into the same refusal: the daemon re-tests the account with one tiny request and
   holds the message again. The way on is then something only a person can do: connect another account, or pick a model
   of another provider. Every surface that offers a press after such a refusal reads this one answer, so the fix is the
   bright press and a retry never is (2026-10-28: a bright Continue would have re-sent into the wall). */

// The codes a provider refuses an account itself with: the daemon's held turn, and a runtime's own refusal.
const ACCESS_REFUSALS: ReadonlySet<string> = new Set([`claude-not-entitled`, `account-not-entitled`]);

export interface AccessWall {
    readonly provider: AgentProvider;
    // The refused account by its own name; undefined where this window's account list cannot name it.
    readonly account: string | undefined;
    // Another provider the person may run on is connected: picking a model there is the way on that needs nobody else.
    readonly elsewhere: boolean;
}

export interface WallFacts {
    // How the conversation's last turn failed, as its board card says; cleared once a turn runs again.
    readonly failureCode: string | undefined;
    readonly provider: AgentProvider;
    // The account the next turn would run on, and its verdict.
    readonly serving: { readonly id: string | undefined; readonly state: AccountState | undefined };
    // Every connected account of the provider, with its verdict.
    readonly accounts: readonly { readonly id: string; readonly label: string; readonly state: AccountState }[];
    readonly elsewhere: boolean;
}

// An account a turn may go to: one with room, or one nothing has measured or refused.
const serves = (state: AccountState | undefined): boolean => state?.kind === `ready` || state?.kind === `unknown`;

/**
 * The wall, where it stands: the last turn was refused for access, the account the next one would run on cannot serve
 * either (a person who picked another account in the composer has already found the way on), and no other account of
 * the provider can.
 */
export const accessWallOf = (facts: WallFacts): AccessWall | undefined => {
    if (facts.failureCode === undefined || !ACCESS_REFUSALS.has(facts.failureCode) || serves(facts.serving.state)) {
        return undefined;
    }
    if (facts.accounts.some((account) => account.id !== facts.serving.id && serves(account.state))) {
        return undefined;
    }
    return { provider: facts.provider, account: facts.accounts.find((account) => account.id === facts.serving.id)?.label, elsewhere: facts.elsewhere };
};

/** This pane's wall, read off its conversation's card, pick and accounts. */
export const useAccessWall = (): ComputedRef<AccessWall | undefined> => {
    const { lastFailure, provider, model, accounts, servingAccount, servingState } = usePaneView();
    return computed(() => {
        const failureCode = lastFailure.value?.code;
        // Asked of every account only after a refusal for access: every other chat pays one set lookup.
        if (failureCode === undefined || !ACCESS_REFUSALS.has(failureCode)) {
            return undefined;
        }
        const spends = model.value === `` ? undefined : { id: model.value };
        return accessWallOf({
            failureCode,
            provider: provider.value,
            serving: { id: servingAccount.value, state: servingState.value },
            accounts: accounts.value.map((account) => ({ id: account.id, label: account.label, state: accountState(provider.value, accountFacts(account), spends) })),
            elsewhere: anotherProviderReady(provider.value),
        });
    });
};
