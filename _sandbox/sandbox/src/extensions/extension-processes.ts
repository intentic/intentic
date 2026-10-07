import { join } from "node:path";
import type { ProcessContribution } from "@intentic/extension-manifest";
import { EXTENSION_PROCESS_ENV } from "@intentic/sandbox-contract/extension-protocol";
import type { Services } from "../composition.js";
import { extensionRuntimeAbsent } from "./extension-readiness.js";
import { enabledExtensions, type ExtensionHost, extensionInventory, type InstalledExtension, installedExtensions } from "./installed-extensions.js";
import { listenerOwnership, listenerProcessesDesired, listenerState } from "./listener/listener-state.js";
import { prepareExtensionDirs } from "./runtime/extension-state.js";

// Service key for a declared extension process (`svc-ext-<id>-<name>`); dots in the id are sanitized.
// Extension processes run under the service supervisor, never tmux; the prefix marks it apart from a dev panel.
export const EXTENSION_PROCESS_PREFIX = "ext-";
export const extensionProcessKey = (id: string, name: string): string => `${EXTENSION_PROCESS_PREFIX}${id.replaceAll(".", "-")}-${name}`;

// Where a declared process runs: its extension's directory, which for an install in dev mode is the source checkout.
const processCwd = (extension: InstalledExtension, process: ProcessContribution): string =>
    process.cwd === undefined ? extension.dir : join(extension.dir, process.cwd);

export const startExtensionProcess = async (services: Services, extension: InstalledExtension, process: ProcessContribution): Promise<void> => {
    const key = extensionProcessKey(extension.id, process.name);
    const dirs = await prepareExtensionDirs(services.workspace.root, extension.manifest);
    await services.serviceProcesses.start(key, {
        command: process.command,
        cwd: processCwd(extension, process),
        // Everything `connectExtensionProcess` (@intentic/extension-api/runtime) builds the process's api from, the same
        // api its extension's backend is handed. It reaches the daemon over loopback with its extension's own token, so
        // it gets the reach the manifest declared (`permissions.daemon`, plus its listener provider's routes and its own
        // routes), never the panel token's; the workspace root lets it write into the workspace.
        env: {
            [EXTENSION_PROCESS_ENV.daemon]: `http://127.0.0.1:${services.config.sandbox.port}`,
            [EXTENSION_PROCESS_ENV.token]: services.extensionBackend.grantFor(extension),
            [EXTENSION_PROCESS_ENV.id]: extension.id,
            [EXTENSION_PROCESS_ENV.workspace]: services.workspace.root,
            [EXTENSION_PROCESS_ENV.dir]: extension.dir,
            [EXTENSION_PROCESS_ENV.state]: dirs.stateDir,
            [EXTENSION_PROCESS_ENV.cache]: dirs.cacheDir,
            [EXTENSION_PROCESS_ENV.permissions]: JSON.stringify(extension.manifest.permissions?.daemon ?? []),
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
    if (listener === undefined) {
        return true;
    }
    // A listener another extension owns is refused (listener-state.ts): its gateway would only be turned away. An owner
    // not known yet (the cache not rebuilt since an install) is left to the routes, which resolve it per request.
    const owner = (await listenerOwnership(services)).owners.get(listener.provider);
    if (owner !== undefined && owner !== extension.id) {
        return false;
    }
    return listenerProcessesDesired(await listenerState(services, listener.provider));
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

// Stops whatever a workspace extension left running once it waits for approval again, including a process it has
// since renamed. A key another extension declares is spared: the dashed ids make a bare prefix match ambiguous.
export const stopPendingExtensionProcesses = async (services: Services): Promise<void> => {
    try {
        const inventory = await extensionInventory(services);
        if (inventory.pending.length === 0) {
            return;
        }
        const prefixes = inventory.pending.map((extension) => extensionProcessKey(extension.id, ""));
        const claimed = new Set(
            inventory.extensions.flatMap((extension) =>
                (extension.manifest.contributes?.processes ?? []).map((process) => extensionProcessKey(extension.id, process.name)),
            ),
        );
        for (const service of services.serviceProcesses.list()) {
            if (!claimed.has(service.key) && prefixes.some((prefix) => service.key.startsWith(prefix))) {
                services.serviceProcesses.stop(service.key);
            }
        }
    } catch (error) {
        services.logger.warn({ err: error }, "stopping pending extensions' processes failed");
    }
};

// Moves what installs have running onto the directory each runs from now: dev mode pointed one at its source checkout,
// or back at the pinned copy. Idempotent, so the route that made the switch and the watcher that saw the pointer file
// change can both call it: a process already where it belongs is left alone. One the extension no longer declares (a
// checkout that renamed it) is stopped, sparing a key another extension declares, as above. `restart` names installs
// whose running processes restart even in place (a rebuild), and `autoStart` those whose autoStart processes come up
// too; the watcher passes neither, so a process the owner stopped stays stopped.
export const followExtensionDirs = async (
    services: Services,
    options: { readonly restart?: ReadonlySet<string>; readonly autoStart?: ReadonlySet<string> } = {},
): Promise<void> => {
    try {
        const inventory = await extensionInventory(services);
        const claimed = new Set(
            [...inventory.extensions, ...inventory.pending].flatMap((extension) =>
                (extension.manifest.contributes?.processes ?? []).map((process) => extensionProcessKey(extension.id, process.name)),
            ),
        );
        for (const extension of inventory.extensions.filter((candidate) => candidate.source === "installed")) {
            stopUndeclared(services, extension, claimed);
            await moveProcesses(services, extension, options.restart?.has(extension.id) === true);
            if (extension.enabled && options.autoStart?.has(extension.id) === true) {
                await startAutoStartProcesses(services, extension);
            }
        }
    } catch (error) {
        services.logger.warn({ err: error }, "moving extension processes onto their directories failed");
    }
};

// A running process of this install that no enumerated extension declares any more.
const stopUndeclared = (services: Services, extension: InstalledExtension, claimed: ReadonlySet<string>): void => {
    const prefix = extensionProcessKey(extension.id, "");
    for (const service of services.serviceProcesses.list()) {
        if (service.key.startsWith(prefix) && !claimed.has(service.key)) {
            services.serviceProcesses.stop(service.key);
        }
    }
};

// Restarts each running declared process that was started somewhere else than its directory now, or every running one
// when `restart`; one the switch would not start again stays stopped.
const moveProcesses = async (services: Services, extension: InstalledExtension, restart: boolean): Promise<void> => {
    for (const process of extension.manifest.contributes?.processes ?? []) {
        const key = extensionProcessKey(extension.id, process.name);
        const status = services.serviceProcesses.statusOf(key);
        const inPlace = status?.cwd === processCwd(extension, process);
        if (status === undefined || (inPlace && !restart)) {
            continue;
        }
        services.serviceProcesses.stop(key);
        const wanted = extension.enabled && (await processesDesired(services, extension));
        if (wanted) {
            await startExtensionProcess(services, extension, process);
        }
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
