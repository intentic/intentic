import { claudeContract } from "@intentic/sandbox-contract";
import { implement } from "@orpc/server";
import type { Services } from "../composition.js";
import type { OrpcContext } from "../context.js";
import { buildAuthorizeUrl, exchangeCode, newAccount } from "./claude-credentials.js";

// Claude subscription OAuth — the sandbox owns the credential, the platform never sees it. `start` hands the
// browser the authorize URL + PKCE material; `exchange` stores the tokens as a new account; `accounts` lists
// them; `disconnect` clears the one named by id. The agent route reads the account the turn selected.
export const createClaudeRoutes = (services: Services) => {
    const i = implement(claudeContract).$context<OrpcContext>();
    return {
        start: i.start.handler(() => buildAuthorizeUrl()),
        exchange: i.exchange.handler(async ({ input }) => {
            const account = newAccount(await exchangeCode(input.code, input.verifier, input.state), input.label ?? "");
            await services.claudeStore.write(account);
            return {
                id: account.id,
                label: account.label,
                connectedAt: account.connectedAt,
                ...(account.scope !== undefined ? { scope: account.scope } : {}),
            };
        }),
        accounts: i.accounts.handler(async () => ({ accounts: await services.claudeStore.list() })),
        models: i.models.handler(() => services.claudeModels.models()),
        disconnect: i.disconnect.handler(async ({ input }) => {
            await services.claudeStore.clear(input.id);
            return { ok: true } as const;
        }),
    };
};
