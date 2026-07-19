import { oc } from "@orpc/contract";
import { z } from "zod";
import { DeviceStartSchema, KeyedProviderSchema, OkSchema, TranslatorAccountsSchema } from "../schemas.js";

// Routed-provider subscriptions (Sandbox ▸ Agent). The bundled translator (CLIProxyAPI) runs a non-Claude model
// UNDER the Claude Code harness on the user's SUBSCRIPTION, so each provider connects via a device-code OAuth
// login (no API key). `accounts` reports which subscriptions are connected; `connect` starts a device login and
// returns the verification URL + one-time code (the translator polls to completion in the background, so the UI
// polls `accounts` until connected — there is no paste-back); `disconnect` clears a provider's tokens.
export const translatorContract = {
    accounts: oc.route({ method: "GET", path: "/translator/accounts" }).output(TranslatorAccountsSchema),
    connect: oc
        .route({ method: "POST", path: "/translator/{provider}/connect" })
        .input(z.object({ provider: KeyedProviderSchema }))
        .output(DeviceStartSchema),
    disconnect: oc
        .route({ method: "POST", path: "/translator/{provider}/disconnect" })
        .input(z.object({ provider: KeyedProviderSchema }))
        .output(OkSchema),
};
