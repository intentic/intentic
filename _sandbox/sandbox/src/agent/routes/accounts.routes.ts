import { errorMessage } from "@intentic/base/errors";
import { accountsContract } from "@intentic/sandbox-contract/contracts/accounts.contract";
import type { NativeProvider } from "@intentic/sandbox-contract/models/provider-specs";
import { implement, ORPCError } from "@orpc/server";
import type { Services } from "../../composition.js";
import type { OrpcContext } from "../../app-env.js";
import type { AccountDoor } from "../providers/provider-module.js";
import { createAccountAttribution } from "./account-attribution.js";

// One route family for every account this sandbox holds itself, provider in the path. `start` answers once there's a
// page to open; anything after surfaces as the attempt's `status` where the door keeps one, else as a later
// account-list change. Who connected each account is recorded on the way (account-attribution.ts).
export type AccountDoors = Partial<Record<NativeProvider, AccountDoor>>;

// Built once per module: a door holds attempts still open, so a second one would split handshakes.
export const accountDoors = (services: Services): AccountDoors =>
    Object.fromEntries(services.providerModules.flatMap((module) => (module.accounts === undefined ? [] : [[module.id, module.accounts(services)]])));

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
    // One per route family, like the doors: an attempt started here is the one a later listing attributes.
    const attribution = createAccountAttribution(services);
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
        start: i.start.handler(({ input, context }) => {
            const door = doorOf(input.provider);
            return attribution.start(input.provider, context.identity, door, () => attempted(() => door.start(input.variant)));
        }),
        complete: i.complete.handler(async ({ input, context }) => {
            const door = doorOf(input.provider);
            if (door.complete === undefined) {
                throw new ORPCError("PRECONDITION_FAILED", { message: `A ${input.provider} sign-in finishes on its own: watch the account list.` });
            }
            const account = await attempted(() =>
                door.complete!({ handshake: input.handshake, code: input.code, redirectUrl: input.redirectUrl, label: input.label }),
            );
            const recorded = await attribution.landed(input.provider, input.handshake, account, context.identity?.email);
            return recorded === undefined ? {} : { account: recorded };
        }),
        // A door that keeps no record of its attempts answers from the account list's side: the card goes on watching it.
        // An attempt the status reports connected is its starter's; one that failed is done with.
        status: i.status.handler(async ({ input }) => {
            const door = doorOf(input.provider);
            if (door.status === undefined) {
                throw new ORPCError("PRECONDITION_FAILED", { message: `A ${input.provider} sign-in is watched through its account list.` });
            }
            const status = door.status(input.handshake);
            if (status.status === "error") {
                attribution.dropped(input.handshake);
            }
            if (status.status !== "ok" || status.account === undefined) {
                return status;
            }
            const account = await attribution.landed(input.provider, input.handshake, status.account);
            return account === undefined ? status : { ...status, account };
        }),
        cancel: i.cancel.handler(({ input }) => {
            doorOf(input.provider).cancel(input.handshake);
            attribution.dropped(input.handshake);
            return { ok: true } as const;
        }),
        // Each row carries the facts the one serviceability rule judges (plan-pools.ts serviceStates), never a verdict:
        // the reader judges them with every refusal on file, the way the daemon does.
        // Each names who connected it, where a person here did; a row a device sign-in added is told whose first.
        accounts: i.accounts.handler(async ({ input }) => ({
            accounts: await attribution.listed(input.provider, await doorOf(input.provider).list(input.force)),
        })),
        // Below Full access, a person reaches these through their own-accounts right, so only for what they connected.
        rename: i.rename.handler(async ({ input, context }) => {
            const door = doorOf(input.provider);
            await attribution.ensureOwn(context.identity, input.provider, input.id);
            const renamed = await attempted(() => door.rename(input.id, input.label));
            if (renamed === undefined) {
                throw new ORPCError("NOT_FOUND", { message: `No ${input.provider} account with that id is connected.` });
            }
            return renamed;
        }),
        disconnect: i.disconnect.handler(async ({ input, context }) => {
            const door = doorOf(input.provider);
            await attribution.ensureOwn(context.identity, input.provider, input.id);
            await door.forget(input.id);
            await attribution.forgotten(input.provider, input.id);
            return { ok: true } as const;
        }),
    };
};
