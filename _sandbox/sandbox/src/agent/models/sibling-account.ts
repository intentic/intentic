import type { AgentProvider } from "@intentic/sandbox-contract/schemas/agent";
import { roomiestAccount } from "@intentic/sandbox-contract/models/plan-pools";
import type { Services } from "../../composition.js";
import { accountFactsOf, serviceabilities, type ServiceabilityDeps } from "../../usage/serviceability/serviceability.js";
import { pickAccount, type PlannerDeps } from "../run/spend/budget-planner.js";
import { breakPolicyFor } from "../run/turn/break-policy.js";

// Claude-only: a routed provider balances its own credentials before refusing, so a refusal there already means nothing
// is left. Picks among the accounts the one serviceability rule calls ready with room: a revoked, seatless, benched,
// refused, spent or unmeasured account is never a move's destination, however idle its meter looks. Of those, the one
// the fan-out planner projects left with the most room once this turn and what already runs there are on it (ten
// children once moved together onto the account reading most room and emptied it in thirty minutes, 2026-10-20); the
// roomiest by its reading where the planner cannot say.
export const siblingWithRoom = async (
    services: ServiceabilityDeps & Partial<PlannerDeps>,
    params: { readonly provider: AgentProvider; readonly model: string | undefined; readonly refused: string | undefined },
): Promise<string | undefined> => {
    if (params.provider !== "claude") {
        return undefined;
    }
    const model = params.model === undefined || params.model === "" ? undefined : { id: params.model };
    const accounts = (await serviceabilities(services, "claude", model).catch(() => [])).filter((account) => account.id !== params.refused);
    const roomiest = roomiestAccount(accounts)?.id;
    const planned = model === undefined ? undefined : await plannedSibling(services, model.id, params.refused);
    return planned !== undefined && accounts.some((account) => account.id === planned) ? planned : roomiest;
};

// The planner's pick, where this caller's services carry what it projects from.
const plannedSibling = async (services: ServiceabilityDeps & Partial<PlannerDeps>, model: string, refused: string | undefined): Promise<string | undefined> => {
    const { burnRates, runOuts, sandboxSettings, providerRefusals } = services;
    if (burnRates === undefined || runOuts === undefined || sandboxSettings === undefined) {
        return undefined;
    }
    const readings = await accountFactsOf(services, "claude");
    // allow(silent-catch): the planner is advice for which ready account to move to; the roomiest by reading still answers.
    return pickAccount({ burnRates, runOuts, sandboxSettings, providerRefusals }, { provider: "claude", model, readings, refused }).catch(() => undefined);
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
        // The hand-off already worked out for this hold (limit-handoff.ts): whether its way on carries the session.
        readonly carry?: boolean | undefined;
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
    const carry =
        params.ran &&
        params.carryRefused !== true &&
        (params.carry ?? (params.contextTokens !== undefined && params.contextTokens < limitMoveCarryUnder));
    return { account, carry };
};
