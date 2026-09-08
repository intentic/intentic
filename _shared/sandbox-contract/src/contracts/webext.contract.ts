import { oc } from "@orpc/contract";
import { z } from "zod";
import { WebExtScopesSchema } from "../schemas/capabilities.js";
import { OkSchema } from "../schemas/shared.js";
import { WebExtFactsSchema } from "../schemas/webext.js";

// What a connected browser can be asked, over the socket its extension opened; the extension is the oRPC server here,
// inverted from host.contract.ts, since a browser cannot be dialled.
// `mcp` stays one opaque procedure so a browser can gain a tool without a matching daemon release; the payload is
// validated in the extension against the tool's own schema.
// No `runSandboxFlow` twin: every browser operation is a click or read that either happened or did not.
export const webextContract = {
    // Refetched on connect and each card read, never cached: the grant list changes in the browser, not here.
    describe: oc.output(WebExtFactsSchema),
    // Enforced by the extension, not checked here; site access is a separate, browser-granted permission.
    setScopes: oc.input(WebExtScopesSchema).output(OkSchema),
    // Doubles as the tunnel keepalive; failure means the browser closed, not that it's merely quiet.
    ping: oc.output(OkSchema),
    // One MCP JSON-RPC message forwarded verbatim in both directions; kept opaque, not typed per tool.
    mcp: oc.input(z.unknown()).output(z.unknown()),
};
