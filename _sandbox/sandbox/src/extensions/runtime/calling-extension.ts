import { extensionIdOf } from "@intentic/extension-manifest";
import { callingExtension } from "../../auth/grants.js";
import { type ExtensionHost, installedExtensions } from "../../capabilities/extension-inventory/installed-extensions.js";
import type { Services } from "../../composition.js";

/**
 * The identity (publisher.name) of the extension whose token a request carries, or undefined for a request that carries
 * none (a person, a panel, an agent, a program). Read from the token, never from the body, so a caller cannot speak as
 * an extension it is not.
 */
export const callingExtensionIdentity = async (
    services: Pick<Services, "extensionBackend"> & ExtensionHost,
    header: (name: string) => string | null | undefined,
): Promise<string | undefined> => {
    const caller = callingExtension(services.extensionBackend.verifyExtensionToken, header);
    if (caller === undefined) {
        return undefined;
    }
    const extension = (await installedExtensions(services)).find((candidate) => candidate.id === caller.id);
    return extension === undefined ? undefined : extensionIdOf(extension.manifest);
};
