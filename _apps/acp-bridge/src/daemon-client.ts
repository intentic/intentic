import { RequestError } from "@agentclientprotocol/sdk";
import {
    type AgentEvent,
    AgentEventSchema,
    type AgentReply,
    type AgentTurn,
    type RestoredMessage,
    sseData,
    sseFrames,
} from "@intentic/sandbox-contract";

/* The bridge's view of the sandbox daemon: the /agent SSE stream plus the decision/answer side channels and
 * the session store, every call carrying the bridge token (x-intentic-bridge — see the daemon's
 * bridge-tokens middleware). A 401 surfaces as ACP auth_required so the editor re-runs the auth flow; a 403
 * names the scope violation. Unknown frame kinds are skipped (forward compatibility: a newer daemon must not
 * break an older bridge). */

export interface DaemonClient {
    readonly streamTurn: (turn: AgentTurn, signal: AbortSignal) => AsyncGenerator<AgentEvent>;
    // Un-parks a turn waiting on any interactive card (plan / question / permission) — one route, one body.
    readonly postReply: (reply: AgentReply) => Promise<void>;
    readonly getSession: (id: string) => Promise<RestoredMessage[]>;
    // The auth probe (also `intentic-acp login`'s validation call).
    readonly listSessions: () => Promise<void>;
}

const raise = (status: number, body: string): never => {
    if (status === 401) {
        throw RequestError.authRequired({ details: "The sandbox rejected the bridge token — mint a new one in the sandbox's Sync settings." });
    }
    throw RequestError.internalError({ details: `sandbox responded ${status}: ${body.slice(0, 300)}` });
};

export const createDaemonClient = (url: string, token: string): DaemonClient => {
    const headers = { "x-intentic-bridge": token };
    const request = async (path: string, init?: RequestInit): Promise<Response> => {
        const response = await fetch(`${url}${path}`, { ...init, headers: { ...headers, ...init?.headers } });
        if (!response.ok) {
            raise(response.status, await response.text().catch(() => ""));
        }
        return response;
    };

    return {
        streamTurn: async function* (turn, signal) {
            const response = await request("/agent", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(turn),
                signal,
            });
            if (response.body === null) {
                throw RequestError.internalError({ details: "sandbox returned no stream" });
            }
            for await (const frame of sseFrames(response.body)) {
                const parsed = AgentEventSchema.safeParse(sseData(frame));
                if (parsed.success) {
                    yield parsed.data;
                }
            }
        },
        postReply: async (reply) => {
            await request("/agent/reply", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(reply),
            });
        },
        getSession: async (id) => {
            const response = await request(`/sessions/${encodeURIComponent(id)}`);
            const body = (await response.json()) as { messages?: RestoredMessage[] };
            return body.messages ?? [];
        },
        listSessions: async () => {
            await request("/sessions");
        },
    };
};
