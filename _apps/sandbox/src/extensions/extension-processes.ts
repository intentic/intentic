import { join } from "node:path";
import type { ProcessContribution } from "@intentic/extension-api";
import type { Capability } from "@intentic/sandbox-contract";
import { extensionDir, extensionRootOf, readExtensionManifest } from "../capabilities/extension-dirs.js";
import type { Services } from "../composition.js";

type ExtensionCapability = Extract<Capability, { kind: "extension" }>;

// The panel key (→ tmux session `panel-ext-<id>-<name>`) for one declared extension process. Extension
// processes ride the panel manager unchanged — port assignment (PORT env), the liveness sweep, boot's
// stale-session kill, and the preview proxy all apply with no new machinery.
export const extensionProcessKey = (id: string, name: string): string => `ext-${id}-${name}`;

// The extension root of a checkout (config.path for marketplace/monorepo-hosted extensions).
const rootOf = (services: Services, capability: ExtensionCapability): string =>
    extensionRootOf(extensionDir(services.workspace.root, capability.id), capability.config.path);

// The manifest's declared processes; empty when the checkout rotted (install-time validation already passed).
export const declaredProcesses = async (services: Services, capability: ExtensionCapability): Promise<readonly ProcessContribution[]> => {
    const manifest = await readExtensionManifest(services.files.read, rootOf(services, capability));
    return manifest?.contributes?.processes ?? [];
};

export const startExtensionProcess = async (services: Services, capability: ExtensionCapability, process: ProcessContribution): Promise<void> => {
    const dir = rootOf(services, capability);
    const key = extensionProcessKey(capability.id, process.name);
    if (process.preview === true) {
        // Mint the tunneled preview hostname BEFORE the process binds (the panels-start pattern); never rejects.
        await services.ensurePreviewRoute(key);
    }
    await services.panelProcesses.start(key, { command: process.command, cwd: process.cwd === undefined ? dir : join(dir, process.cwd) });
};

// autoStart processes for one extension — after a successful install (the capabilities add route's post-apply
// seam, beside composeEnvironment).
export const startAutoStartProcesses = async (services: Services, capability: ExtensionCapability): Promise<void> => {
    for (const process of await declaredProcesses(services, capability)) {
        if (process.autoStart === true) {
            await startExtensionProcess(services, capability, process);
        }
    }
};

// Boot convergence (beside startEnabledDocker): sessions died with the container / the boot sweep while the
// manifests survived on /work — bring every installed extension's autoStart processes back up. Best-effort.
export const startAllExtensionProcesses = async (services: Services): Promise<void> => {
    for (const capability of await services.capabilities.list()) {
        if (capability.kind === "extension") {
            await startAutoStartProcesses(services, capability);
        }
    }
};
