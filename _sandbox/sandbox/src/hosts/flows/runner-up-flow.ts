import type { DeviceSandboxFlow } from "@intentic/sandbox-contract/schemas/devices";
import { ORPCError } from "@orpc/server";
import type { Services } from "../../composition.js";
import { emitDefinitionToml, settingsDefinition } from "../../definition/definition.js";
import { composeEnvironment } from "../../environment/overlay.js";
import { opt } from "../../opt.js";

/* flows/: what the daemon decides about a machine's sandbox flow before relaying it (device-reports.ts
   manageDeviceSandbox): which ops an agent is too old for (device-feature-gates.ts), and this one's fill-in.

   A RUNNER BEING ADDED ON A MACHINE: what the daemon fills in over the browser's request before the machine sees it (the
   dial URL, a pairing minted straight to the machine, the settings and overlay it is built with), and the two refusals
   that must come before anything is built there. Called for `runner-up`. */

export const runnerUpFlow = async (services: Services, hostId: string, input: DeviceSandboxFlow): Promise<DeviceSandboxFlow> => {
    const parentUrl = services.config.sandbox.publicUrl;
    if (parentUrl === "") {
        throw new ORPCError("CONFLICT", {
            message: "This sandbox has no public address yet, so a runner would have nothing to dial back to. Finish its setup first.",
        });
    }
    // An id is one enrollment: a second runner under it replaces the first's (enrollment.ts `issue`), and the one already
    // working, maybe on another computer, is refused at its next connect without a word.
    const holder = (await services.runners.list()).find((runner) => runner.id === input.slug);
    if (holder !== undefined) {
        throw new ORPCError("CONFLICT", {
            message: `This sandbox already has a runner called "${input.slug}"${holder.host === undefined ? "" : ` (on ${holder.host})`}. Pick another name, or remove that runner first.`,
        });
    }
    // Overlay ships as approved bytes plus sha256, re-checked on the machine; definition ships settings only, best-effort.
    const definition = await Promise.resolve()
        .then(() => settingsDefinition(services))
        .then((settings) => (Object.keys(settings.settings).length === 0 ? undefined : emitDefinitionToml(settings)))
        // allow(silent-catch): settings ride along best-effort; the runner is built without them, never refused
        .catch(() => undefined);
    // The overlay this sandbox wants, composed now; none is no overlay, and a compose that failed throws, or the runner
    // would be built without it.
    const overlay = await composeEnvironment(services);
    return {
        ...input,
        parentUrl,
        pair: services.runners.mintPairing(input.slug, { host: hostId }).token,
        ...opt("definition", definition),
        ...opt("overlay", overlay?.content),
        ...opt("overlayHash", overlay?.hash),
    };
};
