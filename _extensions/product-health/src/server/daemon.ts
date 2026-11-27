import type { DaemonDoors, ExtensionCaller, ExtensionServerApi } from "@intentic/extension-api";
import type { MessageReceipt } from "@intentic/sandbox-contract/schemas/agent";
import type { AgentSummary } from "@intentic/sandbox-contract/schemas/agents";
import type { z } from "zod";
import type { PostHogConnection } from "./posthog.js";

/* WHAT THE BACKEND ASKS THE DAEMON, each route declared in the manifest's `permissions.daemon`: which PostHog
   connections exist and their credentials (served only to the extension contributing the PostHog card), the workspace's
   repositories, the conversations its fix agents run in, and its own listener's wakes. Everything else reads the daemon
   through this alone, so a test stands one in. */

type Rpc = ExtensionServerApi["daemon"]["rpc"];
// What POST /agent takes, as the typed client asks for it.
export type AgentRun = Parameters<Rpc["agent"]["run"]>[0];

// One wake on this extension's own listener source, as the daemon's listener door takes it.
export interface ListenerMessage {
    readonly provider: string;
    readonly type: string;
    readonly id: string;
    readonly channelId: string;
    readonly thread: string;
    readonly author: { readonly id: string; readonly name: string };
    readonly content: string;
    readonly timestamp: string;
    readonly extra: Readonly<Record<string, z.core.util.JSONType>>;
}

export interface HealthDaemon {
    // The ids of the PostHog connections on the Capabilities page.
    readonly postHogConnections: () => Promise<readonly string[]>;
    readonly connection: (id: string) => Promise<PostHogConnection>;
    readonly repos: () => Promise<readonly string[]>;
    readonly roster: () => Promise<readonly AgentSummary[]>;
    readonly archivedIds: () => Promise<readonly string[]>;
    // Words into a conversation (POST /agent), as the extension or as the person a caller assertion names.
    readonly say: (turn: AgentRun, as?: ExtensionCaller) => Promise<MessageReceipt>;
    readonly stop: (conversationId: string) => Promise<void>;
    // Files a conversation away; answers why it would not.
    readonly archive: (conversationId: string) => Promise<string | undefined>;
    // Hands a message to the listener door, its decisions streamed back one JSON frame a line.
    readonly dispatch: (message: ListenerMessage) => Promise<Response>;
}

// The provider this extension's listener and the PostHog card share.
export const POSTHOG_PROVIDER = `posthog`;

const stringOf = (config: Readonly<Record<string, string | number | boolean>>, key: string): string => {
    const value = config[key];
    return value === undefined ? `` : String(value);
};

export const daemonOf = (doors: ExtensionServerApi["daemon"]): HealthDaemon => {
    const { rpc } = doors;
    const on = (as: ExtensionCaller | undefined): DaemonDoors => (as === undefined ? doors : doors.asCaller(as));
    return {
        postHogConnections: async () =>
            (await rpc.capabilities.list()).capabilities
                .filter((capability) => capability.kind === `cli` && capability.config[`provider`] === POSTHOG_PROVIDER)
                .map((capability) => capability.id),
        connection: async (id) => {
            const { config } = await rpc.capabilities.connection({ id });
            return { id, host: stringOf(config, `host`), apiKey: stringOf(config, `apiKey`), projectId: stringOf(config, `projectId`) };
        },
        repos: async () => (await rpc.workspace.repos()).repos,
        roster: async () => (await rpc.agents.list()).agents,
        archivedIds: async () => (await rpc.agents.archived()).agents.map((agent) => agent.id),
        say: (turn, as) => on(as).rpc.agent.run(turn),
        stop: async (conversationId) => {
            await rpc.agent.stop({ conversationId, live: true });
        },
        archive: async (conversationId) => (await rpc.agents.archive({ ids: [conversationId] })).failed[0]?.reason,
        dispatch: (message) =>
            doors.request(`/listeners/${POSTHOG_PROVIDER}/dispatch?stream=1`, {
                method: `POST`,
                headers: { "content-type": `application/json`, "idempotency-key": message.id },
                body: JSON.stringify(message),
            }),
    };
};
