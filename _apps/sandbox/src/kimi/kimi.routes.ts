import { kimiContract } from "@intentic/sandbox-contract";
import { implement, ORPCError } from "@orpc/server";
import type { Services } from "../composition.js";
import type { OrpcContext } from "../context.js";
import { newKimiAccount, renameKimiAccount, toAccount } from "./kimi-credentials.js";

// Kimi (Moonshot) — the sandbox owns the credential, an API key. `connect` stores a pasted key as a new account
// and returns it; `accounts` lists the connected keys (tokens never ride back); `models` is the live catalog for
// the picker; `rename` names one; `disconnect` clears the one named by id. The agent route reads the account the
// turn selected.
export const createKimiRoutes = (services: Services) => {
    const i = implement(kimiContract).$context<OrpcContext>();
    return {
        connect: i.connect.handler(async ({ input }) => {
            const account = newKimiAccount(input.apiKey, input.label ?? "");
            await services.kimiStore.write(account);
            return toAccount(account);
        }),
        models: i.models.handler(() => services.kimiModels.models()),
        accounts: i.accounts.handler(async () => ({ accounts: await services.kimiStore.list() })),
        // Rename the account named by id. A 404 rather than a silent no-op: renaming a row that another device
        // just disconnected must tell the card its list is stale, not pretend the write landed.
        rename: i.rename.handler(async ({ input }) => {
            const stored = await services.kimiStore.read(input.id);
            if (stored === undefined) {
                throw new ORPCError("NOT_FOUND", { message: "That Kimi account is no longer connected." });
            }
            const renamed = renameKimiAccount(stored, input.label);
            await services.kimiStore.write(renamed);
            return toAccount(renamed);
        }),
        disconnect: i.disconnect.handler(async ({ input }) => {
            await services.kimiStore.clear(input.id);
            return { ok: true } as const;
        }),
    };
};
