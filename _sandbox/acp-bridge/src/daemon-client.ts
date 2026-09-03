import { RequestError } from "@agentclientprotocol/sdk";
import { type AgentReply, type AgentTurn, type AttachFrame, AttachFrameSchema, sseData, sseFrames, type TranscriptRow } from "@intentic/sandbox-contract";

/* The bridge's view of the sandbox daemon: a turn started with POST /agent and watched over /agent/attach (the
 * run's rows on the head, then every change to them and every fact about the turn), plus the reply side
 * channel and the session store, every call carrying an `editor`-scoped control token (x-intentic-control,
 * see the daemon's auth/grants.ts). A 401 surfaces as ACP auth_required so the editor re-runs the auth flow; a
 * 403 names the scope violation, which for this bridge means the daemon's editor scope and this client have
 * drifted apart. Unknown frame shapes are skipped (forward compatibility: a newer daemon must not break an
 * older bridge). */

export interface DaemonClient {
    // The whole attach stream of the turn just started: its head, its entries, its end.
    readonly streamTurn: (turn: AgentTurn, signal: AbortSignal) => AsyncGenerator<AttachFrame>;
    // Un-parks a turn waiting on any interactive card (plan / question / permission), one route, one body.
    readonly postReply: (reply: AgentReply) => Promise<void>;
    readonly getSession: (id: string) => Promise<TranscriptRow[]>;
    // The auth probe (also `intentic-acp login`'s validation call).
    readonly listSessions: () => Promise<void>;
}

const raise = (status: number, body: string): never => {
    if (status === 401) {
        throw RequestError.authRequired({ details: "The sandbox rejected the bridge token, mint a new one in the sandbox's Sync settings." });
    }
    throw RequestError.internalError({ details: `sandbox responded ${status}: ${body.slice(0, 300)}` });
};

export const createDaemonClient = (url: string, token: string): DaemonClient => {
    const headers = { "x-intentic-control": token };
    const request = async (path: string, init?: RequestInit): Promise<Response> => {
        const response = await fetch(`${url}${path}`, { ...init, headers: { ...headers, ...init?.headers } });
        if (!response.ok) {
            raise(response.status, await response.text().catch(() => ""));
        }
        return response;
    };
    const post = (path: string, body: unknown, signal?: AbortSignal): Promise<Response> =>
        request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), ...(signal === undefined ? {} : { signal }) });

    return {
        async *streamTurn(turn, signal) {
            // The ack names the run; the attach is what carries it. Two requests because the turn runs detached
            // on the daemon whether or not anybody watches, and the watcher is a separate connection by design.
            const started = (await (await post("/agent", turn, signal)).json()) as { run?: string };
            const response = await post("/agent/attach", { conversationId: turn.conversationId, ...(started.run === undefined ? {} : { run: started.run }) }, signal);
            if (response.body === null) {
                throw RequestError.internalError({ details: "sandbox returned no stream" });
            }
            for await (const frame of sseFrames(response.body)) {
                const parsed = AttachFrameSchema.safeParse(sseData(frame));
                if (parsed.success) {
                    yield parsed.data;
                }
            }
        },
        postReply: async (reply) => {
            await post("/agent/reply", reply);
        },
        getSession: async (id) => {
            const response = await request(`/sessions/${encodeURIComponent(id)}`);
            const body = (await response.json()) as { messages?: TranscriptRow[] };
            return body.messages ?? [];
        },
        listSessions: async () => {
            await request("/sessions");
        },
    };
};
