import type { Context } from "hono";
import type { Services } from "../../composition.js";
import { defineRawRoutes } from "../../http/raw-route-server.js";
import { bearerPeer } from "../../peers/peer-store.js";

export type HostKeyringRoutesDeps = Pick<Services, "hosts" | "keyringLink" | "logger">;

// Passwords on an owner's computer answered a request or changed its entries (2026-10-20): read that keyring now
// rather than on the minute refresh (device-secrets.ts), which stays as the fallback. The read's own listeners do the
// rest: a request it now finds served turns allowed and wakes its conversation (keyring-needs.ts), and open needs check
// again (needs-slice.ts). Authenticated by the machine's own link token, so only a connected computer can ask, and only
// for itself. Answered before the read finishes: the app that pushed waits on nothing.
const createHostKeyringChangedRoute =
    (services: HostKeyringRoutesDeps) =>
    async (c: Context): Promise<Response> => {
        const machine = await bearerPeer(services.hosts, c);
        if (typeof machine !== "string") {
            return machine;
        }
        void services.keyringLink.refresh(machine).catch((error: Error) => services.logger.warn({ err: error, machine }, "keyring: a pushed change could not be read"));
        return c.json({ ok: true }, 202);
    };

export const hostKeyringRawRoutes = defineRawRoutes((services: HostKeyringRoutesDeps) => ({
    "POST /system/hosts/keyring-changed": createHostKeyringChangedRoute(services),
}));
