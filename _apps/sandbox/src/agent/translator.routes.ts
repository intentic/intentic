import { translatorContract } from "@intentic/sandbox-contract";
import { implement } from "@orpc/server";
import type { Services } from "../composition.js";
import type { OrpcContext } from "../context.js";

// Routed-provider subscriptions (Sandbox ▸ Agent). The bundled translator (CLIProxyAPI) runs codex/grok/gemini
// UNDER the Claude Code harness on the user's subscription, so `connect` starts an OAuth login and CLIProxyAPI
// finishes it in the background — the UI polls `accounts` until connected. Codex and Grok are device-code logins
// that need nothing further; Google's browser redirect dead-ends on a loopback URL only this container binds, so
// the user pastes that URL back through `complete`. A provider holds any number of accounts side by side (the
// translator balances across them); `disconnect` clears ONE account's tokens by its auth-file name.
export const createTranslatorRoutes = (services: Services) => {
    const i = implement(translatorContract).$context<OrpcContext>();
    return {
        accounts: i.accounts.handler(() => services.cliProxy.accounts()),
        connect: i.connect.handler(({ input }) => services.cliProxy.connect(input.provider)),
        complete: i.complete.handler(async ({ input }) => {
            await services.cliProxy.complete(input);
            return { ok: true } as const;
        }),
        disconnect: i.disconnect.handler(async ({ input }) => {
            await services.cliProxy.disconnect(input.provider, input.name);
            return { ok: true } as const;
        }),
    };
};
