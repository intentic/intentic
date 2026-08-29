import { oc } from "@orpc/contract";
import { z } from "zod";
import { TranslatorAccountsSchema } from "../schemas/plan-limits.js";
import { TranslatorCompleteSchema, TranslatorStartSchema } from "../schemas/provider-oauth.js";
import { KeyedProviderSchema } from "../schemas/provider-subscriptions.js";
import { OkSchema } from "../schemas/shared.js";

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
    accounts: oc
        .route({
            method: "GET",
            path: "/translator/accounts",
            summary: "Subscriptions connected through the translator",
            description:
                "What is signed in per provider. Each provider can hold several accounts at once, and the translator spreads work across them.",
        })
        .output(TranslatorAccountsSchema),
    connect: oc
        .route({
            method: "POST",
            path: "/translator/{provider}/connect",
            summary: "Start connecting a subscription",
            description:
                "Begins the sign-in for one provider and says which of the two shapes it is: a code you type into a device page, which finishes by itself in the background, or a redirect whose landing address you hand back afterwards.",
        })
        .input(z.object({ provider: KeyedProviderSchema }))
        .output(TranslatorStartSchema),
    complete: oc
        .route({
            method: "POST",
            path: "/translator/{provider}/complete",
            summary: "Finish a redirect sign-in",
            description:
                "For the providers that redirect somewhere this sandbox cannot receive: hand back the address you landed on and the connection completes.",
        })
        .input(TranslatorCompleteSchema)
        .output(OkSchema),
    disconnect: oc
        .route({
            method: "POST",
            path: "/translator/{provider}/disconnect",
            summary: "Disconnect one subscription",
            description: "Clears a single account by name. Any others under the same provider stay connected.",
        })
        .input(z.object({ provider: KeyedProviderSchema, name: z.string().min(1) }))
        .output(OkSchema),
};
