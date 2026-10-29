import { procedure } from "../protocol/route-meta.js";
import {
    AccountsBorrowedSchema,
    AccountsBorrowSchema,
    BorrowedAccountIdSchema,
    BorrowedAccountsSchema,
    ShareableAccountsSchema,
} from "../schemas/providers/account-sharing.js";
import { OkSchema } from "../schemas/shared.js";

// Model accounts shared between the owner's sandboxes (schemas/providers/account-sharing.ts). The owner's editor, signed
// in to both, reads what the source can share here, mints an accounts link there, and asks the target to bring the
// accounts in over it. Each of these puts a stored credential in motion: the operating tier's, and no token's.
const sharingRoute = procedure.meta({ floor: "maintainer", control: "never", panel: false });

export const sharingContract = {
    shareable: sharingRoute
        .route({
            method: "GET",
            path: "/sharing/accounts",
            summary: "What this sandbox can share with another of yours",
            description:
                "Every model account held here and how it would reach another of the owner's sandboxes: copied (a key that does not rotate), lent turn by turn (a sign-in whose renewal must stay here), or not at all, with why. No credential is in the answer.",
        })
        .output(ShareableAccountsSchema),
    borrow: sharingRoute
        .route({
            method: "POST",
            path: "/sharing/borrow",
            summary: "Bring accounts in from another of your sandboxes",
            description:
                "Over the accounts link saved as `card`, copies each named static key into this sandbox's own stores and files each lent sign-in as borrowed. Each account answers on its own, so one that fails leaves the others in.",
        })
        .input(AccountsBorrowSchema)
        .output(AccountsBorrowedSchema),
    borrowed: sharingRoute
        .route({
            method: "GET",
            path: "/sharing/borrowed",
            summary: "Accounts this sandbox borrows",
            description: "Each account another of the owner's sandboxes lends here, and which link it is borrowed through. No credential is in the answer.",
        })
        .output(BorrowedAccountsSchema),
    stop: sharingRoute
        .route({
            method: "POST",
            path: "/sharing/borrowed/stop",
            summary: "Stop borrowing an account",
            description:
                "Forgets one borrowed account here: no turn asks the source for it again. The source's own link is changed separately, by the owner's editor or on the source.",
        })
        .input(BorrowedAccountIdSchema)
        .output(OkSchema),
};
