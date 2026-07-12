import type { ExtensionManifest, ExtensionModule } from "@intentic/extension-api";
import { extensionIdOf } from "@intentic/extension-api";
import * as agentActivity from "@intentic/ext-agent-activity";
import * as automations from "@intentic/ext-automations";
import * as logs from "@intentic/ext-logs";
import { createExtensionApi, type HostBindings } from "./apiImpl";

/* The compiled-in first-party extensions. Each is a real in-repo extension package (its own
 * intentic-extension.json + activate), activated through the SAME manifest-gated createExtensionApi path as a
 * git-installed third-party bundle — the only difference is they are statically imported and compiled into the
 * shell rather than blob-loaded from the daemon. This is the dogfooding boundary: a builtin can only touch the
 * public IntenticApi, never app internals. */

interface Builtin {
    readonly manifest: ExtensionManifest;
    readonly module: ExtensionModule;
}

const builtins: readonly Builtin[] = [
    { manifest: automations.manifest, module: automations },
    { manifest: logs.manifest, module: logs },
    { manifest: agentActivity.manifest, module: agentActivity },
];

// Activate every builtin at shell boot, ahead of the daemon-installed extensions. A builtin's activate() only
// registers views/commands (synchronous); any data it fetches runs on its own via the host api. A throwing
// builtin is contained so one bad first-party extension can't blank the shell.
export const loadBuiltins = (host: HostBindings): void => {
    for (const { manifest, module } of builtins) {
        const id = extensionIdOf(manifest);
        try {
            const { api, context } = createExtensionApi({ id, manifest, commit: `builtin` }, host);
            void module.activate(api, context);
        } catch (error) {
            console.error(`builtin extension ${id} failed to activate`, error);
        }
    }
};
