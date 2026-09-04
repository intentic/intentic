import { oc } from "@orpc/contract";
import { z } from "zod";
import { KeyProviderParamSchema } from "../schemas/agent.js";
import { AccountIdSchema, AccountRenameSchema, OauthAccountListSchema, OauthAccountSchema } from "../schemas/provider-oauth.js";
import { OkSchema } from "../schemas/shared.js";

/* THE PROVIDERS YOU CONNECT BY PASTING A KEY (Sandbox ▸ Agent), on four routes with the provider as a PARAMETER
 * rather than four routes each.
 *
 * The lesson providers.contract.ts already learned about model catalogs: five identical route files differing
 * only in a name is a shape that costs a vertical slice through the contract, the router, the service container
 * and every test double every time a provider is added. Here the providers genuinely are identical — a keyed
 * provider is a base URL, a catalog URL and a store — so the id is a parameter and adding one is a spec row.
 *
 * WHY NOT THE OAUTH ROUTES. Claude and Cursor connect through a handshake this daemon runs: a `start` that
 * returns something to open and an `exchange`/poll that completes it. There is no handshake here at all — the
 * user already has the credential and hands it over — so `connect` takes the key and answers with the account
 * it became. Sharing a route family with the OAuth providers would have meant a `start` that returns nothing
 * and an `exchange` whose "code" is really a secret, which is a worse lie than two families.
 *
 * WHY NOT THE TRANSLATOR ROUTES. Those address subscriptions CLIProxyAPI holds; these credentials live in this
 * daemon's own auth tree, and a disconnect here removes a file rather than asking a proxy to forget one.
 *
 * THE PATHS MIRROR THE OAUTH PROVIDERS' (`<base>/accounts`, `<base>/account/rename`,
 * `<base>/account/disconnect`) with `/keys/<provider>` as the base, so the browser's account helpers reach
 * these rows with the same three URLs they already build for Claude, Grok and Cursor. Only `connect`
 * differs, because only `connect` is a different act.
 *
 * THE KEY TRAVELS IN, NEVER OUT. `connect` takes it and every answer on this contract is an OauthAccount, whose
 * shape has no field a credential could ride in — which is what makes "does this leak the key" a question you
 * answer by reading the schema instead of the handler. */
export const keysContract = {
    accounts: oc
        .route({
            method: "GET",
            path: "/keys/{provider}/accounts",
            summary: "Connected accounts for a key-based provider",
            description: "Which keys are connected for this provider. The keys themselves never travel: being in this list is what connected means.",
        })
        .input(KeyProviderParamSchema)
        .output(OauthAccountListSchema),
    connect: oc
        .route({
            method: "POST",
            path: "/keys/{provider}/connect",
            summary: "Connect an API key",
            description:
                "Stores an API key for this provider and answers with the account it became. A sandbox can hold several keys for one provider side by side.",
        })
        .input(
            KeyProviderParamSchema.extend({
                apiKey: z.string().min(1).describe("The key, as the provider issued it. Stored in this sandbox and never sent back out."),
                label: z
                    .string()
                    .max(80)
                    .optional()
                    .describe("What to call it. Blank falls back to the provider's own name, which is all a pasted key can say about itself."),
            }),
        )
        .output(OauthAccountSchema),
    rename: oc
        .route({
            method: "POST",
            path: "/keys/{provider}/account/rename",
            summary: "Rename one connected key",
            description: "Nothing in a pasted key says whose it is, so naming it is the only way to tell two of them apart.",
        })
        .input(KeyProviderParamSchema.extend(AccountRenameSchema.shape))
        .output(OkSchema),
    disconnect: oc
        .route({
            method: "POST",
            path: "/keys/{provider}/account/disconnect",
            summary: "Disconnect one key",
            description: "Removes a single stored key. Any others under the same provider stay connected.",
        })
        .input(KeyProviderParamSchema.extend(AccountIdSchema.shape))
        .output(OkSchema),
};
