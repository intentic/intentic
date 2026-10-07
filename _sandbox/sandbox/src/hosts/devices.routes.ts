import { type DeviceFlowLine, type DeviceSandboxFlowInput, type DeviceSandboxOp, systemContract } from "@intentic/sandbox-contract";
import { sandboxSlugOf } from "@intentic/sandbox-run";
import { implement } from "@orpc/server";
import { askedRestart, fileRestartResume } from "../system/restart-resume.js";
import { requireMaintainer } from "../auth/owner-gates.js";
import type { OrpcContext } from "../app-env.js";
import type { Services } from "../composition.js";
import { opt } from "../opt.js";
import { runDeviceCommand } from "./device-commands.js";
import { devices, manageDeviceSandbox, runDeviceAgentFlow } from "./device-reports.js";

// The ops that end by restarting the container they name, so a `resumeTurns` ask is about their restart.
const RESTARTING: ReadonlySet<DeviceSandboxOp> = new Set(["restart", "update", "rebuild", "rollback"]);

/* The `system.*Device*` procedures, implemented where the devices themselves live rather than in system/system.routes.ts. */
export const createDeviceSystemRoutes = (services: Services) => {
    const i = implement(systemContract).$context<OrpcContext>();
    // The flow as the machine takes it, field by field: anything only this door reads (`resumeTurns`) stays here.
    const relayed = (input: DeviceSandboxFlowInput): AsyncGenerator<DeviceFlowLine> =>
        manageDeviceSandbox(services, input.id, {
            op: input.op,
            slug: input.slug,
            ...(input.hash === undefined ? {} : { hash: input.hash }),
            // `rollback`'s chosen target, and the code `reconnect`/`create` redeem: dropping either rolled back to the
            // previous version instead of the one picked, and sent a reconnect with nothing to redeem.
            ...opt("to", input.to),
            ...opt("setupCode", input.setupCode),
            // `set-shape`'s payload: a whole shape and when it takes effect, a closed form the machine spells into
            // `ic` flags, never a command line.
            ...(input.shape === undefined ? {} : { shape: input.shape }),
            ...(input.when === undefined ? {} : { when: input.when }),
            // The old `reshape` op's delta and its `later`, read for one release from pages older than `set-shape`.
            ...(input.resources === undefined ? {} : { resources: input.resources }),
            ...(input.later === true ? { later: true } : {}),
        });
    return {
        // The merged fleet view. No maintainer floor: this is what every devices-aware card reads to draw itself, and
        // the doors it leads to carry their own.
        devices: i.devices.handler(async () => ({ devices: await devices(services) })),
        // Acts on a sandbox on one of the user's devices, streaming the machine's own output; this door can also delete
        // one. Everything past the gate is the machine's call, including refusing, which arrives as the stream's own
        // terminal error.
        manageDeviceSandbox: i.manageDeviceSandbox.handler(async function* ({ input, context }) {
            await requireMaintainer(services, context.headers, "only a sandbox maintainer can act on connected devices");
            // The owner restarting THIS sandbox and asking for the turns it cuts back: kept for the next boot, which
            // resumes them (restart-resume.ts).
            const restartsThis = RESTARTING.has(input.op) && input.slug === sandboxSlugOf(services.config.sandbox.name);
            const resume = fileRestartResume(services.config.historyRoot);
            if (restartsThis && input.resumeTurns !== true) {
                // An ask left standing by an earlier restart whose refusal nobody stayed to relay is not this one's.
                await resume.withdraw();
            }
            yield* restartsThis && input.resumeTurns === true ? askedRestart(resume, Date.now(), relayed(input)) : relayed(input);
        }),
        // One named CLI action on a connected device (e.g. the Devices tab's Stop-mirroring button).
        // `sync-install` needs no extra gate for its mode: this floor is the same maintainer-equivalent one
        // /system/sync/pair applies to the one-liner it enrolls with (auth/owner-gates.ts).
        runDeviceCommand: i.runDeviceCommand.handler(async ({ input, context }) => {
            await requireMaintainer(services, context.headers, "only a sandbox maintainer can act on connected devices");
            return await runDeviceCommand(services, input);
        }),
        // Updates or restarts the agent on a connected device; maintainer-floored, since this replaces the binary
        // everything else on that machine runs through.
        runDeviceAgentFlow: i.runDeviceAgentFlow.handler(async function* ({ input, context }) {
            await requireMaintainer(services, context.headers, "only a sandbox maintainer can update a connected device's agent");
            yield* runDeviceAgentFlow(services, input.id, { op: input.op });
        }),
    };
};
