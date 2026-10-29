import { sharingContract } from "@intentic/sandbox-contract/contracts/sharing.contract";
import { implement, ORPCError } from "@orpc/server";
import { forgetAccountState } from "../agent/providers/accounts/account-identity.js";
import type { OrpcContext } from "../app-env.js";
import type { Services } from "../composition.js";
import { providerKeyDeps } from "../migrations/provider-keys.js";
import { borrowAccounts, type BorrowingDeps } from "./accounts/borrowing.js";
import { heldAccounts, shareableOf } from "./accounts/held-accounts.js";

// Model accounts shared between the owner's sandboxes (schemas/providers/account-sharing.ts): what this sandbox could
// share, bringing accounts in from another over an accounts link, and the ones it borrows. The owner's editor drives
// both sandboxes: it reads the source here, mints the link there, and asks the target to bring the accounts in.

const borrowingDepsOf = (services: Services): BorrowingDeps => {
    const keys = providerKeyDeps(services);
    return {
        store: services.borrowedAccounts,
        cards: () => services.capabilities.list(),
        copies: {
            cursorStore: services.cursorStore,
            devinStore: services.devinStore,
            devinModels: services.devinModels,
            minted: services.minted,
            capabilities: services.capabilities,
            addEndpoint: keys.addEndpoint,
        },
        settle: keys.settle,
        // The picker's Claude models are read per account: a newly borrowed one changes what it may offer.
        borrowed: () => services.claudeModels.forget(),
        logger: services.logger,
    };
};

export const createSharingRoutes = (services: Services) => {
    const i = implement(sharingContract).$context<OrpcContext>();
    return {
        shareable: i.shareable.handler(async () => ({
            sandbox: services.info?.name ?? "this sandbox",
            accounts: shareableOf(await heldAccounts(services)),
        })),
        borrow: i.borrow.handler(async ({ input }) => await borrowAccounts(borrowingDepsOf(services), input)),
        borrowed: i.borrowed.handler(async () => ({ accounts: [...(await services.borrowedAccounts.list())] })),
        stop: i.stop.handler(async ({ input }) => {
            const removed = await services.borrowedAccounts.remove(input.id);
            if (removed === undefined) {
                throw new ORPCError("NOT_FOUND", { message: "This sandbox borrows no account by that id." });
            }
            if (removed.provider === "claude") {
                await forgetAccountState(services, "claude", removed.id);
                services.claudeModels.forget();
            }
            services.logger.info({ account: removed.id, provider: removed.provider, from: removed.from.name }, "sharing: stopped borrowing an account");
            return { ok: true } as const;
        }),
    };
};
