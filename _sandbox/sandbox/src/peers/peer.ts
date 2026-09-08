import type { RuntimeDomain } from "@intentic/sandbox-contract";
import type { z } from "zod";

// A peer is something of the user's that dials this sandbox and serves a contract back over the socket it opened: their
// computer (hosts/), their browser (webext/), or one of this sandbox's own runners (runners/). A door is the data that
// varies between them, declared beside the code that is genuinely its own. What a door declares:
// - slug: path segment every route sits under; also what the far end dials, so it can't change casually
// - noun: the word every sentence uses for the thing on the other end
// - domain: runtime-change domain its liveness is announced on
// - store: where enrollment digests live on /history and what rides beside them
// - hub: heartbeat, tool-call ceiling, and the sentence an offline peer answers with
// - hello: first frame's schema and what of it is worth remembering
// - scopesKind: capability kind whose config is the grant pushed on connect; absent with no owner-ticked grant
// - mcp: present when reachable through the loopback bridge, with its judge/seal hooks
export type PeerSlug = "hosts" | "webext" | "runners";

export interface PeerStoreSpec<Shape extends z.ZodRawShape> {
    // Two files on /history: digests, spent pairings; names stay literal for HISTORY_STATE_FILES's guard.
    readonly files: (historyRoot: string) => { readonly enrollments: string; readonly consumed: string };
    // The top-level key inside the enrollments file.
    readonly key: string;
    // What the durable token looks like, so a credential in a log says which door it opens.
    readonly prefix: string;
    // What an enrollment records beside its digest (runners: which computer holds the container).
    readonly extra: Shape;
    // Whether pairings end up immortal and must burn on redemption; a runner's always do, a host's vary.
    readonly replayable?: boolean;
}

export interface PeerHubSpec {
    readonly domain: RuntimeDomain;
    readonly heartbeatMs: number;
    // Ceiling on one forwarded call, far above any tool's timeout; only catches a socket that's gone, not closed.
    readonly callTimeoutMs: number;
    // What the model reads when the peer holds no socket; asleep or shut is a normal state, not a fault.
    readonly offline: (id: string) => string;
}

export interface PeerMcpSpec {
    // The `serverInfo.name` the daemon answers the handshake with while the peer is away.
    readonly serverName: (id: string) => string;
}

export interface PeerDoor<Hello extends { readonly token: string }, Announced, Shape extends z.ZodRawShape> {
    readonly slug: PeerSlug;
    readonly noun: string;
    // The key the roster answers under: `{ hosts: [...] }`, `{ browsers: [...] }`, `{ runners: [...] }`.
    readonly listKey: string;
    readonly store: PeerStoreSpec<Shape>;
    readonly hub: PeerHubSpec;
    readonly hello: {
        readonly schema: z.ZodType<Hello>;
        // What of the hello is kept beside the socket: a build number, or a runner's whole parity claim.
        readonly announced: (hello: Hello) => Announced;
    };
    readonly scopesKind?: "host" | "webext";
    readonly mcp?: PeerMcpSpec;
    // The sentence a spent or unknown pairing is refused with, naming where a fresh one comes from.
    readonly expired: string;
}

// Doors reachable through the MCP bridge, by capability kind, so the turn planner needn't import a door's code.
export const PEER_BRIDGES = { host: "hosts", webext: "webext" } as const satisfies Record<"host" | "webext", PeerSlug>;

// The two doors an anonymous caller may reach on every peer: the socket, and the one-time redemption.
export const peerConnectPath = (slug: PeerSlug): string => `/system/${slug}/connect`;
export const peerEnrollPath = (slug: PeerSlug): string => `/system/${slug}/enroll`;
export const peerMcpPath = (slug: PeerSlug): RegExp => new RegExp(`^/mcp/${slug}/[^/]+$`);
