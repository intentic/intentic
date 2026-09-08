import { join } from "node:path";
import type { ProcessContribution } from "@intentic/extension-manifest";
import type { Services } from "../composition.js";
import { extensionRuntimeAbsent } from "./extension-readiness.js";
import { enabledExtensions, type ExtensionHost, type InstalledExtension, installedExtensions } from "./installed-extensions.js";
import { listenerProcessesDesired, listenerState } from "./listener-state.js";

// Service key for a declared extension process (`svc-ext-<id>-<name>`); dots in the id are sanitized.
// Extension processes run under the service supervisor, never tmux; the prefix marks it apart from a dev panel.
export const EXTENSION_PROCESS_PREFIX = "ext-";
export const extensionProcessKey = (id: string, name: string): string => `${EXTENSION_PROCESS_PREFIX}${id.replaceAll(".", "-")}-${name}`;

export const startExtensionProcess = async (services: Services, extension: InstalledExtension, process: ProcessContribution): Promise<void> => {
    const key = extensionProcessKey(extension.id, process.name);
    await services.serviceProcesses.start(key, {
        command: process.command,
        cwd: process.cwd === undefined ? extension.dir : join(extension.dir, process.cwd),
        // Reaches the daemon over loopback via the panel token; INTENTIC_WORKSPACE lets it write into the workspace.
        env: {
            INTENTIC_DAEMON: `http://127.0.0.1:${services.config.sandbox.port}`,
            INTENTIC_PANEL_TOKEN: services.panelToken,
            INTENTIC_WORKSPACE: services.workspace.root,
        },
    });
};

// Combines both halves of the spawn gate: runtime presence, and, for a listener extension, its provider being wanted.
// Also used in reverse by the health watch: a process not running is only suspicious if this gate would start it.
export const processesDesired = async (services: Services, extension: InstalledExtension): Promise<boolean> => {
    if (await extensionRuntimeAbsent(extension)) {
        return false;
    }
    const listener = extension.manifest.contributes?.listener;
    return listener === undefined || listenerProcessesDesired(await listenerState(services, listener.provider));
};

// Starts one extension's autoStart processes, called after install and at boot convergence.
// A listener extension's processes run only while its provider is wanted; nothing starts for a disabled integration.
export const startAutoStartProcesses = async (services: Services, extension: InstalledExtension): Promise<void> => {
    if (!(await processesDesired(services, extension))) {
        return;
    }
    for (const process of extension.manifest.contributes?.processes ?? []) {
        if (process.autoStart === true) {
            await startExtensionProcess(services, extension, process);
        }
    }
};

// Boot convergence: brings autoStart processes back up for every installed extension after a restart. Best-effort.
export const startAllExtensionProcesses = async (services: Services): Promise<void> => {
    for (const extension of await enabledExtensions(services)) {
        await startAutoStartProcesses(services, extension);
    }
};

// Poke timeout: the gateway is loopback-local, so anything slower means a wedged process (poll is the fallback).
const GATEWAY_POKE_TIMEOUT_MS = 10_000;

// Tells a running gateway to re-read listener state now instead of waiting its own ~30s poll cycle.
// Best-effort: a fresh gateway reconciles at boot anyway, and a failed poke just leaves the poll to converge.
const pokeListenerGateway = async (services: Services, key: string): Promise<void> => {
    const port = services.serviceProcesses.portOf(key);
    if (port === undefined) {
        return;
    }
    await fetch(`http://127.0.0.1:${port}/reconcile`, { method: "POST", signal: AbortSignal.timeout(GATEWAY_POKE_TIMEOUT_MS) }).catch(
        (error: unknown) => services.logger.debug({ err: error, key }, "listener gateway poke failed, its own poll will converge"),
    );
};

// Converges listener-extension processes after an automations/capabilities mutation: starts, stops, pokes as needed.
// Best-effort and detached; a reconcile failure logs but never fails the mutation that triggered it.
export const reconcileListenerProcesses = async (services: Services): Promise<void> => {
    try {
        for (const extension of await enabledExtensions(services)) {
            const listener = extension.manifest.contributes?.listener;
            if (listener === undefined) {
                continue;
            }
            const desired = await processesDesired(services, extension);
            for (const process of extension.manifest.contributes?.processes ?? []) {
                if (process.autoStart !== true) {
                    continue;
                }
                const key = extensionProcessKey(extension.id, process.name);
                if (desired) {
                    await startExtensionProcess(services, extension, process);
                    await pokeListenerGateway(services, key);
                } else {
                    services.serviceProcesses.stop(key);
                }
            }
        }
    } catch (error) {
        services.logger.warn({ err: error }, "listener process reconcile failed");
    }
};

// Maps a process's panel key to its extension id and process name; dashes make tmux names ambiguous to parse.
export const extensionProcessIndex = async (services: ExtensionHost): Promise<Map<string, { extensionId: string; processName: string }>> => {
    const index = new Map<string, { extensionId: string; processName: string }>();
    for (const extension of await installedExtensions(services)) {
        for (const process of extension.manifest.contributes?.processes ?? []) {
            index.set(extensionProcessKey(extension.id, process.name), { extensionId: extension.id, processName: process.name });
        }
    }
    return index;
};
