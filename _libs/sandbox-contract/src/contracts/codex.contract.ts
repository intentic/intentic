import { oc } from "@orpc/contract";
import {
    AccountIdSchema,
    CodexDevicePollSchema,
    CodexDeviceStartSchema,
    CodexPollResultSchema,
    ModelsSchema,
    OauthAccountListSchema,
    OkSchema,
} from "../schemas.js";

// ChatGPT (Codex) OAuth — OpenAI's device-code flow. `start` requests a one-time code + verification URL; the
// browser signs in and enters the code, while the UI polls `poll` (pending:true until sign-in completes, then
// the created account). The sandbox owns the credential (Codex's native auth.json, one dir per account).
// `accounts` lists the connected accounts; `disconnect` clears the one named by id.
export const codexContract = {
    start: oc.route({ method: "POST", path: "/codex/oauth/start" }).output(CodexDeviceStartSchema),
    poll: oc.route({ method: "POST", path: "/codex/oauth/poll" }).input(CodexDevicePollSchema).output(CodexPollResultSchema),
    // OpenAI/Codex's live models for the model picker — the source of valid ids (see codex-models.ts).
    models: oc.route({ method: "GET", path: "/codex/models" }).output(ModelsSchema),
    accounts: oc.route({ method: "GET", path: "/codex/accounts" }).output(OauthAccountListSchema),
    disconnect: oc.route({ method: "POST", path: "/codex/account/disconnect" }).input(AccountIdSchema).output(OkSchema),
};
