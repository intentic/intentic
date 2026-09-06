import { oc } from "@orpc/contract";
import { NativeProviderParamSchema } from "../schemas/agent.js";
import {
    AccountIdSchema,
    AccountListQuerySchema,
    AccountRenameSchema,
    LoginCancelSchema,
    LoginCompletedSchema,
    LoginCompleteSchema,
    LoginRequestSchema,
    LoginStartSchema,
    OauthAccountListSchema,
    OauthAccountSchema,
} from "../schemas/provider-oauth.js";
import { OkSchema } from "../schemas/shared.js";

/* THE ACCOUNTS THIS SANDBOX HOLDS ITSELF, one route family with the provider as a PARAMETER.
 *
 * Four families used to serve this (Claude's, Cursor's, Grok's, and one for every provider whose sign-in mints
 * its own key), each "the previous one's shape" with a verb renamed: `oauth/start` here, `login/start` there,
 * an `exchange` for the flow whose proof travelled and a `complete` for the one whose proof did not. The
 * lesson providers.contract.ts learned about model catalogs holds for accounts too: the operations are the
 * same six for all of them, so the id is a parameter and a provider's own mechanism is its module's to declare
 * (the daemon's ProviderModule.accounts), not a vertical slice through the contract, the router and every test
 * double.
 *
 * WHY NOT THE TRANSLATOR ROUTES. Those address subscriptions CLIProxyAPI holds and re-serves behind an Anthropic
 * endpoint; these credentials live in this daemon's own auth tree (or, for Grok, in OpenCode's), and a
 * disconnect here removes a file rather than asking a proxy to forget one. A provider served both ways (Grok)
 * has a row in each.
 *
 * Nothing redeemable is on any answer here: `accounts` is an OauthAccount list, whose shape has no field a
 * credential could ride in, and a sign-in's proof never leaves the sandbox (provider-oauth.ts, LoginStart). */
export const accountsContract = {
    start: oc
        .route({
            method: "POST",
            path: "/accounts/{provider}/login/start",
            summary: "Begin connecting an account",
            description:
                "Hands back the page to sign in on, and the code it will ask for where there is one. The sandbox holds the proof and finishes what it can itself: a device sign-in lands in the account list on its own, a paste or a redirect needs one thing brought back to the finishing call.",
        })
        .input(NativeProviderParamSchema.extend(LoginRequestSchema.shape))
        .output(LoginStartSchema),
    complete: oc
        .route({
            method: "POST",
            path: "/accounts/{provider}/login/complete",
            summary: "Finish a sign-in with what the page handed back",
            description:
                "Takes the code the page showed, or the address a redirect landed on, and finishes the attempt. Answers with the account where the exchange ends here; otherwise the sandbox still has a mint to do and the row appears in the account list.",
        })
        .input(NativeProviderParamSchema.extend(LoginCompleteSchema.shape))
        .output(LoginCompletedSchema),
    cancel: oc
        .route({
            method: "POST",
            path: "/accounts/{provider}/login/cancel",
            summary: "Abandon a sign-in",
            description: "Stops waiting on a sign-in nobody completed. An abandoned attempt also expires on its own.",
        })
        .input(NativeProviderParamSchema.extend(LoginCancelSchema.shape))
        .output(OkSchema),
    // Each account carries its plan-limit reading where the provider publishes one. `force` re-measures before
    // answering (AccountListQuerySchema); a provider with nothing to measure accepts it and answers at once.
    accounts: oc
        .route({
            method: "GET",
            path: "/accounts/{provider}",
            summary: "Connected accounts of a provider",
            description:
                "Each connected account with how full its plan limits were when last measured, where the provider publishes any. Ask for a fresh measurement and it takes one before answering, which is slower. The credentials themselves never travel: being in this list is what connected means.",
        })
        .input(NativeProviderParamSchema.extend(AccountListQuerySchema.shape))
        .output(OauthAccountListSchema),
    rename: oc
        .route({
            method: "POST",
            path: "/accounts/{provider}/rename",
            summary: "Rename an account",
            description: "Changes the label one account shows under, so several are tellable apart. Blank restores the one derived from the sign-in.",
        })
        .input(NativeProviderParamSchema.extend(AccountRenameSchema.shape))
        .output(OauthAccountSchema),
    disconnect: oc
        .route({
            method: "POST",
            path: "/accounts/{provider}/disconnect",
            summary: "Disconnect an account",
            description: "Clears one stored credential, and stops any sign-in still in flight for this provider. The others stay connected.",
        })
        .input(NativeProviderParamSchema.extend(AccountIdSchema.shape))
        .output(OkSchema),
};
