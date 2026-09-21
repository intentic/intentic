import { startTranslator } from "../agent/providers/translator.js";
import { capabilityCtx } from "../capabilities/capability.js";
import { restoreConnectorHooks } from "../capabilities/cli/connector-hooks.js";
import { startDockerdIfEnabled } from "../capabilities/handlers/docker.handler.js";
import { startLocalModelsIfEnabled } from "../capabilities/handlers/localmodel.handler.js";
import { composeEnvironment } from "../environment/environment.js";
import { restoreExits } from "../exit/exit-links.js";
import { startAllExtensionProcesses } from "../extensions/extension-processes.js";
import { applyTmuxLogHooks } from "../logs/log-files.js";
import { remountNetdisks } from "../netdisk/netdisk-links.js";
import { onPath } from "../platform/boot/on-path.js";
import { reconnectVpns } from "../vpn/vpn-links.js";
import type { BootPhase } from "./boot-phase.js";

// Container-local state re-derived at boot from the manifests that outlived it. Tunnels, daemons, model servers and
// credential helpers all died with the container while the files describing them survived on /work and /history, so
// each of these reads its manifest and puts the live thing back. Detached and best-effort: a failure lands in state or
// the log, never in the boot path.

// Backs "Codex/Grok under the Claude Code harness" via CLIProxyAPI. Gated on the binary being in this image (a feature
// pack, not core): TRANSLATOR_URL alone no longer implies it's present.
const startTranslatorIfPacked = async ({ config, logger, services }: BootPhase): Promise<void> => {
    if (config.translator.url === "") {
        return;
    }
    if (!(await onPath("cli-proxy-api"))) {
        logger.info("translator: cli-proxy-api is not in this image, add it by rebuilding from the Environment card");
        return;
    }
    startTranslator(services);
};

// Container role only: ~/.ssh, the docker socket and the tmux server are shared by every process here, so only the
// daemon that claimed the container may converge them.
export const startBootRestores = (phase: BootPhase): void => {
    const { config, logger, role, services } = phase;
    if (!role.container) {
        return;
    }
    // Recomposes the environment overlay from the manifest, converging drift when a capability's fragment changed;
    // no-op on a fresh sandbox. Writes stay under .intentic/, so this never touches the boot baseline.
    void composeEnvironment(services);
    // Disks come after the tunnels, since a share behind a VPN is unreachable until it is up.
    void reconnectVpns(services.capabilities, services.logger).then(() => remountNetdisks(services.capabilities, services.logger));
    // Geo exits restore the same way, plus one step: a tunnel exit's client survives the daemon dying, but the SOCKS
    // proxy publishing it lived in this process, so this republishes it without disturbing the tunnel.
    void restoreExits(services.capabilities, services.logger);
    // Connector side effects (credential helper, ssh Include, npmrc auth) lived in HOME and die with the container;
    // re-derived from the manifest so the first git or npm call authenticates.
    void restoreConnectorHooks(services.capabilities, services.logger);
    const bootCtx = capabilityCtx(services);
    void startDockerdIfEnabled(bootCtx);
    // Model servers die with the container like dockerd; weights survive on /work, so every ready one comes back.
    void startLocalModelsIfEnabled(bootCtx);
    void startTranslatorIfPacked(phase).catch((error: unknown) => logger.warn({ err: error }, "translator: start gate failed"));
    // Installed extensions' declared autoStart processes come back the same way (manifests on /work). Realtime
    // wake-ups ride on these: a provider gateway (e.g. ext-discord) is one of them, driving /listeners/<provider>, so
    // the daemon holds no gateway of its own to restore here.
    void startAllExtensionProcesses(services);
    // Extension backends (manifest `server` bundles) come up in their own supervised host process, proxied under
    // /x/<id>/. Best-effort: a failure is a row on the Extensions tab, not a boot failure.
    services.extensionBackend.start().catch((error: unknown) => logger.warn({ err: error }, "extension backend host failed to start"));
    // Re-arms tmux pipe-pane hooks on a server that outlived a daemon restart; tmux.conf covers server start, this is
    // best-effort.
    void applyTmuxLogHooks(config.historyRoot);
};
