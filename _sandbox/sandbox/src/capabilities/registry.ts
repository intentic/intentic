import type { CapabilityKind } from "@intentic/sandbox-contract";
import type { CapabilityHandler } from "./capability.js";
import { agentHandler } from "./handlers/agent.handler.js";
import { browserHandler } from "./handlers/browser.handler.js";
import { cliHandler } from "./handlers/cli.handler.js";
import { devopsHandler } from "./handlers/devops.handler.js";
import { dockerHandler } from "./handlers/docker.handler.js";
import { endpointHandler } from "./handlers/endpoint.handler.js";
import { exitHandler } from "./handlers/exit.handler.js";
import { extensionHandler } from "./handlers/extension.handler.js";
import { hostHandler } from "./handlers/host.handler.js";
import { identityHandler } from "./handlers/identity.handler.js";
import { integrationHandler } from "./handlers/integration.js";
import { localModelHandler } from "./handlers/localmodel.handler.js";
import { mcpHandler } from "./handlers/mcp.handler.js";
import { monorepoHandler } from "./handlers/monorepo.handler.js";
import { pluginHandler } from "./handlers/plugin.handler.js";
import { serviceHandler } from "./handlers/service.handler.js";
import { sshHandler } from "./handlers/ssh.handler.js";
import { vpnHandler } from "./handlers/vpn.handler.js";
import { walletHandler } from "./handlers/wallet.handler.js";
import { webextHandler } from "./handlers/webext.handler.js";

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
    webext: webextHandler,
    agent: agentHandler,
    endpoint: endpointHandler,
    localmodel: localModelHandler,
    wallet: walletHandler,
};
