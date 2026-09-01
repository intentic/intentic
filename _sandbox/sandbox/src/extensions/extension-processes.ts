import { join } from "node:path";
import type { ProcessContribution } from "@intentic/extension-manifest";
import type { Services } from "../composition.js";
import { extensionRuntimeAbsent } from "./extension-readiness.js";
import { enabledExtensions, type ExtensionHost, type InstalledExtension, installedExtensions } from "./installed-extensions.js";
import { listenerProcessesDesired, listenerState } from "./listener-state.js";

// The service key (→ log view `svc-ext-<id>-<name>`) for one declared extension process. Key grammars reject
// dots and a baked extension's id is publisher.name, so dots are sanitized. Extension processes run under the
// service supervisor (processes/service-processes.ts): the daemon's own children, respawned with backoff,
// PORT-assigned, one log file each — never tmux sessions. The prefix is how the terminals list and the
// preview proxy tell an extension process apart from a dev-server panel.
export const EXTENSION_PROCESS_PREFIX = "ext-";
export const extensionProcessKey = (id: string, name: string): string => `${EXTENSION_PROCESS_PREFIX}${id.replaceAll(".", "-")}-${name}`;

export const startExtensionProcess = async (services: Services, extension: InstalledExtension, process: ProcessContribution): Promise<void> => {
    const key = extensionProcessKey(extension.id, process.name);
    await services.serviceProcesses.start(key, {
        command: process.command,
        cwd: process.cwd === undefined ? extension.dir : join(extension.dir, process.cwd),
        // A declared process reaches the daemon's own routes (a listener gateway posting to /listeners/<provider>)
        // over loopback with the panel token, the token never leaves the container. (Flagged: the panel token
        // is all-routes; a scoped per-extension token is a named follow-up.) INTENTIC_WORKSPACE lets a process
        // that produces agent-facing files (the discord gateway's voice transcripts) write under the workspace.
        env: {
            INTENTIC_DAEMON: `http://127.0.0.1:${services.config.sandbox.port}`,
            INTENTIC_PANEL_TOKEN: services.panelToken,
            INTENTIC_WORKSPACE: services.workspace.root,
        },
    });
};

/* THE SPAWN GATE for one extension's declared processes, both halves in one place so no caller can consult
 * only one of them. The code has to BE here, and, for a listener extension, its provider has to be wanted at
 * all (listenerProcessesDesired, which is the half the gateway's own /state feed shares).
 *
 * The runtime half is what keeps a core image from running a messaging gateway: those extensions bake their
 * manifests without the trees behind them, and `node dist/gateway.js` with no dist/ can only ever exit with
 * module-not-found. The supervisor would report that honestly now (a crash, a backoff, a growing restart
 * count) — but a gateway that CANNOT run here is not a failing service, it is an absent one, and not
 * spawning it is still the true answer plus the difference between a quiet core image and one that logs a
 * respawn a minute forever.
 *
 * Exported for the post-update health watch, which must ask the same question in reverse: a declared process
 * that is NOT running is only evidence against the new version if this gate would have started it. */
export const processesDesired = async (services: Services, extension: InstalledExtension): Promise<boolean> => {
    if (await extensionRuntimeAbsent(extension)) {
        return false;
    }
    const listener = extension.manifest.contributes?.listener;
    return listener === undefined || listenerProcessesDesired(await listenerState(services, listener.provider));
};

// autoStart processes for one extension, after a successful install (the capabilities add route's post-apply
// seam) and at boot convergence. A listener extension's processes exist only while its provider is wanted, so a
// fresh sandbox runs no idle gateway for an integration nobody enabled.
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

// Boot convergence (beside startDockerd): sessions died with the container / the boot sweep while the
// manifests survived, bring every installed extension's autoStart processes back up. Best-effort.
export const startAllExtensionProcesses = async (services: Services): Promise<void> => {
    for (const extension of await enabledExtensions(services)) {
        await startAutoStartProcesses(services, extension);
    }
};

// How long the poke below waits. The gateway is on loopback and its reconcile is a state fetch plus a connect,
// so anything slower is a wedged process, and its own poll is the fallback either way.
const GATEWAY_POKE_TIMEOUT_MS = 10_000;

/* Tell a RUNNING gateway to re-read the listener state now rather than on its own poll.
 *
 * Starting the process was never the whole job: a gateway that is already up (any other automation for that
 * provider, or one just switched off and on) subscribes on a 30-second cycle, so switching an integration on
 * left the bot deaf for up to half a minute. A message sent in that window was not queued or dropped, it was
 * never seen, which is indistinguishable from a broken integration to whoever sent it.
 *
 * Best-effort by construction: a gateway that just started reconciles at boot anyway, and a poke that fails
 * leaves the poll to do what it always did. */
const pokeListenerGateway = async (services: Services, key: string): Promise<void> => {
    const port = services.serviceProcesses.portOf(key);
    if (port === undefined) {
        return;
    }
    await fetch(`http://127.0.0.1:${port}/reconcile`, { method: "POST", signal: AbortSignal.timeout(GATEWAY_POKE_TIMEOUT_MS) }).catch(
        (error: unknown) => services.logger.debug({ err: error, key }, "listener gateway poke failed, its own poll will converge"),
    );
};

// Converge listener-extension processes after an automations or capabilities mutation: bring a now-wanted
// gateway up, stop a no-longer-wanted one (start is a no-op when already tracked, including one the
// supervisor is mid-backoff on), and poke whatever is left running so it picks the change up at once.
// Best-effort and detached, a reconcile failure logs, it never fails the mutation that triggered it.
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
