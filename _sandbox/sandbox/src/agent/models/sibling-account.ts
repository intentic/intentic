import type { AgentProvider } from "@intentic/sandbox-contract/schemas/agent";
import type { Services } from "../../composition.js";
import { moveDestinationFor, type PlaceDeps } from "../providers/accounts/placement.js";
import { breakPolicyFor } from "../run/turn/break-policy.js";
import { ACCOUNTS_ALL, accountReachAllows } from "../../secrets/credential-reach.js";

// Every provider whose accounts a turn can name (Claude, Cursor, Devin, the minted keys, a vendor CLI's sign-ins); a
// routed provider's gateway tries every account before refusing, so a refusal there already means nothing is left.
// Where the turn goes is the one move every subsystem makes (placement.ts moveDestinationFor): a revoked, seatless,
// benched, refused or spent account is never a move's destination, however idle its meter looks, and an unmeasured one
// only where the provider publishes no allowance to measure (Devin's refused turns were held with two unrefused accounts
// beside them until 2026-10-29). Among Claude's ready accounts, the one the fan-out planner places it on once this turn
// and what already runs there are counted (ten children once moved together onto the account reading most room and
// emptied it in thirty minutes, 2026-10-20). `allows` narrows the destinations to the accounts the people the
// conversation works for may use (account-reach.ts): a move onto any other would only be refused when it fires.
export const siblingWithRoom = (
    services: PlaceDeps,
    params: {
        readonly provider: AgentProvider;
        readonly model: string | undefined;
        readonly refused: string | undefined;
        readonly allows?: ((account: string) => boolean) | undefined;
    },
): Promise<string | undefined> => moveDestinationFor(services, params.provider, params.model, { from: params.refused, allows: params.allows });

/** What a limit move reads: the verdicts, the planner where given, and who the conversation works for. */
export type LimitMoveDeps = PlaceDeps & Partial<Pick<Services, "accountReach">>;

/**
 * Where a spent allowance's held turn moves off `refused` now: an account with room (siblingWithRoom) that every person
 * the conversation works for may use; an unreadable roster allows none, so it holds. Asked at the failure, where it books
 * the move, and by the resume pass once the account the move was booked onto is spent itself (held-verdict.ts).
 */
export const moveDestinationOf = async (
    services: LimitMoveDeps,
    params: { readonly conversationId: string; readonly provider: AgentProvider; readonly model: string | undefined; readonly refused: string | undefined },
): Promise<string | undefined> => {
    const reach = (await services.accountReach?.(params.conversationId)) ?? ACCOUNTS_ALL;
    return siblingWithRoom(services, { ...params, allows: (id) => accountReachAllows(reach, params.provider, id) });
};

// Whether the owner's answer moves a held turn, onto which account first, and whether its session goes with it: the
// move's intent, booked at the failure. Undefined means no policy applies or no account has room. `carry` requires the
// turn to have run, a known context under the owner's line, and not already refused elsewhere. The account is only where
// it goes first: once that one is spent, the resume pass picks another with room (held-verdict.ts) rather than waiting
// behind it, as it did until 2026-11-19.
export const bookLimitMove = async (
    services: LimitMoveDeps & Pick<Services, "agents" | "sandboxSettings">,
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
    const account = await moveDestinationOf(services, params);
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
