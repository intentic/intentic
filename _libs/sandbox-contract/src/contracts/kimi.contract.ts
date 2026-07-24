import { oc } from "@orpc/contract";
import { AccountIdSchema, KimiConnectSchema, ModelsSchema, OauthAccountListSchema, OauthAccountSchema, OkSchema } from "../schemas.js";

// Kimi Code (Moonshot) — the sandbox owns the credential, an API key rather than an OAuth grant. Kimi speaks the
// Anthropic Messages protocol, so a Kimi turn runs on the SAME Claude Code harness as Claude, with the harness
// pointed at Moonshot's Anthropic-compatible endpoint and authenticated with the stored key (see agent.routes).
// `connect` stores a pasted key as a new account and returns it; `models` is the live catalog for the picker;
// `accounts` lists connected keys (tokens never ride back); `disconnect` clears the one named by id.
export const kimiContract = {
    connect: oc.route({ method: "POST", path: "/kimi/account/connect" }).input(KimiConnectSchema).output(OauthAccountSchema),
    // Kimi/Moonshot's live models for the picker — the source of valid ids (see kimi-models.ts).
    models: oc.route({ method: "GET", path: "/kimi/models" }).output(ModelsSchema),
    accounts: oc.route({ method: "GET", path: "/kimi/accounts" }).output(OauthAccountListSchema),
    disconnect: oc.route({ method: "POST", path: "/kimi/account/disconnect" }).input(AccountIdSchema).output(OkSchema),
};
