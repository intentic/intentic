import { errorMessage } from "@intentic/base/errors";
import { accountsContract, type NativeProvider } from "@intentic/sandbox-contract";
import { implement, ORPCError } from "@orpc/server";
import type { Services } from "../../composition.js";
import type { OrpcContext } from "../../app-env.js";
import type { AccountDoor } from "../providers/provider-module.js";
import { PROVIDER_MODULES } from "../providers/provider-registry.js";

/* ONE ROUTE FAMILY FOR EVERY ACCOUNT THE SANDBOX HOLDS ITSELF, with the provider in the path (accounts.contract.ts
 * says why). Each provider's mechanism is its module's door (provider-module.ts AccountDoor); what is here is
 * the part every door shares: which provider was asked for, and how a door's answers become the wire's.
 *
 * THE SIGN-IN'S FAILURES SPLIT IN TWO, and which half a failure lands in is not a detail: `start` answers as
 * soon as there is a page to open, so everything before that (a vendor that will not begin a flow, an estate
 * id that names nothing) is this route's 412 with the door's own sentence, while everything after it (the
 * approval, the poll, the mint) happens behind the answer and lands as a log line and no new account. That is
 * why the card watches the account list rather than a promise. */
export type AccountDoors = Partial<Record<NativeProvider, AccountDoor>>;

// Every module's door, built once: a door holds the attempts still open, so two of them would be two sets of
// handshakes that cannot finish each other's sign-ins.
export const accountDoors = (services: Services): AccountDoors =>
    Object.fromEntries(PROVIDER_MODULES.flatMap((module) => (module.accounts === undefined ? [] : [[module.id, module.accounts(services)]])));

// A door's own refusal, in its own words, as the wire's precondition failure. An ORPCError passes through.
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
