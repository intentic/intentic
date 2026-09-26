import { memorySecretVault } from "../capabilities/capabilities-slice.testing.js";
import type { ExtensionsSlice } from "./extensions-slice.js";

// The extensions slice as route suites stand it up (harness/route-services.testing.ts). Not part of the build.

export const extensionsSliceFake = () =>
    ({
        // Host simply not running, the honest default: extensions read `statusOf` per row, `/x` answers 503, no token
        // verifies. Real behaviour is covered by its own integration suite.
        extensionBackend: {
            start: async () => {},
            restart: () => {},
            stop: () => {},
            status: () => ({ state: "stopped", extensions: [] }),
            statusOf: () => undefined,
            proxyTarget: () => undefined,
            isToolPath: () => false,
            verifyExtensionToken: () => undefined,
            grantFor: (extension) => `extension-token-${extension.id}`,
        },
        // Read while composing every turn's environment, not just by settings routes, so it's a fake, not unstubbed.
        extensionSecretVault: memorySecretVault(),
    }) satisfies Partial<ExtensionsSlice>;
