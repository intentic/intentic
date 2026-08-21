import type { CapabilityKind } from "@intentic/sandbox-contract";
import type { CapabilityHandler } from "./capability.js";
import { agentHandler } from "./handlers/agent.js";
import { browserHandler } from "./handlers/browser.js";
import { cliHandler } from "./handlers/cli.js";
import { devopsHandler } from "./handlers/devops.js";
import { dockerHandler } from "./handlers/docker.js";
import { endpointHandler } from "./handlers/endpoint.js";
import { exitHandler } from "./handlers/exit.js";
import { extensionHandler } from "./handlers/extension.js";
import { hostHandler } from "./handlers/host.js";
import { identityHandler } from "./handlers/identity.js";
import { integrationHandler } from "./handlers/integration.js";
import { mcpHandler } from "./handlers/mcp.js";
import { monorepoHandler } from "./handlers/monorepo.js";
import { pluginHandler } from "./handlers/plugin.js";
import { serviceHandler } from "./handlers/service.js";
import { sshHandler } from "./handlers/ssh.js";
import { vpnHandler } from "./handlers/vpn.js";
import { walletHandler } from "./handlers/wallet.js";

// Every capability kind's handler. Total over CapabilityKind, so an unhandled kind is a compile error.
export const registry: Record<CapabilityKind, CapabilityHandler> = {
    devops: devopsHandler,
    monorepo: monorepoHandler,
    mcp: mcpHandler,
    service: serviceHandler,
    integration: integrationHandler,
    cli: cliHandler,
    plugin: pluginHandler,
    extension: extensionHandler,
    ssh: sshHandler,
    vpn: vpnHandler,
    exit: exitHandler,
    docker: dockerHandler,
    browser: browserHandler,
    identity: identityHandler,
    host: hostHandler,
    agent: agentHandler,
    endpoint: endpointHandler,
    wallet: walletHandler,
};
