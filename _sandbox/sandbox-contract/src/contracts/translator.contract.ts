import { oc } from "@orpc/contract";
import { z } from "zod";
import { KeyedProviderSchema, OkSchema, TranslatorAccountsSchema, TranslatorCompleteSchema, TranslatorStartSchema } from "../schemas.js";

// Routed-provider subscriptions (Sandbox ▸ Agent). The bundled translator (CLIProxyAPI) runs a non-Claude model
// UNDER the Claude Code harness on the user's SUBSCRIPTION, so each provider connects via an OAuth login rather
// than an API key. A provider can hold several accounts side by side (the translator balances across them);
// `accounts` lists what's connected per provider and `disconnect` clears ONE account by its auth-file `name`.
//
// Two login shapes ride one pair of routes. Codex, Grok and Kimi use device authorization: the translator polls
// to completion in the background, so the UI only polls `accounts`. Google redirects the browser to a loopback
// URL this sandbox can't receive, so `complete` hands the landing URL to the translator. `connect.flow` tells the
// card which mechanic it received without inferring it from whether an optional device code happened to exist.
export const translatorContract = {
    accounts: oc.route({ method: "GET", path: "/translator/accounts" }).output(TranslatorAccountsSchema),
    connect: oc
        .route({ method: "POST", path: "/translator/{provider}/connect" })
        .input(z.object({ provider: KeyedProviderSchema }))
        .output(TranslatorStartSchema),
    complete: oc.route({ method: "POST", path: "/translator/{provider}/complete" }).input(TranslatorCompleteSchema).output(OkSchema),
    disconnect: oc
        .route({ method: "POST", path: "/translator/{provider}/disconnect" })
        .input(z.object({ provider: KeyedProviderSchema, name: z.string().min(1) }))
        .output(OkSchema),
};
