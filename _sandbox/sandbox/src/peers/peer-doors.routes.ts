import { join } from "node:path";
import { cleanMcpResult } from "../guard/mcp-output.js";
import { daemonEndpoint, createTurnMountRoute } from "../agent/tools/turn-mounts.routes.js";
import { judgeIndependentCommand } from "../agent/tools/command-judge.js";
import { workingNames } from "../bootstrap/working-now.js";
import type { Services } from "../composition.js";
import { cardDeps } from "../conversations/actor/card-deps.js";
import { turnRunOf } from "../conversations/actor/conversation-holdings.js";
import { createExtensionMcpEndpoint, createExtensionToolsEndpoint } from "../extensions/backend/extension-mcp.js";
import { HOST_PEER, hostPeerRoutes } from "../hosts/host-peer.js";
import { defineRawRoutes } from "../http/raw-route-server.js";
import { createPhonePasswordsRoutes } from "../phones/phone-passwords.routes.js";
import { createPhoneWakeRoute, PHONE_PEER, phonePeerRoutes } from "../phones/phone-peer.js";
import { RUNNER_PEER, runnerPeerRoutes } from "../runners/runner-peer.js";
import { WEBEXT_PEER, webextPeerRoutes } from "../webext/webext-peer.js";
import { peerRouteTable } from "./peer-routes.js";
import { createRedeemRoute } from "./redeem-codes.js";

// What the device gates ask when an agent would restart the sandbox it runs in: everything a restart would cut, leaving
// out the caller's own turn (hosts/host-guard-deps.ts). The one answer to "is it busy?" is bootstrap/working-now.ts.
const restartWorkOf = (services: Services) => (except: string | undefined) => workingNames(services, "restart", except);

// The peer doors: each device, browser, phone and runner gets pairing, enrollment, roster, revoke and socket, and the
// one MCP door a turn reaches the bridged ones through, so each door's routes are built once for both.
export const peerDoorRawRoutes = defineRawRoutes((services: Services) => {
    // A device gate's turn, cards and judge come from above hosts/, so they are handed in here.
    const hostRoutes = hostPeerRoutes(services, {
        cards: cardDeps(services),
        held: services.heldCards,
        turnRun: (conversationId) => turnRunOf(services.conversations, conversationId),
        working: restartWorkOf(services),
        judge: (input, signal) => judgeIndependentCommand(services, input, signal),
    });
    const webextRoutes = webextPeerRoutes(services);
    const phoneRoutes = phonePeerRoutes(services);
    return {
        // What a device, sync or server-connect command's short code is redeemed for: public, a device's first contact.
        "POST /system/redeem/{code}": createRedeemRoute({ codes: services.redeemCodes, sandboxUrl: () => services.config.sandbox.publicUrl }),
        ...peerRouteTable(HOST_PEER, hostRoutes),
        ...peerRouteTable(WEBEXT_PEER, webextRoutes),
        ...peerRouteTable(PHONE_PEER, phoneRoutes),
        // The editor hands over the push-relay channel it registered for a phone, which is what lets a call wake it.
        "POST /system/phones/{id}/wake": createPhoneWakeRoute(services),
        // The phone's autofill, saving to and filling from the owner's keyrings, on its own enrollment token.
        ...createPhonePasswordsRoutes({ phones: services.phones, link: services.keyringLink, pairings: services.phonePairings }),
        ...peerRouteTable(RUNNER_PEER, runnerPeerRoutes(services)),
        // Every MCP server a turn mounted in this daemon, behind one door: its browser routers, the machines and browsers
        // it was granted (their peer bridges), and its extension cards' endpoints on the backend host.
        "ALL /mcp/{mount}": createTurnMountRoute(
            services.turnMounts,
            {
                browser: (target, message, call) => target.router.handle(message, call.signal),
                daemon: daemonEndpoint,
                device: hostRoutes.mcp,
                webext: webextRoutes.mcp,
                phone: phoneRoutes.mcp,
                tools: createExtensionToolsEndpoint(services),
                extension: createExtensionMcpEndpoint(services),
            },
            async (tool, result, conversationId) => {
                // allow(silent-catch): an unavailable settings store costs cleaning, never an already completed tool call.
                const settings = await services.sandboxSettings.get().catch(() => undefined);
                if (settings === undefined) {
                    return result;
                }
                return cleanMcpResult(tool, result, {
                    logsDir: join(services.config.historyRoot, "logs"),
                    spec: settings.outputCleaners,
                    holdout: settings.outputHoldout,
                    conversationId,
                });
            },
        ),
    };
});
