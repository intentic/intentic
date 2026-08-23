import { cursorContract } from "@intentic/sandbox-contract";
import { implement, ORPCError } from "@orpc/server";
import type { Services } from "../composition.js";
import type { OrpcContext } from "../context.js";
import { cancelCursorLogin, displayLabel, startCursorLogin, toAccount } from "./cursor-credentials.js";
import { CURSOR_SDK_MISSING } from "./cursor-sdk.js";

/* Cursor account routes: begin a sign-in, abandon one, list what is connected, rename a row, disconnect it.
 * The Claude routes' shape without the `exchange` half — Cursor's handshake finishes inside the daemon, so
 * there is nothing for a caller to hand back (see cursor.contract.ts).
 *
 * `force` is accepted on the list and does nothing, deliberately. It is on the shared account-list query that
 * both providers' cards use, and it means "re-measure the plan limits before answering". Cursor publishes no
 * plan-wide allowance to re-measure, so there is no reading to force and no slow path to take; refusing the
 * parameter would only mean the two account lists could not share one component. */
export type CursorRoutesDeps = Pick<Services, "cursorStore">;

// The name this sandbox's key carries in Cursor's own dashboard API-keys list. It has to be recognisable
// there and it has to distinguish one sandbox from the owner's laptop, because revoking the right key is a
// thing people do at exactly the moment they cannot ask anyone which one it is.
const keyName = (): string => `intentic sandbox (${process.env["INTENTIC_WORKSPACE_NAME"] ?? "workspace"})`;

export const createCursorRoutes = (services: CursorRoutesDeps) => {
    const i = implement(cursorContract).$context<OrpcContext>();
    return {
        start: i.start.handler(async () => {
            try {
                return await startCursorLogin({ store: services.cursorStore, keyName: keyName() });
            } catch (error) {
                // The one failure worth naming: an image with no Cursor runtime cannot start a sign-in, and
                // the fix is a rebuild rather than anything the sign-in card can do.
                const message = error instanceof Error ? error.message : String(error);
                throw new ORPCError("PRECONDITION_FAILED", { message: message === CURSOR_SDK_MISSING ? CURSOR_SDK_MISSING : message });
            }
        }),
        cancel: i.cancel.handler(({ input }) => {
            cancelCursorLogin(input.handshake);
            return { ok: true as const };
        }),
        accounts: i.accounts.handler(async () => ({ accounts: await services.cursorStore.list() })),
        rename: i.rename.handler(async ({ input }) => {
            const stored = await services.cursorStore.read(input.id);
            if (stored === undefined) {
                // A 404 rather than a silent no-op: renaming a row another device just disconnected has to tell
                // the card its list is stale, not pretend the write landed.
                throw new ORPCError("NOT_FOUND", { message: "That Cursor account is no longer connected." });
            }
            const label = input.label.trim();
            // A blank label CLEARS the override rather than storing an empty string, so the row falls back to
            // the sign-in identity instead of becoming nameless (displayLabel owns that ladder).
            const renamed = label === "" ? { ...stored, label: undefined } : { ...stored, label };
            await services.cursorStore.write(renamed);
            return toAccount(renamed);
        }),
        disconnect: i.disconnect.handler(async ({ input }) => {
            await services.cursorStore.clear(input.id);
            return { ok: true as const };
        }),
    };
};

// Re-exported so the account rows on the secrets page can name a connection the same way the Agent tab does.
export { displayLabel };
