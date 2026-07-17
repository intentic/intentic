import { join } from "node:path";
import type { ProcessContribution } from "@intentic/extension-api";
import type { Services } from "../composition.js";
import { type ExtensionHost, type InstalledExtension, installedExtensions } from "./installed-extensions.js";
import { listenerProcessesDesired, listenerState } from "./listener-state.js";

// The panel key (→ tmux session `panel-ext-<id>-<name>`) for one declared extension process. tmux session
// names reject dots and a baked extension's id is publisher.name, so dots are sanitized. Extension processes
// ride the panel manager unchanged — port assignment (PORT env), the liveness sweep, boot's stale-session
// kill, and the preview proxy all apply with no new machinery. The prefix is how the terminals list tells an
// extension process apart from a dev-server panel (kind "process" vs "panel").
export const EXTENSION_PROCESS_PREFIX = "ext-";
export const extensionProcessKey = (id: string, name: string): string => `${EXTENSION_PROCESS_PREFIX}${id.replaceAll(".", "-")}-${name}`;

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
// seam) and at boot convergence. A listener extension's processes exist only while its provider is wanted
// (listenerProcessesDesired), so a fresh sandbox runs no idle gateway for an integration nobody enabled.
export const startAutoStartProcesses = async (services: Services, extension: InstalledExtension): Promise<void> => {
    const listener = extension.manifest.contributes?.listener;
    if (listener !== undefined && !listenerProcessesDesired(await listenerState(services, listener.provider))) {
        return;
    }
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

// Converge listener-extension processes after an automations or capabilities mutation: bring a now-wanted
// gateway up, stop a no-longer-wanted one (start is a no-op when already running). Best-effort and detached —
// a reconcile failure logs, it never fails the mutation that triggered it. Stops only what the manager tracks
// (`running`): an untracked key has no session left to kill.
export const reconcileListenerProcesses = async (services: Services): Promise<void> => {
    try {
        for (const extension of await installedExtensions(services)) {
            const listener = extension.manifest.contributes?.listener;
            if (listener === undefined) {
                continue;
            }
            const desired = listenerProcessesDesired(await listenerState(services, listener.provider));
            for (const process of extension.manifest.contributes?.processes ?? []) {
                if (process.autoStart !== true) {
                    continue;
                }
                if (desired) {
                    await startExtensionProcess(services, extension, process);
                } else {
                    const key = extensionProcessKey(extension.id, process.name);
                    if (services.panelProcesses.running(key)) {
                        services.panelProcesses.stop(key);
                    }
                }
            }
        }
    } catch (error) {
        services.logger.warn({ err: error }, "listener process reconcile failed");
    }
};

// Panel key → the extension/process a terminals-list "process" row addresses, so the web drives the
// /extensions process routes without parsing tmux names (dashes are ambiguous between id and name).
export const extensionProcessIndex = async (services: ExtensionHost): Promise<Map<string, { extensionId: string; processName: string }>> => {
    const index = new Map<string, { extensionId: string; processName: string }>();
    for (const extension of await installedExtensions(services)) {
        for (const process of extension.manifest.contributes?.processes ?? []) {
            index.set(extensionProcessKey(extension.id, process.name), { extensionId: extension.id, processName: process.name });
        }
    }
    return index;
};
