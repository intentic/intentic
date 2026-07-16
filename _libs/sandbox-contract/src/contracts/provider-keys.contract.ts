import { oc } from "@orpc/contract";
import { z } from "zod";
import { KeyedProviderSchema, OkSchema, ProviderKeyStatusSchema, SetProviderKeySchema } from "../schemas.js";

// The provider API keys the Claude Code harness uses (via the bundled translator) to serve NON-Claude providers
// (codex → OpenAI, grok → xAI). Only presence is ever exposed (`status` → hasKey booleans); the secret itself is
// write-only. `set` stores/overwrites one key; `remove` clears it (falling back to the container-env key, if any).
// The claude provider is not here — it authenticates with subscription OAuth (see claudeContract), no API key.
export const providerKeysContract = {
    status: oc.route({ method: "GET", path: "/provider-keys" }).output(ProviderKeyStatusSchema),
    set: oc.route({ method: "POST", path: "/provider-keys" }).input(SetProviderKeySchema).output(OkSchema),
    remove: oc.route({ method: "DELETE", path: "/provider-keys/{provider}" }).input(z.object({ provider: KeyedProviderSchema })).output(OkSchema),
};
