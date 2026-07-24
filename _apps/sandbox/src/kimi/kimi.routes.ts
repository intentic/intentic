import { kimiContract } from "@intentic/sandbox-contract";
import { implement } from "@orpc/server";
import type { Services } from "../composition.js";
import type { OrpcContext } from "../context.js";
import { newKimiAccount } from "./kimi-credentials.js";

// Kimi (Moonshot) — the sandbox owns the credential, an API key. `connect` stores a pasted key as a new account
// and returns it; `accounts` lists the connected keys (tokens never ride back); `models` is the live catalog for
// the picker; `disconnect` clears the one named by id. The agent route reads the account the turn selected.
export const createKimiRoutes = (services: Services) => {
    const i = implement(kimiContract).$context<OrpcContext>();
    return {
        connect: i.connect.handler(async ({ input }) => {
            const account = newKimiAccount(input.apiKey, input.label ?? "");
            await services.kimiStore.write(account);
            return { id: account.id, label: account.label, connectedAt: account.connectedAt };
        }),
        models: i.models.handler(() => services.kimiModels.models()),
        accounts: i.accounts.handler(async () => ({ accounts: await services.kimiStore.list() })),
        disconnect: i.disconnect.handler(async ({ input }) => {
            await services.kimiStore.clear(input.id);
            return { ok: true } as const;
        }),
    };
};
