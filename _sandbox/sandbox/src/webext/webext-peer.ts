import { join } from "node:path";
import { wrapOutsideContent } from "@intentic/base/outside-text";
import { type webextContract,WEBEXT_HEARTBEAT_MS,type WebExtFacts,type WebExtHello,WebExtHelloSchema,type WebExtScopes,type WebExtSummary } from "@intentic/sandbox-contract";
import type { ContractRouterClient } from "@orpc/contract";
import type { Services } from "../composition.js";
import { PEER_BRIDGES, type PeerDoor } from "../peers/peer.js";
import type { PeerHub } from "../peers/peer-hub.js";
import { createPeerRoutes } from "../peers/peer-routes.js";
import type { PeerStore } from "../peers/peer-store.js";

/* THE USER'S OWN BROWSER as a peer door (peers/), through the extension installed in it: the extension dials
 * this sandbox and serves `webextContract` back over that socket. The host door's shape, with the differences
 * that come straight from what a browser is:
 *
 *   · THE HEARTBEAT IS TIGHTER, and the number is not a taste: an MV3 service worker is killed after 30 seconds
 *     of inactivity, and WebSocket traffic is what counts as activity. A heartbeat at or above Chrome's own
 *     limit would race the browser into shutting the extension down between beats.
 *   · FACTS ARE RE-ASKED when a card reads them. A machine's OS and shell are true until it reboots into
 *     another one; a browser's answer includes which sites the person has allowed and how many tabs are open,
 *     and both change without this daemon being told (a grant can be revoked in Chrome's own settings).
 *   · THE BRIDGE IS NOT A PURE PIPE. A connected computer answers with its own filesystem and its own commands:
 *     material the owner put there. A connected browser answers with WEBSITES, the single largest supply of
 *     text written specifically to be read by a model and act on it. So page-derived text is wrapped in the
 *     same envelope the Front Desk and the listeners use, and it is done HERE rather than in the extension so
 *     that an old, un-updated or tampered extension build cannot deliver unsealed page text into a turn. */

export type WebExtClient = ContractRouterClient<typeof webextContract>;
export interface WebExtAnnounced {
    readonly version: string;
}
export type WebExtHub = PeerHub<WebExtClient, WebExtAnnounced, WebExtFacts, WebExtScopes>;
export type WebExtStore = PeerStore<Record<string, never>>;

// How long a card's live `describe` may take before the reader gets the last known answer instead. A browser
// answers in milliseconds when it is there at all, and this read sits behind a page: a person waiting on a
// capability card must not wait out a tool-call timeout because a laptop went to sleep mid-request.
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

/* THE TOOLS WHOSE ANSWER IS THE EXTENSION'S OWN VOICE. Everything else is sealed as outside content on the way
 * back, and the list is written this way round — an allowlist, fail-closed — on purpose.
 *
 * Note what is not on the list: `tabs`. A tab's title and URL are page-controlled strings, and a title is the
 * cheapest injection surface on the web. `describe` is, because every field in it is the extension's own
 * account of itself; the two grant tools are, because their answer is a sentence this connector wrote. */
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

// The owner's view of their browsers: the manifest's webext capabilities, each with whatever the hub can say
// about it right now, its facts asked fresh where it is up. Enrollment state is part of it: "added but never
// paired" is the state the connect card exists to resolve, and it must be distinguishable from "paired but the
// browser is shut".
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
