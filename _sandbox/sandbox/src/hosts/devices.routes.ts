import type { Context } from "hono";
import type { AppEnv } from "../app-env.js";
import { devices } from "./device-reports.js";

/* GET /system/devices. Every device on the other end of this sandbox, the volunteered reports and the ones
 * pulled through a host capability, merged (hosts/device-reports.ts). Readable by any collaborator, like
 * /system/sync beside it: the bearer middleware already blocked a non-member, and a member's own mirroring
 * machine appears here. Acting on one of those devices' sandboxes is `system.manageDeviceSandbox`
 * (system.routes.ts) rather than a plain route here: every op streams, because the slowest of them takes
 * minutes, and a hand-rolled SSE response beside the oRPC surface would be a second shape for the browser
 * to parse. */
export const createDevicesRoute =
    (services: Parameters<typeof devices>[0]) =>
    async (c: Context<AppEnv>): Promise<Response> =>
        c.json({ devices: await devices(services) });
