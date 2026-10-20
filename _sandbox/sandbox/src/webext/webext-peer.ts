import { wrapOutsideContent } from "@intentic/base/outside-text";
import type { Capability } from "@intentic/sandbox-contract/schemas/capabilities";
import { grantSite } from "@intentic/sandbox-contract/schemas/needs";
import type { webextContract } from "@intentic/sandbox-contract/contracts/webext.contract";
import { WEBEXT_HEARTBEAT_MS, type WebExtHello, WebExtHelloSchema } from "@intentic/sandbox-contract/protocol/doors/webext-protocol";
import { WEBEXT_TICKET_TOOL } from "@intentic/sandbox-contract/protocol/doors/webext-links";
import type { WebExtFacts, WebExtScopes, WebExtSummary } from "@intentic/sandbox-contract/schemas/webext";
import type { ContractRouterClient } from "@orpc/contract";
import { z } from "zod";
import type { MountCall } from "../agent/tools/turn-mounts.routes.js";
import type { RpcMessage } from "../agent/tools/turn-mounts.js";
import type { Services } from "../composition.js";
import { PEER_BRIDGES, type PeerDoor } from "../peers/peer.js";
import type { PeerHub } from "../peers/peer-hub.js";
import { createPeerRoutes } from "../peers/peer-routes.js";
import type { PeerStore } from "../peers/peer-store.js";
import { webextEnrollmentsDocument, webextPairConsumedDocument } from "../peers/enrollment.js";

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
export const DESCRIBE_TIMEOUT_MS = 3_000;

export const WEBEXT_PEER: PeerDoor<WebExtHello, WebExtAnnounced, Record<never, never>> = {
    slug: PEER_BRIDGES.webext,
    noun: "browser",
    listKey: "browsers",
    store: {
        documents: { enrollments: webextEnrollmentsDocument, consumed: webextPairConsumedDocument },
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

// One of the owner's own browsers as a turn needs to know it: the name its tools are prefixed with, and what the
// person sitting in front of it calls it ("Brave 141 on Windows", from its last `describe`).
export interface OwnBrowser {
    readonly id: string;
    readonly what?: string | undefined;
}

// Granted browser cards, split by what their bridge answers `tools/list` with: `browsers` publish tools (online, or a
// table remembered from an earlier connect), `unlisted` publish none, since they hold no socket and never listed here.
// Undefined with no card at all. A prompt may say a browser is connected only for `browsers`.
export interface OwnBrowserReach {
    readonly browsers: readonly OwnBrowser[];
    readonly unlisted: readonly string[];
}

const listsTools = (known: unknown): boolean => {
    const tools = (known as { readonly tools?: unknown } | undefined)?.tools;
    return Array.isArray(tools) && tools.length > 0;
};

// Reads only what the hub already holds — no `describe` round trip — so composing a turn never waits on a laptop.
export const ownBrowserReach = async (
    services: { readonly webextHub: Pick<WebExtHub, "state" | "online" | "knownTools"> },
    granted: readonly Capability[],
): Promise<OwnBrowserReach | undefined> => {
    const cards = granted.filter((capability) => capability.kind === "webext");
    if (cards.length === 0) {
        return undefined;
    }
    const hub = services.webextHub;
    const publishing = cards.filter((card) => hub.online(card.id) || listsTools(hub.knownTools(card.id)));
    return {
        browsers: publishing.map((card): OwnBrowser => {
            const what = hub.state(card.id).facts?.browser;
            return { id: card.id, ...(what === undefined ? {} : { what }) };
        }),
        unlisted: cards.filter((card) => !publishing.includes(card)).map((card) => card.id),
    };
};

// An `ask_access` call's site and reason, when the message is one; the extension checks its own arguments, this only
// reads what a card can say.
export const accessAsked = (payload: unknown): { readonly origin: string; readonly reason: string } | undefined => {
    const message = payload as { readonly method?: unknown; readonly params?: { readonly name?: unknown; readonly arguments?: Record<string, unknown> } } | undefined;
    const args = message?.params?.arguments;
    if (message?.method !== "tools/call" || message.params?.name !== "ask_access" || typeof args?.["origin"] !== "string") {
        return undefined;
    }
    return { origin: args["origin"], reason: typeof args["reason"] === "string" ? args["reason"] : "" };
};

// Tools a browser serves to this daemon alone, never to the agent's own mount of it: `type_ticket` takes a ticket only
// the daemon mints, for a secret the agent must not hold (secret-tickets.ts). A guessed ticket would type nothing, but a
// tool the model cannot use is one it should not be shown.
const DAEMON_ONLY = new Set<string>([WEBEXT_TICKET_TOOL]);

// The one field of a tools/call this reads, and the listing it trims; everything else passes as the browser said it.
const CalledSchema = z.looseObject({ name: z.string() });
const ListingSchema = z.looseObject({ result: z.looseObject({ tools: z.array(z.looseObject({ name: z.string() })) }) });

type MountEndpoint = (target: { readonly id: string }, message: RpcMessage, call: MountCall) => Promise<RpcMessage | undefined>;

// The agent's mount of a browser, minus the daemon's own tools: left out of every listing (a live one, and the one
// remembered for a browser that is asleep), and answered as the browser answers a tool it does not have.
export const withoutDaemonTools =
    (mcp: MountEndpoint): MountEndpoint =>
    async (target, message, call) => {
        const called = message.method === "tools/call" ? CalledSchema.safeParse(message.params) : undefined;
        if (called?.success === true && DAEMON_ONLY.has(called.data.name)) {
            return message.id === undefined
                ? undefined
                : { jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: `This browser has no tool called "${called.data.name}".` }], isError: true } };
        }
        const answer = await mcp(target, message, call);
        if (message.method !== "tools/list" || answer === undefined) {
            return answer;
        }
        const listing = ListingSchema.safeParse(answer);
        return listing.success
            ? { ...answer, result: { ...listing.data.result, tools: listing.data.result.tools.filter((tool) => !DAEMON_ONLY.has(tool.name)) } }
            : answer;
    };

export const webextPeerRoutes = (services: Services) => {
    const routes = createPeerRoutes(services, WEBEXT_PEER, {
        store: services.webexts,
        hub: services.webextHub,
        summaries: () => webextSummaries(services),
        sealAnswer,
        // The person's browser asks for a site by lighting its own badge; the same ask goes up as a card in the chat
        // (docs/architecture/needs.md), met when that browser reports the site allowed, which continues the conversation.
        beforeCall: async (payload, call) => {
            const asked = accessAsked(payload);
            if (asked !== undefined && call.conversationId !== undefined) {
                const site = grantSite(asked.origin);
                await services.needs
                    .observe(call.conversationId, { kind: "grant", subject: "site", what: site, label: site }, `Allow ${site} in your browser`, asked.reason)
                    .catch((error: unknown) => services.logger.warn({ err: error, site }, "webext: the site ask did not reach the chat"));
            }
            return undefined;
        },
    });
    return { ...routes, mcp: withoutDaemonTools(routes.mcp) };
};
