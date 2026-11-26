import { declaredReachOf, extensionIdOf } from "@intentic/extension-manifest";
import type { Automation } from "@intentic/sandbox-contract/schemas/automations";
import { ORPCError } from "@orpc/server";
import { cachedEnabledExtensions } from "../../capabilities/contributions.js";
import type { ExtensionHost } from "../../capabilities/extension-inventory/installed-extensions.js";
import type { Services } from "../../composition.js";

// (2026-11-26) Who is saving, where it decides what may be saved: the extension whose token the request carried
// (its publisher.name), for the extension target below. Absent for a person, an approved proposal, or a program.
export interface AutomationSaver {
    readonly extension?: string | undefined;
}

// An automation that wakes an extension's code names that extension, and only that extension points one at itself, so
// one extension never wakes another's code and an agent's proposal wakes none. A person may edit one an extension saved
// (its schedule, its switch) as long as the target stays the one it had. The handler must be one the extension declares
// (`permissions.fires`), checked again as it fires (extensions/backend/extension-fires.ts).
export const refuseForeignExtensionTarget = async (
    services: Pick<Services, "automations"> & ExtensionHost,
    automation: Automation,
    saver: AutomationSaver | undefined,
): Promise<void> => {
    const target = automation.target;
    if (target?.kind !== "extension") {
        return;
    }
    const kept = (await services.automations.get(automation.id))?.target;
    const keeps = kept?.kind === "extension" && kept.extension === target.extension && kept.handler === target.handler;
    if (saver?.extension === undefined ? !keeps : saver.extension !== target.extension) {
        throw new ORPCError("FORBIDDEN", {
            message: `only the extension ${target.extension} itself can point an automation at its own code; save it from that extension, or pick another target`,
        });
    }
    const extension = (await cachedEnabledExtensions(services)).find((each) => extensionIdOf(each.manifest) === target.extension);
    if (extension === undefined || !declaredReachOf(extension.manifest.permissions).fires.includes(target.handler)) {
        throw new ORPCError("BAD_REQUEST", { message: `extension ${target.extension} is not enabled with a "${target.handler}" handler in its permissions.fires` });
    }
};

