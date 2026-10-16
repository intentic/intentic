import { defineRawRoutes } from "../../http/raw-route-server.js";
import type { Services } from "../../composition.js";
import { createGatewayRoute } from "./gateway-route.js";
import { createMcpRoute } from "./mcp-route.js";

export const gatewayRawRoutes = defineRawRoutes((services: Pick<Services, "privacyShield" | "logger">) => ({
    // The privacy shield's gateway, which masks personal data on its way to an untrusted provider and restores it on
    // the way back; a runtime is pointed here only while the shield is on or watching.
    "ALL /privacy/gateway/{session}/*": createGatewayRoute({
        shield: services.privacyShield,
        warn: (message, error) => services.logger.warn({ err: error }, message),
    }),
    // Its sibling for MCP: a hooked runtime's turn (Cursor) calls its MCP servers through here while the shield reads
    // it, so what a server answers is masked before the model reads it, and tokens in what the model sends are read
    // back.
    "ALL /privacy/mcp/{session}": createMcpRoute({
        shield: services.privacyShield,
        warn: (message, error) => services.logger.warn({ err: error }, message),
    }),
}));
