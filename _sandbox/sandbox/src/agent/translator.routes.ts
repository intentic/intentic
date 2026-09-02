import { errorMessage } from "@intentic/base/errors";
import { translatorContract } from "@intentic/sandbox-contract";
import { implement, ORPCError } from "@orpc/server";
import type { Services } from "../composition.js";
import type { OrpcContext } from "../context.js";

export type TranslatorRoutesDeps = Pick<Services, "cliProxy">;

/* THE TRANSLATOR'S OWN WORDS, ALL THE WAY TO THE CARD, the one thing every route here has to preserve.
 *
 * oRPC replaces the message of any throw that is not an ORPCError with a bare "Internal server error", so these
 * four handlers used to delete the only useful part of every failure they could produce. And every one of those
 * failures is already a sentence written for the person looking at Sandbox ▸ Agent: the image has no translator
 * binary and wants a rebuild, Google's authorize URL didn't come back, CLIProxyAPI rejected a pasted redirect
 * URL because its handshake had expired. All of them arrived as "Internal server error", which is how a user
 * whose Google credentials had lapsed, and every new user on an image without the translator pack, got a string
 * that names no cause and suggests no action.
 *
 * 502 is the honest status: the daemon reached out to the bundled proxy and the proxy is what failed. Same
 * recipe, and same reason, as the vendor boundary in ci.routes.ts. */
const upstream = async <T>(action: Promise<T>): Promise<T> => {
    try {
        return await action;
    } catch (error) {
        // Already an ORPCError ⇒ a route below chose that status deliberately; don't relabel it as a gateway fault.
        if (error instanceof ORPCError) {
            throw error;
        }
        throw new ORPCError("BAD_GATEWAY", { message: errorMessage(error) });
    }
};

// Routed-provider subscriptions (Sandbox ▸ Agent). The bundled translator (CLIProxyAPI) runs codex/grok/kimi/gemini
// UNDER the Claude Code harness on the user's subscription, so `connect` starts an OAuth login and CLIProxyAPI
// finishes it in the background, the UI polls `accounts` until connected. Codex, Grok and Kimi use device login
// that need nothing further; Google's browser redirect dead-ends on a loopback URL only this container binds, so
// the user pastes that URL back through `complete`. A provider holds any number of accounts side by side (the
// translator balances across them); `disconnect` clears ONE account's tokens by its auth-file name.
export const createTranslatorRoutes = (services: TranslatorRoutesDeps) => {
    const i = implement(translatorContract).$context<OrpcContext>();
    return {
        accounts: i.accounts.handler(() => upstream(services.cliProxy.accounts())),
        connect: i.connect.handler(({ input }) => upstream(services.cliProxy.connect(input.provider))),
        complete: i.complete.handler(async ({ input }) => {
            await upstream(services.cliProxy.complete(input));
            return { ok: true } as const;
        }),
        disconnect: i.disconnect.handler(async ({ input }) => {
            await upstream(services.cliProxy.disconnect(input.provider, input.name));
            return { ok: true } as const;
        }),
    };
};
