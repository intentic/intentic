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

// Claude subscription OAuth — the sandbox owns the credential. `start` hands the browser the authorize URL +
// PKCE material; `exchange` stores the resulting tokens as a new account and returns it; `accounts` lists the
// connected accounts; `rename` renames one; `disconnect` clears the one named by id. A sandbox can hold several
// Claude accounts.
//
// The model catalog is NOT here: it is the one thing every provider answers identically, so it lives on the
// shared /providers/{provider}/models route (providers.contract.ts). What is left is what is genuinely Claude's
// — an account handshake no other provider has.
export const claudeContract = {
    start: oc.route({ method: "POST", path: "/claude/oauth/start" }).output(AuthorizeChallengeSchema),
    exchange: oc.route({ method: "POST", path: "/claude/oauth/exchange" }).input(OauthExchangeSchema).output(OauthAccountSchema),
    // Each account carries its plan-limit reading. `force` re-measures before answering — see
    // AccountListQuerySchema, and USAGE_WAIT_MS in claude.routes.ts for what an ordinary read waits.
    accounts: oc.route({ method: "GET", path: "/claude/accounts" }).input(AccountListQuerySchema).output(OauthAccountListSchema),
    rename: oc.route({ method: "POST", path: "/claude/account/rename" }).input(AccountRenameSchema).output(OauthAccountSchema),
    disconnect: oc.route({ method: "POST", path: "/claude/account/disconnect" }).input(AccountIdSchema).output(OkSchema),
};
