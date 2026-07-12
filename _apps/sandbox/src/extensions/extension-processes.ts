import { join } from "node:path";
import type { ProcessContribution } from "@intentic/extension-api";
import type { Services } from "../composition.js";
import { type InstalledExtension, installedExtensions } from "./installed-extensions.js";

// The panel key (→ tmux session `panel-ext-<id>-<name>`) for one declared extension process. tmux session
// names reject dots and a baked extension's id is publisher.name, so dots are sanitized. Extension processes
// ride the panel manager unchanged — port assignment (PORT env), the liveness sweep, boot's stale-session
// kill, and the preview proxy all apply with no new machinery.
export const extensionProcessKey = (id: string, name: string): string => `ext-${id.replaceAll(".", "-")}-${name}`;

export const startExtensionProcess = async (services: Services, extension: InstalledExtension, process: ProcessContribution): Promise<void> => {
    const key = extensionProcessKey(extension.id, process.name);
    if (process.preview === true) {
        // Mint the tunneled preview hostname BEFORE the process binds (the panels-start pattern); never rejects.
        await services.ensurePreviewRoute(key);
    }
    await services.panelProcesses.start(key, {
        command: process.command,
        cwd: process.cwd === undefined ? extension.dir : join(extension.dir, process.cwd),
        // A declared process reaches the daemon's own routes (a listener gateway posting to /listeners/<provider>)
        // over loopback with the panel token — the token never leaves the container. (Flagged: the panel token
        // is all-routes; a scoped per-extension token is a named follow-up.) INTENTIC_WORKSPACE lets a process
        // that produces agent-facing files (the discord gateway's voice transcripts) write under the workspace.
        env: {
            INTENTIC_DAEMON: `http://127.0.0.1:${services.config.sandbox.port}`,
            INTENTIC_PANEL_TOKEN: services.panelToken,
            INTENTIC_WORKSPACE: services.workspace.root,
        },
    });
};

// autoStart processes for one extension — after a successful install (the capabilities add route's post-apply
// seam) and at boot convergence.
export const startAutoStartProcesses = async (services: Services, extension: InstalledExtension): Promise<void> => {
    for (const process of extension.manifest.contributes?.processes ?? []) {
        if (process.autoStart === true) {
            await startExtensionProcess(services, extension, process);
        }
    }
};

// Boot convergence (beside startEnabledDocker): sessions died with the container / the boot sweep while the
// manifests survived — bring every installed extension's autoStart processes back up. Best-effort.
export const startAllExtensionProcesses = async (services: Services): Promise<void> => {
    for (const extension of await installedExtensions(services)) {
        await startAutoStartProcesses(services, extension);
    }
};
