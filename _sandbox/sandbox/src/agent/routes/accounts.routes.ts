import { errorMessage } from "@intentic/base/errors";
import { accountsContract, type NativeProvider } from "@intentic/sandbox-contract";
import { implement, ORPCError } from "@orpc/server";
import type { Services } from "../../composition.js";
import type { OrpcContext } from "../../app-env.js";
import type { AccountDoor } from "../providers/provider-module.js";
import { PROVIDER_MODULES } from "../providers/provider-registry.js";

// One route family for every account this sandbox holds itself, provider in the path. `start` answers once there's a
// page to open; anything after surfaces only as a later account-list change.
export type AccountDoors = Partial<Record<NativeProvider, AccountDoor>>;

// Built once per module: a door holds attempts still open, so a second one would split handshakes.
export const accountDoors = (services: Services): AccountDoors =>
    Object.fromEntries(PROVIDER_MODULES.flatMap((module) => (module.accounts === undefined ? [] : [[module.id, module.accounts(services)]])));

// A door's own refusal becomes the wire's precondition failure; an ORPCError passes through untouched.
const attempted = async <T>(run: () => Promise<T>): Promise<T> => {
    try {
        return await run();
    } catch (error) {
        throw error instanceof ORPCError ? error : new ORPCError("PRECONDITION_FAILED", { message: errorMessage(error) });
    }
};

export const createAccountsRoutes = (services: Services, doors: AccountDoors = accountDoors(services)) => {
    const i = implement(accountsContract).$context<OrpcContext>();
    const doorOf = (provider: NativeProvider): AccountDoor => {
        const door = doors[provider];
        if (door === undefined) {
            throw new ORPCError("NOT_FOUND", {
                message: `${provider} holds no account of its own here: its credential is a subscription the translator holds (/translator).`,
            });
        }
        return door;
    };
    return {
        start: i.start.handler(({ input }) => attempted(() => doorOf(input.provider).start(input.variant))),
        complete: i.complete.handler(async ({ input }) => {
            const door = doorOf(input.provider);
            if (door.complete === undefined) {
                throw new ORPCError("PRECONDITION_FAILED", { message: `A ${input.provider} sign-in finishes on its own: watch the account list.` });
            }
            const account = await attempted(() =>
                door.complete!({ handshake: input.handshake, code: input.code, redirectUrl: input.redirectUrl, label: input.label }),
            );
            return account === undefined ? {} : { account };
        }),
        cancel: i.cancel.handler(({ input }) => {
            doorOf(input.provider).cancel(input.handshake);
            return { ok: true } as const;
        }),
        accounts: i.accounts.handler(async ({ input }) => ({ accounts: await doorOf(input.provider).list(input.force) })),
        rename: i.rename.handler(async ({ input }) => {
            const renamed = await attempted(() => doorOf(input.provider).rename(input.id, input.label));
            if (renamed === undefined) {
                throw new ORPCError("NOT_FOUND", { message: `No ${input.provider} account with that id is connected.` });
            }
            return renamed;
        }),
        disconnect: i.disconnect.handler(async ({ input }) => {
            await doorOf(input.provider).disconnect(input.id);
            return { ok: true } as const;
        }),
    };
};
