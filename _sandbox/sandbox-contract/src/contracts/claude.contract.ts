import { oc } from "@orpc/contract";
import {
    AccountIdSchema,
    AccountListQuerySchema,
    AccountRenameSchema,
    AuthorizeChallengeSchema,
    OauthAccountListSchema,
    OauthAccountSchema,
    OauthExchangeSchema,
    OkSchema,
} from "../schemas.js";

// Claude subscription OAuth, the sandbox owns the credential. `start` hands the browser the authorize URL +
// PKCE material; `exchange` stores the resulting tokens as a new account and returns it; `accounts` lists the
// connected accounts; `rename` renames one; `disconnect` clears the one named by id. A sandbox can hold several
// Claude accounts.
//
// The model catalog is NOT here: it is the one thing every provider answers identically, so it lives on the
// shared /providers/{provider}/models route (providers.contract.ts). What is left is what is genuinely Claude's
//, an account handshake no other provider has.
export const claudeContract = {
    start: oc
        .route({
            method: "POST",
            path: "/claude/oauth/start",
            summary: "Begin connecting a Claude account",
            description:
                "Hands back the address to send somebody to, and the proof this sandbox will need to finish the exchange. The sandbox holds the credential afterwards, not the browser.",
        })
        .output(AuthorizeChallengeSchema),
    exchange: oc
        .route({
            method: "POST",
            path: "/claude/oauth/exchange",
            summary: "Finish connecting a Claude account",
            description:
                "Trades the code from the sign-in for stored tokens and answers with the account it just connected. A sandbox can hold several Claude accounts side by side.",
        })
        .input(OauthExchangeSchema)
        .output(OauthAccountSchema),
    // Each account carries its plan-limit reading. `force` re-measures before answering, see
    // AccountListQuerySchema, and USAGE_WAIT_MS in claude.routes.ts for what an ordinary read waits.
    accounts: oc
        .route({
            method: "GET",
            path: "/claude/accounts",
            summary: "Connected Claude accounts",
            description:
                "Each connected account with how full its plan limits were when last measured. Ask for a fresh measurement and it takes one before answering, which is slower.",
        })
        .input(AccountListQuerySchema)
        .output(OauthAccountListSchema),
    rename: oc
        .route({
            method: "POST",
            path: "/claude/account/rename",
            summary: "Rename a Claude account",
            description: "Changes the label one account shows under, so several are tellable apart.",
        })
        .input(AccountRenameSchema)
        .output(OauthAccountSchema),
    disconnect: oc
        .route({
            method: "POST",
            path: "/claude/account/disconnect",
            summary: "Disconnect a Claude account",
            description: "Clears the stored tokens for one account. The others stay connected.",
        })
        .input(AccountIdSchema)
        .output(OkSchema),
};
