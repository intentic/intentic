import { systemContract } from "@intentic/sandbox-contract";
import { implement, ORPCError } from "@orpc/server";
import { authorizeMaintainer, bearerFrom } from "../auth/auth.js";
import type { OrpcContext } from "../app-env.js";
import type { Services } from "../composition.js";
import { runDeviceCommand } from "./device-commands.js";
import { devices, manageDeviceSandbox, runDeviceAgentFlow } from "./device-reports.js";

/* The `system.*Device*` procedures, implemented where the devices themselves live rather than in system/system.routes.ts. */
export const createDeviceSystemRoutes = (services: Services) => {
    const i = implement(systemContract).$context<OrpcContext>();
    // Every door here is maintainer-floored, checked identically so all three refuse the same way.
    const requireMaintainer = async (headers: Headers, refusal: string): Promise<void> => {
        if (services.auth === undefined) {
            return;
        }
        try {
            await authorizeMaintainer(services.auth, bearerFrom(headers.get("authorization") ?? undefined));
        } catch {
            throw new ORPCError("FORBIDDEN", { message: refusal });
        }
    };
    return {
        // The merged fleet view. No maintainer floor: this is what every devices-aware card reads to draw itself, and
        // the doors it leads to carry their own.
        devices: i.devices.handler(async () => ({ devices: await devices(services) })),
        // Acts on a sandbox on one of the user's devices, streaming the machine's own output; this door can also delete
        // one. Everything past the gate is the machine's call, including refusing, which arrives as the stream's own
        // terminal error.
        manageDeviceSandbox: i.manageDeviceSandbox.handler(async function* ({ input, context }) {
            await requireMaintainer(context.headers, "only a sandbox maintainer can act on connected devices");
            yield* manageDeviceSandbox(services, input.id, {
                op: input.op,
                slug: input.slug,
                ...(input.hash === undefined ? {} : { hash: input.hash }),
                // The reshape's payload: a closed form the machine spells into `ic` flags, never a command line.
                ...(input.resources === undefined ? {} : { resources: input.resources }),
                // Save the reshape for the sandbox's next restart instead of restarting it now.
                ...(input.later === true ? { later: true } : {}),
            });
        }),
        // One named CLI action on a connected device (e.g. the Devices tab's Stop-mirroring button).
        // `sync-install` needs no extra gate for its mode: this floor is the same maintainer-equivalent one
        // /system/sync/pair applies to the one-liner it enrolls with (auth/owner-gates.ts).
        runDeviceCommand: i.runDeviceCommand.handler(async ({ input, context }) => {
            await requireMaintainer(context.headers, "only a sandbox maintainer can act on connected devices");
            return await runDeviceCommand(services, input);
        }),
        // Updates or restarts the agent on a connected device; maintainer-floored, since this replaces the binary
        // everything else on that machine runs through.
        runDeviceAgentFlow: i.runDeviceAgentFlow.handler(async function* ({ input, context }) {
            await requireMaintainer(context.headers, "only a sandbox maintainer can update a connected device's agent");
            yield* runDeviceAgentFlow(services, input.id, { op: input.op });
        }),
    };
};
