import { errorMessage } from "@intentic/base/errors";
import { mintedContract } from "@intentic/sandbox-contract";
import { implement, ORPCError } from "@orpc/server";
import type { Services } from "../composition.js";
import type { OrpcContext } from "../context.js";
import { cancelMintedLogin, cancelMintedLoginsFor, completeMintedLogin, startMintedLogin } from "./minted-login.js";

/* CONNECTING A PROVIDER WHOSE SIGN-IN MINTS ITS OWN KEY (Sandbox ▸ Agent). Six handlers over every minted
 * provider, because the provider is a route parameter (minted.contract.ts says why) and the operations are the
 * same ones for all of them: start a sign-in, finish the one shape that dead-ends, abandon one, list what is
 * connected, rename a row, remove it.
 *
 * THE SIGN-IN'S FAILURES SPLIT IN TWO, and which half a failure lands in is not a detail: `start` answers as
 * soon as there is a page to open, so everything before that (a vendor that will not begin a flow, an estate id
 * that names nothing) is this route's 412, while everything after it (the approval, the poll, the mint) happens
 * behind the answer and lands as a log line and no new account. That is the same bargain Cursor's login makes,
 * and the reason the card watches the account list rather than a promise.
 *
 * THE CATALOG IS FORGOTTEN ON EVERY WRITE. It is read with a connected account's key and cached for a minute;
 * connecting or disconnecting changes which account that is, or whether there is one at all. Without the forget,
 * a sandbox that just disconnected its only Z.ai plan would keep offering that key's model list — and, worse, a
 * turn resolved against it — for the rest of the TTL. The connect side of that is inside the login (it lands
 * minutes after this route answered); the disconnect side is here. */
export const createMintedRoutes = (services: Pick<Services, "minted" | "logger">) => {
    const i = implement(mintedContract).$context<OrpcContext>();
    return {
        start: i.start.handler(async ({ input }) => {
            const slice = services.minted[input.provider];
            try {
                return await startMintedLogin({
                    provider: input.provider,
                    ...(input.variant !== undefined ? { variant: input.variant } : {}),
                    driver: slice.login,
                    store: slice.store,
                    logger: services.logger,
                    onConnected: () => slice.catalog.forget(),
                });
            } catch (error) {
                // The vendor would not begin, or the estate names nothing: a precondition, and its message is
                // the one the card shows, so it is passed through rather than replaced with a status.
                throw new ORPCError("PRECONDITION_FAILED", { message: errorMessage(error) });
            }
        }),
        complete: i.complete.handler(({ input }) => {
            try {
                completeMintedLogin({ provider: input.provider, handshake: input.handshake, redirectUrl: input.redirectUrl });
            } catch (error) {
                throw new ORPCError("PRECONDITION_FAILED", { message: errorMessage(error) });
            }
            return { ok: true as const };
        }),
        cancel: i.cancel.handler(({ input }) => {
            cancelMintedLogin(input.provider, input.handshake);
            return { ok: true as const };
        }),
        accounts: i.accounts.handler(async ({ input }) => ({ accounts: await services.minted[input.provider].store.list() })),
        rename: i.rename.handler(async ({ input }) => {
            const renamed = await services.minted[input.provider].store.rename(input.id, input.label);
            // A rename that matched nothing is the caller addressing an account that is gone, which is a 404
            // rather than a silent success: the row they are looking at no longer exists and the page should
            // say so instead of appearing to have applied the change.
            if (renamed === undefined) {
                throw new ORPCError("NOT_FOUND", { message: `No ${input.provider} account with that id is connected.` });
            }
            return { ok: true } as const;
        }),
        disconnect: i.disconnect.handler(async ({ input }) => {
            const slice = services.minted[input.provider];
            /* A SIGN-IN STILL IN FLIGHT DIES WITH THE DISCONNECT. Its poll would otherwise land a fresh
             * credential into a store the user has just cleared out, minutes after they cleared it — the same
             * reasoning the translator's codex disconnect kills its pending device login for. */
            cancelMintedLoginsFor(input.provider);
            await slice.store.disconnect(input.id);
            slice.catalog.forget();
            return { ok: true } as const;
        }),
    };
};
