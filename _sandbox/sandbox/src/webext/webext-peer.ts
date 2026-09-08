import { join } from "node:path";
import { wrapOutsideContent } from "@intentic/base/outside-text";
import { type webextContract,WEBEXT_HEARTBEAT_MS,type WebExtFacts,type WebExtHello,WebExtHelloSchema,type WebExtScopes,type WebExtSummary } from "@intentic/sandbox-contract";
import type { ContractRouterClient } from "@orpc/contract";
import type { Services } from "../composition.js";
import { PEER_BRIDGES, type PeerDoor } from "../peers/peer.js";
import type { PeerHub } from "../peers/peer-hub.js";
import { createPeerRoutes } from "../peers/peer-routes.js";
import type { PeerStore } from "../peers/peer-store.js";

// The user's own browser as a peer door, through the extension that dials this sandbox and serves `webextContract`.
// Heartbeat stays under an MV3 service worker's 30s idle kill, and facts are re-asked per read since allowed sites and
// tab count change without the daemon being told.
// Page-derived text is wrapped as outside content here, not in the extension, so a tampered build can't skip the seal.

export type WebExtClient = ContractRouterClient<typeof webextContract>;
export interface WebExtAnnounced {
    readonly version: string;
}
export type WebExtHub = PeerHub<WebExtClient, WebExtAnnounced, WebExtFacts, WebExtScopes>;
export type WebExtStore = PeerStore<Record<string, never>>;

// How long `describe` may run before falling back to the last answer, so a sleeping laptop can't stall a card.
const DESCRIBE_TIMEOUT_MS = 3_000;

export const WEBEXT_PEER: PeerDoor<WebExtHello, WebExtAnnounced, Record<never, never>> = {
    slug: PEER_BRIDGES.webext,
    noun: "browser",
    listKey: "browsers",
    store: {
        files: (historyRoot) => ({ enrollments: join(historyRoot, "webext-enrollments.json"), consumed: join(historyRoot, "webext-pair-consumed.json") }),
        key: "browsers", prefix: "iwx_", extra: {}
    },
    hub: {
        domain: "webext",
        // Tighter than the machine door's, for the MV3 reason webext-protocol.ts states beside the number: the
        // extension's own watchdog is timed off it, so it lives in the contract both sides read.
        heartbeatMs: WEBEXT_HEARTBEAT_MS,
        callTimeoutMs: 10 * 60 * 1000,
        offline: (id) => `"${id}" is not connected right now: that browser is closed, or its computer is asleep.`,
    },
    hello: { schema: WebExtHelloSchema, announced: (hello) => ({ version: hello.version }) },
    scopesKind: "webext",
    mcp: { serverName: (id) => `intentic-webext:${id}` },
    expired: "that code has expired, click Connect again in your sandbox for a fresh one.",
};

// Tools whose answer is the extension's own voice, unsealed; everything else is sealed as outside content. An
// allowlist, fail-closed: notably `tabs` is excluded, since a tab's title/URL are page-controlled strings.
const OWN_VOICE = new Set(["describe", "ask_access", "connect_site", "lend_site"]);

// One MCP result, sealed. Text blocks only: an image has no marker to forge, and the model reads it as pixels.
export const sealAnswer = (id: string, tool: string, answer: unknown): unknown => {
    if (OWN_VOICE.has(tool)) {
        return answer;
    }
    const envelope = answer as { result?: { content?: unknown } };
    const content = envelope.result?.content;
    if (!Array.isArray(content)) {
        return answer;
    }
    return {
        ...envelope,
        result: {
            ...envelope.result,
            content: content.map((block) => {
                const part = block as { type?: unknown; text?: unknown };
                return part.type === "text" && typeof part.text === "string"
                    ? Object.assign({}, part, { text: wrapOutsideContent(part.text, { source: `browser:${id}` }) })
                    : block;
            }),
        },
    };
};

// The owner's view of their browsers: manifest capabilities plus whatever the hub can say right now, facts asked fresh.
// Enrollment state (added-but-unpaired vs paired-but-shut) must stay distinguishable.
export const webextSummaries = async (services: Services): Promise<WebExtSummary[]> =>
    await Promise.all(
        (await services.capabilities.list()).flatMap((capability) =>
            capability.kind !== "webext"
                ? []
                : [
                      (async (): Promise<WebExtSummary> => {
                          await services.webextHub.refresh(capability.id, DESCRIBE_TIMEOUT_MS);
                          const state = services.webextHub.state(capability.id);
                          return {
                              id: capability.id,
                              platform: capability.config.platform,
                              online: state.online,
                              ...(state.announced === undefined ? {} : { version: state.announced.version }),
                              ...(state.facts === undefined ? {} : { facts: state.facts }),
                              ...(state.lastSeen === undefined ? {} : { lastSeen: state.lastSeen }),
                          };
                      })(),
                  ],
        ),
    );

export const webextPeerRoutes = (services: Services) =>
    createPeerRoutes(services, WEBEXT_PEER, {
        store: services.webexts,
        hub: services.webextHub,
        bridgeToken: services.webextBridgeToken,
        summaries: () => webextSummaries(services),
        sealAnswer,
    });
