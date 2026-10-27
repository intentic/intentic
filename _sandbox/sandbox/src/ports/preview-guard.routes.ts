import { portsContract } from "@intentic/sandbox-contract/contracts/ports.contract";
import { implement, ORPCError } from "@orpc/server";
import type { OrpcContext } from "../app-env.js";
import { bearerFrom } from "../auth/auth.js";
import { listenerIn } from "../auth/proofs/listener.js";
import type { Services } from "../composition.js";
import { PREVIEW_PASS_PATH } from "../auth/previews/preview-guard.js";

// The owner's guard on previews (auth/previews/preview-guard.ts), beside the forwards it covers: reading it, choosing it, and
// the pass a member's browser opens a guarded preview with.

const NOT_OURS = "That is not one of this sandbox's preview addresses.";

export const createPreviewGuardRoutes = (services: Pick<Services, "auth" | "previewGuards">) => {
    const i = implement(portsContract).$context<OrpcContext>();
    return {
        previewGuard: i.previewGuard.handler(async () => ({ scope: await services.previewGuards.scope() })),
        // The owner's bearer only, as for the passkey policy: no token, and no unauthenticated loopback, changes who may
        // open previews. netd is told at once (bootstrap/netd-door.ts hears the change).
        setPreviewGuard: i.setPreviewGuard.handler(async ({ input, context }) => {
            const refusal = "Only the signed-in owner may change who opens this sandbox's previews.";
            if (services.auth === undefined) {
                throw new ORPCError("FORBIDDEN", { message: refusal });
            }
            try {
                await services.auth.authorizeOwner(bearerFrom(context.headers.get("authorization") ?? undefined), listenerIn(context.headers));
            } catch {
                // allow(silent-catch): every way the owner check fails is the same refusal to this caller.
                throw new ORPCError("FORBIDDEN", { message: refusal });
            }
            return { scope: await services.previewGuards.set(input.scope) };
        }),
        // The address to send this browser to: as asked where nothing guards it, else through a one-time link on the
        // preview's own host. Only this sandbox's own preview names are answered at all, so the editor's /preview-pass
        // never forwards a browser, or a ticket, anywhere else.
        previewPass: i.previewPass.handler(async ({ input, context }) => {
            let url: URL;
            try {
                url = new URL(input.url);
            } catch {
                // allow(silent-catch): an address that does not parse is answered as one that is not this sandbox's.
                throw new ORPCError("BAD_REQUEST", { message: NOT_OURS });
            }
            const kind = services.previewGuards.kindOf(url);
            if (kind === undefined) {
                throw new ORPCError("BAD_REQUEST", { message: NOT_OURS });
            }
            if (!(await services.previewGuards.covers(kind))) {
                return { url: input.url };
            }
            const email = context.identity?.email;
            if (email === undefined) {
                throw new ORPCError("FORBIDDEN", { message: "Previews here open for the sandbox's signed-in members." });
            }
            const link = new URL(PREVIEW_PASS_PATH, url.origin);
            link.searchParams.set("ticket", services.previewGuards.ticket(email, url.hostname));
            link.searchParams.set("to", `${url.pathname}${url.search}`);
            // A fragment never reaches a server; on the link, the browser carries it through the redirect.
            link.hash = url.hash;
            return { url: link.toString() };
        }),
    };
};
