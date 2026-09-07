import { type AccountUsage, type AgentProvider, bindingWindow, type ModelRef, type OauthAccount, SPENT_UTILIZATION } from "@intentic/sandbox-contract";
import type { Services } from "../../composition.js";
import { moveAfterLimitArmed } from "../run/turn-resume.js";

/* THE ACCOUNT A SPENT ALLOWANCE CAN BE ANSWERED WITH, as the daemon judges it, so the owner's policy can move a
 * held turn without a browser in the room. The editor's limitFallback.ts makes the same judgement for the press
 * in the chat, and the two have to agree about what "room" means: a reading, not the absence of one. An account
 * nobody has measured is not offered, because landing a turn on an unmeasured wall costs a refused request and
 * teaches the owner the policy lies.
 *
 * CLAUDE ONLY, by construction rather than by omission. Claude is the provider whose accounts this daemon picks
 * between per turn (harness-credentials.ts): a refusal names one of them and the others are readable from the
 * usage store. The routed providers (Codex, Gemini, Kimi, Grok) sit behind the translator, which balances its
 * own credentials BEFORE it refuses, so a refusal there already means every one is spent and there is nothing
 * left to move to. A different PROVIDER is never a move: it retires the session for a saving that is not one.
 *
 * EMPTIEST FIRST, for the reason the editor gives: the move is made once, on the owner's behalf, and landing
 * on the account nearest its own ceiling is how one refusal becomes two. A credential the provider has stopped
 * accepting is not room whatever its last reading said, the move would land on a reconnect prompt. */
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

// One account's room for the model, as its fullest gating window reads it; undefined for the refused account, a
// dead credential, an unmeasured one, or one at the cap.
const roomOf = (account: OauthAccount, usage: AccountUsage | undefined, model: ModelRef | undefined, refused: string | undefined): number | undefined => {
    if (account.id === refused || account.needsReauth === true) {
        return undefined;
    }
    const window = bindingWindow(usage, model);
    return window === undefined || window.utilization >= SPENT_UTILIZATION ? undefined : window.utilization;
};

/* WHERE A HELD TURN GOES NEXT, decided once at the failure. Undefined is the ordinary answer: no policy for this
 * conversation, or nothing with room, and the turn stays held or booked for the reset exactly as before.
 *
 * `carry` is the policy's second question, answered from the owner's line (limitMoveCarryUnder) against what
 * the turn measured: the session comes along only when the turn actually ran (a refused-at-the-door session
 * holds one unanswered message and is worth less than the brief), when its context is known, and when reading
 * that context again on the other account is under the line. A carry the other account has already refused is
 * not tried twice. */
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
