import { type AgentProvider, KeyedProviderSchema } from "@intentic/sandbox-contract";
import type { Services } from "../composition.js";
import { accountLimitReset } from "../usage/account-usage.js";

/* WHEN THE SPENT WINDOW REOPENS, asked once for every runtime, because the answer was previously reachable from
 * only one of them and the difference was invisible from the chat.
 *
 * A `rate_limit` frame carrying a reset instant and one without are two different products. With it the client
 * schedules: the notice names the hour, the pick-up strip counts down to it, and an armed auto-continue sleeps
 * through the closed window and picks the work up on the far side (conversation.ts's armAutoContinue takes the
 * LONGER of its ladder rung and this instant). Without it the same failure gets the bare ladder, 5s, 15s, 45s,
 * three guaranteed refusals into a window that reopens on Thursday, and then the automation gives up and the
 * user comes back to a chat that stopped trying hours before it could have worked.
 *
 * WHICH HALF OF THE FLEET A TURN RAN ON DECIDED WHICH IT GOT, and nothing about the failure did. The Claude Code
 * loop carries a TurnAllowance and dresses its own frame (error-frames.ts's rateLimitFrame), so a routed turn
 * under that harness came back with the reset. Every NATIVE runtime, Codex's app-server, the two OpenCode loops
 * (Grok and Gemini), Cursor's SDK, reads the refusal off its own vendor's wire and emits a bare `rate_limit`:
 * there is no allowance object down there to ask. The route's fallback was the persisted per-ACCOUNT snapshot,
 * which cannot answer for them either, because a native routed turn names no real account, it names the
 * subscription serving every turn of its provider ("codex-subscription", "xai"), and nothing is ever filed
 * under those keys. Three sources, and all three miss: GPT on its own runtime hit a wall it knew the reset for
 * and offered a five-second retry.
 *
 * So the question is asked HERE, once, off the two readings that between them cover every provider that
 * publishes one:
 *
 *   the ACCOUNT's own snapshot , native Claude, whose windows are filed per connected account (account-usage.ts);
 *   the TRANSLATOR's pool      , every routed subscription, filed per auth file and scoped to the pool this
 *                                MODEL spends, which is the part no caller can re-derive: Google meters Gemini
 *                                separately from the Claude and GPT models off one sign-in (translator.ts's
 *                                turnLimit). This is the same reading the quick-model ladder already steps over
 *                                spent rungs with (quick-model-quota.ts), so a fact the daemon acts on in one
 *                                place stops being one it cannot state in the other.
 *
 * Account first, and only as a fallback to what the frame itself said (see the call site's precedence): a
 * failure that named its own instant knows more than any snapshot, which may be minutes stale.
 *
 * `undefined` is a real answer and stays one. Grok publishes no readable quota at all (PLAN_LIMIT_PROVIDERS
 * says why) and Cursor is not routed through the translator, so for those two there is nothing to schedule
 * against and the client keeps the ladder, which is the honest behaviour rather than a leftover. `turnLimit`
 * also withholds a reset while any account still has headroom, deliberately: with room on file the quota is not
 * what refused the turn and no reset is what the user is waiting for (TurnLimit).
 *
 * Never throws. This dresses a frame describing a failure that has already happened; a lookup that died taking
 * the refusal's own sentence with it would be strictly worse than one that returns nothing. */
export const limitReopensAt = async (params: {
    readonly services: Services;
    readonly provider: AgentProvider;
    readonly model: string | undefined;
    readonly account: string | undefined;
}): Promise<number | undefined> => {
    const { services, provider, model, account } = params;
    const stored = await accountLimitReset(services.accountUsage, account).catch(() => undefined);
    if (stored !== undefined) {
        return stored;
    }
    const routed = KeyedProviderSchema.safeParse(provider);
    if (!routed.success || model === undefined || model === "") {
        return undefined;
    }
    const limit = await services.cliProxy.turnLimit(routed.data, model).catch(() => undefined);
    return limit?.reopensAt;
};
