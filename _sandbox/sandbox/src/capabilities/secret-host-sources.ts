import { connectorHostDefaults } from "./contributions.js";
import type { ExtensionHost } from "./extension-inventory/installed-extensions.js";

// Enforcement may rehydrate capability settings; prompt metadata must use the enumeration-only manifest host.
export const secretHostSources = (
    host: ExtensionHost,
    { manifestHost }: { readonly manifestHost: ExtensionHost },
    read = connectorHostDefaults,
) => ({
    connectorHosts: () => read(host),
    connectorHostMetadata: () => read(manifestHost),
});
