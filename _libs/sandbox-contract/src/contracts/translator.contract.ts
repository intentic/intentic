import { oc } from "@orpc/contract";
import { z } from "zod";
import { KeyedProviderSchema, OkSchema, TranslatorAccountsSchema, TranslatorCompleteSchema, TranslatorStartSchema } from "../schemas.js";

// Routed-provider subscriptions (Sandbox ▸ Agent). The bundled translator (CLIProxyAPI) runs a non-Claude model
// UNDER the Claude Code harness on the user's SUBSCRIPTION, so each provider connects via an OAuth login rather
// than an API key. `accounts` reports which subscriptions are connected; `disconnect` clears a provider's tokens.
//
// Two login shapes ride one pair of routes. Codex and Grok mint a one-time device `code`: the user enters it at
// the provider's site and the translator polls to completion in the background, so the UI just polls `accounts`
// and `complete` is never called. Google has no device flow — it redirects the browser to a loopback URL this
// sandbox can't receive — so its `connect` returns an EMPTY code, the card asks the user to paste the URL they
// landed on, and `complete` hands it to the translator to finish the exchange. The card branches on that empty
// code rather than on the provider id, so a provider that later gains a device flow needs no UI change.
export const translatorContract = {
    accounts: oc.route({ method: "GET", path: "/translator/accounts" }).output(TranslatorAccountsSchema),
    connect: oc
        .route({ method: "POST", path: "/translator/{provider}/connect" })
        .input(z.object({ provider: KeyedProviderSchema }))
        .output(TranslatorStartSchema),
    complete: oc.route({ method: "POST", path: "/translator/{provider}/complete" }).input(TranslatorCompleteSchema).output(OkSchema),
    disconnect: oc
        .route({ method: "POST", path: "/translator/{provider}/disconnect" })
        .input(z.object({ provider: KeyedProviderSchema }))
        .output(OkSchema),
};
