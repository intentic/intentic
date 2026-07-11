import { oc } from "@orpc/contract";
import { AccountIdSchema, GrokDeviceStartSchema, GrokModelsSchema, OauthAccountListSchema, OkSchema } from "../schemas.js";

// xAI Grok (via OpenCode) uses subscription OAuth — the sandbox owns the credential (OpenCode persists the
// tokens and refreshes them). `start` authorizes xAI's headless device-code method and returns the verification
// URL + instructions (which carry the one-time code the user enters at x.ai); OpenCode then polls to completion
// — there is no paste-back — and the UI polls `accounts` until connected. `disconnect` clears the tokens.
// ponytail: OpenCode holds one xAI auth per data dir, so `accounts` is 0 or 1 — the list shape matches the
// other providers without paying for per-account OpenCode servers yet.
export const grokContract = {
    start: oc.route({ method: "POST", path: "/grok/oauth/start" }).output(GrokDeviceStartSchema),
    // xAI's live models (via OpenCode) for the model picker — the source of truth for valid model ids.
    models: oc.route({ method: "GET", path: "/grok/models" }).output(GrokModelsSchema),
    accounts: oc.route({ method: "GET", path: "/grok/accounts" }).output(OauthAccountListSchema),
    disconnect: oc.route({ method: "POST", path: "/grok/account/disconnect" }).input(AccountIdSchema).output(OkSchema),
};
