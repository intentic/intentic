import { remoteContract } from "@intentic/sandbox-contract/contracts/remote.contract";
import { tierAtLeast } from "@intentic/sandbox-contract/schemas/shared";
import { implement, ORPCError } from "@orpc/server";
import type { OrpcContext } from "../../app-env.js";
import { actorOfCaller } from "../../audit/audit-actor.js";
import type { Services } from "../../composition.js";
import type { RemoteCaller } from "./remote-access.js";

/* The editor's `remote.*` procedures (remote.contract.ts), over services.remoteAccess (remote-access.ts). A person
   asks: a request no member's session carries (a program's credential the middleware admitted) is refused, and the
   person must hold Full access (the owner, a maintainer), as for every other act on the owner's devices: a live screen
   shows whatever the owner has open, so a member below it is refused rather than allowed to watch (2026-11-20, the
   owner's call). A daemon without auth (a loopback one with nobody to sign in) has one person, the owner.
   (2026-11-20) Whether a Windows computer's lock-screen service is set up shows nothing of its screen, so any member
   reads it, as they read the computer's switches; setting it up or removing it is Full access's, as flipping them is. */

type RemoteServices = Pick<Services, "auth" | "remoteAccess">;

// A person, never a program, with `full` saying whether they hold Full access.
const readerOf = (services: RemoteServices, context: OrpcContext): RemoteCaller => {
    const actor = actorOfCaller(context.identity, context.principal);
    if (services.auth === undefined) {
        return { actor, full: true };
    }
    if (context.identity === undefined) {
        throw new ORPCError("FORBIDDEN", { message: "a remote screen or terminal is opened by a person, not a program" });
    }
    return { actor, full: tierAtLeast(context.identity.tier, "maintainer") };
};

const callerOf = (services: RemoteServices, context: OrpcContext): RemoteCaller => {
    const caller = readerOf(services, context);
    if (!caller.full) {
        throw new ORPCError("FORBIDDEN", { message: "remote screens and terminals need Full access to this sandbox" });
    }
    return caller;
};

export const createRemoteRoutes = (services: RemoteServices) => {
    const i = implement(remoteContract).$context<OrpcContext>();
    const remote = services.remoteAccess;
    return {
        status: i.status.handler(async ({ input, context }) => await remote.status(input.device, callerOf(services, context))),
        openScreen: i.openScreen.handler(async ({ input, context }) => await remote.openScreen(input.device, input.monitor, callerOf(services, context))),
        openTerminal: i.openTerminal.handler(async ({ input, context }) => await remote.openTerminal(input, callerOf(services, context))),
        attachTerminal: i.attachTerminal.handler(async ({ input, context }) => await remote.attachTerminal(input.device, input.session, callerOf(services, context))),
        refresh: i.refresh.handler(async ({ input, context }) => await remote.refresh(input.device, input.session, callerOf(services, context))),
        closeTerminal: i.closeTerminal.handler(async ({ input, context }) => {
            await remote.closeTerminal(input.device, input.session, callerOf(services, context));
            return { ok: true } as const;
        }),
        service: i.service.handler(async ({ input, context }) => await remote.service(input.device, readerOf(services, context))),
        changeService: i.changeService.handler(async ({ input, context }) => await remote.changeService(input.device, input.action, callerOf(services, context))),
    };
};
