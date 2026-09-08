import { type AccountUsage, type AgentProvider, bindingWindow, type ModelRef, type OauthAccount, SPENT_UTILIZATION } from "@intentic/sandbox-contract";
import type { Services } from "../../composition.js";
import { moveAfterLimitArmed } from "../run/turn/turn-resume.js";

// Claude-only: a routed provider balances its own credentials before refusing, so a refusal there already means nothing
// is left. Picks the emptiest account with an actual reading, skipping the refused, unmeasured, and dead ones.
export const siblingWithRoom = async (
    services: Pick<Services, "claudeStore" | "accountUsage">,
    params: { readonly provider: AgentProvider; readonly model: string | undefined; readonly refused: string | undefined },
): Promise<string | undefined> => {
    if (params.provider !== "claude") {
        return undefined;
    }
    const [accounts, usage] = await Promise.all([
        services.claudeStore.list().catch(() => []),
        services.accountUsage.read().catch((): Record<string, AccountUsage> => ({})),
    ]);
    const model = params.model === undefined || params.model === "" ? undefined : { id: params.model };
    const candidates = accounts.flatMap((account) => {
        const utilization = roomOf(account, usage[account.id], model, params.refused);
        return utilization === undefined ? [] : [{ id: account.id, utilization }];
    });
    return candidates.reduce<(typeof candidates)[number] | undefined>(
        (best, candidate) => (best === undefined || candidate.utilization < best.utilization ? candidate : best),
        undefined,
    )?.id;
};

// One account's room for the model, from its fullest gating window; undefined for the refused, dead, unmeasured, or
// capped account.
const roomOf = (account: OauthAccount, usage: AccountUsage | undefined, model: ModelRef | undefined, refused: string | undefined): number | undefined => {
    if (account.id === refused || account.needsReauth === true) {
        return undefined;
    }
    const window = bindingWindow(usage, model);
    return window === undefined || window.utilization >= SPENT_UTILIZATION ? undefined : window.utilization;
};

// Where a held turn moves to, decided once at the failure; undefined means no policy applies or no account has room.
// `carry` requires the turn to have run, a known context under the owner's line, and not already refused elsewhere.
export const bookLimitMove = async (
    services: Pick<Services, "claudeStore" | "accountUsage" | "agents" | "sandboxSettings">,
    params: {
        readonly conversationId: string;
        readonly provider: AgentProvider;
        readonly model: string | undefined;
        readonly refused: string | undefined;
        readonly ran: boolean;
        readonly contextTokens: number | undefined;
        readonly carryRefused?: boolean | undefined;
    },
): Promise<{ readonly account: string; readonly carry: boolean } | undefined> => {
    if (!(await moveAfterLimitArmed(services, params.conversationId))) {
        return undefined;
    }
    const account = await siblingWithRoom(services, params);
    if (account === undefined) {
        return undefined;
    }
    const { limitMoveCarryUnder } = await services.sandboxSettings.get();
    const carry = params.ran && params.carryRefused !== true && params.contextTokens !== undefined && params.contextTokens < limitMoveCarryUnder;
    return { account, carry };
};
