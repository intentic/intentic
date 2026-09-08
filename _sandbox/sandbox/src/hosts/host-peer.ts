import { join } from "node:path";
import { HOST_HEARTBEAT_MS,type hostContract,type HostFacts,type HostHello,HostHelloSchema,type HostScopes,type HostSummary } from "@intentic/sandbox-contract";
import type { ContractRouterClient } from "@orpc/contract";
import type { Services } from "../composition.js";
import { PEER_BRIDGES, type PeerDoor } from "../peers/peer.js";
import type { PeerHub } from "../peers/peer-hub.js";
import { createPeerRoutes } from "../peers/peer-routes.js";
import type { PeerStore } from "../peers/peer-store.js";
import { commandInCall, judgeHostCommand } from "./host-command-gate.js";

/* THE USER'S OWN COMPUTER as a peer door (peers/): the machine agent (@intentic/machine) dials this sandbox,
 * enrollment token in its first frame, and serves `hostContract` back over that socket. What is this door's
 * own: the grant is the `host` capability's config, pushed down on every connect; the agent reaches the machine
 * through the MCP bridge, where a `run_command` headed for somebody's laptop is judged against the owner's
 * safety policy before it crosses (host-command-gate.ts); and the setup flow can pre-arm a pairing from the
 * container's env (host-seed.ts), which is why this store's burn list matters. */

export type HostClient = ContractRouterClient<typeof hostContract>;
// What the hello carries beside the socket: the @intentic/machine build, so an old binary is visible rather
// than mysteriously missing a tool.
export interface HostAnnounced {
    readonly version: string;
}
export type HostHub = PeerHub<HostClient, HostAnnounced, HostFacts, HostScopes>;
export type HostStore = PeerStore<Record<string, never>>;

export const HOST_PEER: PeerDoor<HostHello, HostAnnounced, Record<never, never>> = {
    slug: PEER_BRIDGES.host,
    noun: "device",
    listKey: "hosts",
    store: {
        files: (historyRoot) => ({ enrollments: join(historyRoot, "host-enrollments.json"), consumed: join(historyRoot, "host-pair-consumed.json") }),
        key: "hosts", prefix: "iht_", extra: {}
    },
    hub: {
        domain: "hosts",
        // Keepalive and liveness in one, and the agent's own watchdog is timed off the same number, which is
        // why it lives in the contract both sides read (host-protocol.ts) rather than here.
        heartbeatMs: HOST_HEARTBEAT_MS,
        callTimeoutMs: 15 * 60 * 1000,
        offline: (id) => `"${id}" is not connected right now: the device is asleep, offline, or its agent isn't running.`,
    },
    hello: { schema: HostHelloSchema, announced: (hello) => ({ version: hello.version }) },
    scopesKind: "host",
    mcp: { serverName: (id) => `intentic-machine:${id}` },
    expired: "pairing expired, click Connect again in your browser for a fresh command.",
};

// The owner's view of their machines: the manifest's host capabilities, each with whatever the hub knows about
// it right now. Enrollment state is deliberately part of it: "added but never connected" is the state the
// connect card exists to resolve, and it must be distinguishable from "connected but asleep".
export const hostSummaries = async (services: Services): Promise<HostSummary[]> =>
    (await services.capabilities.list()).flatMap((capability): HostSummary[] => {
        if (capability.kind !== "host") {
            return [];
        }
        const state = services.hostHub.state(capability.id);
        return [
            {
                id: capability.id,
                platform: capability.config.platform,
                online: state.online,
                ...(state.announced === undefined ? {} : { version: state.announced.version }),
                ...(state.facts === undefined ? {} : { facts: state.facts }),
                ...(state.lastSeen === undefined ? {} : { lastSeen: state.lastSeen }),
            },
        ];
    });

export const hostPeerRoutes = (services: Services) =>
    createPeerRoutes(services, HOST_PEER, {
        store: services.hosts,
        hub: services.hostHub,
        bridgeToken: services.hostBridgeToken,
        summaries: () => hostSummaries(services),
        /* THE OWNER'S SAFETY POLICY, BEFORE THE TUNNEL. The bridge is the last thing that sees a call while a
         * person can still be asked about it, so a `run_command` headed for somebody's own device is judged
         * here (host-command-gate.ts argues the whole shape). The scopes on the machine remain the floor
         * underneath and are untouched by any of this; a refusal here only ever stops a call the machine might
         * otherwise have run. */
        beforeCall: async (payload, c) => {
            const command = commandInCall(payload);
            if (command === undefined) {
                return undefined;
            }
            return judgeHostCommand(services, { machine: c.req.param("id") ?? "", command, conversationId: c.req.query("conversation") });
        },
    });
