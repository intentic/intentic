import { oc } from "@orpc/contract";
import { MintedProviderParamSchema } from "../schemas/agent.js";
import {
    AccountIdSchema,
    AccountRenameSchema,
    MintedLoginCancelSchema,
    MintedLoginCompleteSchema,
    MintedLoginRequestSchema,
    MintedLoginStartSchema,
    OauthAccountListSchema,
} from "../schemas/provider-oauth.js";
import { OkSchema } from "../schemas/shared.js";

/* THE PROVIDERS WHOSE SIGN-IN MINTS THEIR OWN API KEY (Sandbox ▸ Agent), on five routes with the provider as a
 * PARAMETER rather than five routes each.
 *
 * The lesson providers.contract.ts already learned about model catalogs: five identical route files differing
 * only in a name is a shape that costs a vertical slice through the contract, the router, the service container
 * and every test double every time a provider is added. Here the providers genuinely are identical — a minted
 * provider is a handshake, a pair of base URLs per estate, and a store — so the id is a parameter and adding one
 * is a spec row plus its login.
 *
 * WHY NOT THE OAUTH ROUTES. Claude's flow ends with a code the caller hands back, so it needs an `exchange`
 * whose input is a code and a verifier; these end with the daemon minting a vendor key, so the only thing a
 * caller can hand back is the address a redirect dead-ended on. Cursor's is the closest relative and this is
 * shaped after it (`login/start`, `login/cancel`, then watch `accounts`), with `login/complete` added for the
 * one estate whose grant cannot reach us any other way.
 *
 * WHY NOT THE TRANSLATOR ROUTES. Those address subscriptions CLIProxyAPI holds; these credentials live in this
 * daemon's own auth tree, and a disconnect here removes a file rather than asking a proxy to forget one.
 *
 * THERE IS NO `connect`, AND THAT IS THE CHANGE THIS FILE EXISTS TO RECORD. The first cut of these providers had
 * one: a route that took a pasted API key. Both vendors' own CLIs sign in and mint the key themselves, so asking
 * the user to go and find one was us doing less than the vendor does. Anyone who genuinely wants to hand over a
 * key they already hold has always had the road for it — an `endpoint` capability with the `anthropic` protocol —
 * and that road does not need a second, provider-shaped copy of itself.
 *
 * THE PATHS MIRROR THE OAUTH PROVIDERS' (`<base>/accounts`, `<base>/account/rename`,
 * `<base>/account/disconnect`) with `/keys/<provider>` as the base, so the browser's account helpers reach these
 * rows with the same three URLs they already build for Claude, Grok and Cursor. Nothing redeemable is on any
 * answer here: `accounts` is an OauthAccount list, whose shape has no field a credential could ride in, which is
 * what makes "does this leak the minted key" a question you answer by reading the schema. */
export const mintedContract = {
    start: oc
        .route({
            method: "POST",
            path: "/keys/{provider}/login/start",
            summary: "Begin connecting a plan",
            description:
                "Hands back the page to sign in on, and the code it will ask for where there is one. The sandbox finishes the handshake and mints the provider's key itself, so watch the account list: only a sign-in that dead-ends in the browser needs anything handed back.",
        })
        .input(MintedProviderParamSchema.extend(MintedLoginRequestSchema.shape))
        .output(MintedLoginStartSchema),
    complete: oc
        .route({
            method: "POST",
            path: "/keys/{provider}/login/complete",
            summary: "Finish a sign-in that dead-ended in the browser",
            description:
                "Takes the address the browser landed on and reads the grant out of it. Only redirect sign-ins need this: the address points at a port inside this sandbox, so nothing else could have observed it.",
        })
        .input(MintedProviderParamSchema.extend(MintedLoginCompleteSchema.shape))
        .output(OkSchema),
    cancel: oc
        .route({
            method: "POST",
            path: "/keys/{provider}/login/cancel",
            summary: "Abandon a sign-in",
            description: "Stops waiting on a sign-in nobody completed. An abandoned attempt also expires on its own.",
        })
        .input(MintedProviderParamSchema.extend(MintedLoginCancelSchema.shape))
        .output(OkSchema),
    accounts: oc
        .route({
            method: "GET",
            path: "/keys/{provider}/accounts",
            summary: "Connected accounts for a provider whose key is minted",
            description: "Which plans are connected for this provider. The minted keys themselves never travel: being in this list is what connected means.",
        })
        .input(MintedProviderParamSchema)
        .output(OauthAccountListSchema),
    rename: oc
        .route({
            method: "POST",
            path: "/keys/{provider}/account/rename",
            summary: "Rename one connected plan",
            description: "Changes the label a row shows under, so two plans on one provider are tellable apart.",
        })
        .input(MintedProviderParamSchema.extend(AccountRenameSchema.shape))
        .output(OkSchema),
    disconnect: oc
        .route({
            method: "POST",
            path: "/keys/{provider}/account/disconnect",
            summary: "Disconnect one plan",
            description:
                "Removes a single stored credential, and stops any sign-in still in flight for this provider. Any other accounts under it stay connected.",
        })
        .input(MintedProviderParamSchema.extend(AccountIdSchema.shape))
        .output(OkSchema),
};
