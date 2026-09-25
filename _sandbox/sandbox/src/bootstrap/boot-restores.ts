import { startTranslator } from "../agent/providers/translator.js";
import { capabilityCtx } from "../capabilities/capability.js";
import { restoreConnectorHooks } from "../capabilities/cli/connector-hooks.js";
import { startDockerdIfEnabled } from "../capabilities/handlers/docker.handler.js";
import { startLocalModelsIfEnabled } from "../capabilities/handlers/localmodel.handler.js";
import { engineReady } from "../engines/engine-resolve.js";
import { composeEnvironment } from "../environment/environment.js";
import { restoreExits } from "../exit/exit-links.js";
import { startAllExtensionProcesses } from "../extensions/extension-processes.js";
import { applyTmuxLogHooks } from "../logs/log-files.js";
import { remountNetdisks } from "../netdisk/netdisk-links.js";
import { restoreExecBits, SANDBOX_INSTALL_DIR } from "../system/boot/exec-bits.js";
import { reconnectVpns } from "../vpn/vpn-links.js";
import type { BootPhase } from "./boot-phase.js";

// Container-local state re-derived from manifests that outlived the container. Detached and best-effort: never on the boot path.

// Gated on the engine being here, the image's own or an Environment-card install: TRANSLATOR_URL alone does not imply it.
const startTranslatorIfPacked = async ({ config, logger, services }: BootPhase): Promise<void> => {
    if (config.translator.url === "") {
        return;
    }
    if (!(await engineReady("translator"))) {
        logger.info("translator: cli-proxy-api is not in this image, add it by rebuilding from the Environment card");
        return;
    }
    startTranslator(services);
};

// Container role only: ~/.ssh, the docker socket and the tmux server are shared, so only the claiming daemon converges them.
export const startBootRestores = (phase: BootPhase): void => {
    const { config, logger, role, services } = phase;
    if (!role.container) {
        return;
    }
    // Writes stay under .intentic/, so this never touches the boot baseline.
    void composeEnvironment(services);
    // Disks after tunnels: a share behind a VPN is unreachable until it is up.
    void reconnectVpns(services.capabilities, services.logger).then(() => remountNetdisks(services.capabilities, services.logger));
    // A tunnel exit's client survives the daemon; only its SOCKS proxy is republished.
    void restoreExits(services.capabilities, services.logger);
    // Connector side effects lived in HOME and die with the container.
    void restoreConnectorHooks(services.capabilities, services.logger);
    const bootCtx = capabilityCtx(services);
    void startDockerdIfEnabled(bootCtx);
    void startLocalModelsIfEnabled(bootCtx);
    void startTranslatorIfPacked(phase).catch((error: unknown) => logger.warn({ err: error }, "translator: start gate failed"));
    // Provider gateways (e.g. ext-discord) are extension processes, so the daemon holds no gateway of its own to restore.
    void startAllExtensionProcesses(services);
    // A failure is a row on the Extensions tab, not a boot failure.
    services.extensionBackend.start().catch((error: unknown) => logger.warn({ err: error }, "extension backend host failed to start"));
    // tmux.conf covers server start; this re-arms hooks on a server that outlived a daemon restart.
    void applyTmuxLogHooks(config.historyRoot);
    // The pane-log hooks above and queue-run's memory gate exec these by name; a dev build's dist lands without +x.
    void restoreExecBits("/usr/local/bin", SANDBOX_INSTALL_DIR, logger).catch((error: unknown) =>
        logger.warn({ err: error }, "boot: could not restore exec bits on PATH commands"),
    );
};
