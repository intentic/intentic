import { oc } from "@orpc/contract";
import {
    AccountIdSchema,
    AccountListQuerySchema,
    AccountRenameSchema,
    CursorLoginCancelSchema,
    CursorLoginStartSchema,
    OauthAccountListSchema,
    OauthAccountSchema,
} from "../schemas/provider-oauth.js";
import { OkSchema } from "../schemas/shared.js";

/* Cursor subscription sign-in, the sandbox owns the credential and the platform never sees it, the same bargain
 * claude.contract.ts strikes. What differs is who finishes the handshake.
 *
 * Claude's flow is start → the browser gets a code → `exchange` hands it back. Cursor's PKCE verifier is
 * redeemable on its own, so it never leaves the daemon: `start` begins the flow, keeps the verifier in memory,
 * polls Cursor until the browser completes the sign-in, mints a 90-day user key and writes it as an account.
 * The caller opens the URL and then watches `accounts`, exactly as it does for a device login, which is why
 * there is no `exchange` route here and a `cancel` one instead.
 *
 * The model catalog is deliberately absent, as it is for every provider: it is the one question they all answer
 * identically, so it lives on the shared /providers/{provider}/models route (providers.contract.ts). */
export const cursorContract = {
    start: oc
        .route({
            method: "POST",
            path: "/cursor/login/start",
            summary: "Begin connecting a Cursor account",
            description:
                "Hands back the page to sign in on. The sandbox finishes the handshake itself and stores the credential, so nothing has to be pasted back: watch the account list instead.",
        })
        .output(CursorLoginStartSchema),
    cancel: oc
        .route({
            method: "POST",
            path: "/cursor/login/cancel",
            summary: "Abandon a Cursor sign-in",
            description: "Stops waiting on a sign-in nobody completed. An abandoned attempt also expires on its own.",
        })
        .input(CursorLoginCancelSchema)
        .output(OkSchema),
    // Shaped like Claude's, including `force`, so the two account lists render through one component. Cursor
    // publishes no account-wide headroom today, so `usage` stays absent on these rows and they draw a dot rather
    // than a ring, which is what an unmeasured account has always meant here.
    accounts: oc
        .route({
            method: "GET",
            path: "/cursor/accounts",
            summary: "Connected Cursor accounts",
            description:
                "Each connected account, and whether its stored key is still good. Cursor publishes no plan-wide allowance, so these rows carry no usage reading.",
        })
        .input(AccountListQuerySchema)
        .output(OauthAccountListSchema),
    rename: oc
        .route({
            method: "POST",
            path: "/cursor/account/rename",
            summary: "Rename a Cursor account",
            description: "Changes the label one account shows under, so several are tellable apart.",
        })
        .input(AccountRenameSchema)
        .output(OauthAccountSchema),
    disconnect: oc
        .route({
            method: "POST",
            path: "/cursor/account/disconnect",
            summary: "Disconnect a Cursor account",
            description: "Clears the stored key for one account. The others stay connected.",
        })
        .input(AccountIdSchema)
        .output(OkSchema),
};
