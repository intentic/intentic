import { type AgentProvider, roomiestAccount } from "@intentic/sandbox-contract";
import type { Services } from "../../composition.js";
import { serviceabilities, type ServiceabilityDeps } from "../../usage/serviceability.js";
import { breakPolicyFor } from "../run/turn/turn-resume.js";

// Claude-only: a routed provider balances its own credentials before refusing, so a refusal there already means nothing
// is left. Picks the roomiest account the one serviceability rule calls ready: a revoked, seatless, benched, refused,
// spent or unmeasured account is never a move's destination, however idle its meter looks.
export const siblingWithRoom = async (
    services: ServiceabilityDeps,
    params: { readonly provider: AgentProvider; readonly model: string | undefined; readonly refused: string | undefined },
): Promise<string | undefined> => {
    if (params.provider !== "claude") {
        return undefined;
    }
    const model = params.model === undefined || params.model === "" ? undefined : { id: params.model };
    const accounts = await serviceabilities(services, "claude", model).catch(() => []);
    return roomiestAccount(accounts.filter((account) => account.id !== params.refused))?.id;
};

// Where a held turn moves to, decided once at the failure; undefined means no policy applies or no account has room.
// `carry` requires the turn to have run, a known context under the owner's line, and not already refused elsewhere.
export const bookLimitMove = async (
    services: ServiceabilityDeps & Pick<Services, "agents" | "sandboxSettings">,
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
    if ((await breakPolicyFor(services, params.conversationId, "limit")) !== "move") {
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
