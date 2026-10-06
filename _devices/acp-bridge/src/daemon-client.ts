import { RequestError } from "@agentclientprotocol/sdk";
import {
    agentContract,
    type AgentReply,
    type AgentTurn,
    type AttachFrame,
    AttachFrameSchema,
    MessageReceiptSchema,
    procedurePath,
    sessionsContract,
    sseData,
    sseFrames,
    type TranscriptRow,
    TranscriptRowSchema,
} from "@intentic/sandbox-contract";
import { z } from "zod";

// The bridge's view of the daemon: POST /agent starts a turn, /agent/attach watches it (head rows, then every change
// and fact), plus a reply side channel and the session store. Paths come from the contract's procedures and answers are
// parsed with its schemas; the attach stream is read here rather than through oRPC's client, which the bridge, a
// published install, does not carry.
// Every call carries an editor-scoped control token (x-intentic-control); a 401 surfaces as ACP auth_required, a 403
// means this client's scope has drifted from the daemon's.
// Unknown frame shapes are skipped, so a newer daemon cannot break an older bridge.

// Only the fields the bridge acts on, so an answer an older or newer daemon shapes differently still reads.
const StartedSchema = MessageReceiptSchema.pick({ run: true });
const TranscriptSchema = z.object({ messages: z.array(z.unknown()).optional() });

export interface DaemonClient {
    // Whole attach stream of the turn just started: its head, its entries, its end.
    readonly streamTurn: (turn: AgentTurn, signal: AbortSignal) => AsyncGenerator<AttachFrame>;
    // Un-parks a turn waiting on any interactive card (plan, question, permission); one route, one body.
    readonly postReply: (reply: AgentReply) => Promise<void>;
    readonly getSession: (id: string) => Promise<TranscriptRow[]>;
    // Auth probe, also used by `intentic-acp login`'s validation call.
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
            // Two requests: the ack names the run the turn started as; attach is the separate, detached watch on it.
            const started = StartedSchema.safeParse(await (await post(procedurePath(agentContract.run), turn, signal)).json()).data ?? {};
            const response = await post(
                procedurePath(agentContract.attach),
                { conversationId: turn.conversationId, ...(started.run === undefined ? {} : { run: started.run }) },
                signal,
            );
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
            await post(procedurePath(agentContract.reply), reply);
        },
        getSession: async (id) => {
            const response = await fetch(`${url}${procedurePath(sessionsContract.get, { id })}`, { headers });
            // No transcript under that id is nothing to replay; a refused token or a failing sandbox is not that.
            if (response.status === 404) {
                await response.body?.cancel();
                return [];
            }
            if (!response.ok) {
                raise(response.status, await response.text());
            }
            // A row this bridge cannot read is skipped, as an unknown attach frame is, rather than failing the replay.
            const rows = TranscriptSchema.safeParse(await response.json()).data?.messages ?? [];
            return rows.flatMap((row) => TranscriptRowSchema.safeParse(row).data ?? []);
        },
        listSessions: async () => {
            await request(procedurePath(sessionsContract.list));
        },
    };
};
