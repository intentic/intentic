import { translatorContract } from "@intentic/sandbox-contract";
import { implement } from "@orpc/server";
import type { Services } from "../composition.js";
import type { OrpcContext } from "../context.js";

// Routed-provider subscriptions (Sandbox ▸ Agent). The bundled translator (CLIProxyAPI) runs codex/grok UNDER
// the Claude Code harness on the user's subscription, so `connect` starts a device-code OAuth login (the user
// opens a URL and enters a code) and CLIProxyAPI polls to completion in the background — the UI polls `accounts`
// until connected, there is no paste-back. `disconnect` clears a provider's stored subscription tokens.
export const createTranslatorRoutes = (services: Services) => {
    const i = implement(translatorContract).$context<OrpcContext>();
    return {
        accounts: i.accounts.handler(() => services.cliProxy.accounts()),
        connect: i.connect.handler(({ input }) => (input.provider === "grok" ? services.cliProxy.connectGrok() : services.cliProxy.connectCodex())),
        disconnect: i.disconnect.handler(async ({ input }) => {
            await services.cliProxy.disconnect(input.provider);
            return { ok: true } as const;
        }),
    };
};
