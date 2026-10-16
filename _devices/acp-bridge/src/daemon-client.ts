import { RequestError } from "@agentclientprotocol/sdk";
import { FetchJsonError, type FetchJsonInit, fetchJsonResponse, type JsonValue } from "@intentic/base/fetch-json";
import { agentContract } from "@intentic/sandbox-contract/contracts/agent.contract";
import type { AgentReply } from "@intentic/sandbox-contract/schemas/providers/plan-limits";
import { type AgentTurn, MessageReceiptSchema } from "@intentic/sandbox-contract/schemas/agent";
import { type AttachFrame, AttachFrameSchema } from "@intentic/sandbox-contract/events/agent-events";
import { procedurePath } from "@intentic/sandbox-contract/protocol/routes";
import { sessionsContract } from "@intentic/sandbox-contract/contracts/sessions.contract";
import { sseData, sseFrames } from "@intentic/sandbox-contract/protocol/sse";
import { type TranscriptRow, TranscriptRowSchema } from "@intentic/sandbox-contract/events/transcript";
import { z } from "zod";

// The bridge's view of the daemon: POST /agent starts a turn, /agent/attach watches it (head rows, then every change
// and fact), plus a reply side channel and the session store. Paths come from the contract's procedures and answers are
// parsed with its schemas; the attach stream is read here rather than through oRPC's client, which the bridge, a
// published install, does not carry.
// Every call carries an editor-scoped control token (x-intentic-control); a 401 surfaces as ACP auth_required, a 403
// means this client's scope has drifted from the daemon's. The JSON calls go over base's transport, so a sandbox that
// stops answering fails the call in 30 s (and says it timed out) instead of holding the editor's prompt open.
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
    // One JSON call; a refusal (bar the accepted statuses) raised as the ACP error it means.
    const call = async (path: string, init: Pick<FetchJsonInit, "method" | "json" | "accept" | "signal"> = {}): Promise<JsonValue | undefined> => {
        try {
            const answer = await fetchJsonResponse(`${url}${path}`, { ...init, headers, label: `sandbox ${path}` });
            // An accepted refusal (a 404 the caller reads as "none") answers nothing.
            return answer.status >= 300 ? undefined : answer.json;
        } catch (error) {
            if (error instanceof FetchJsonError && error.kind === "status" && error.status !== undefined) {
                raise(error.status, error.body ?? "");
            }
            throw error;
        }
    };

    return {
        async *streamTurn(turn, signal) {
            // Two requests: the ack names the run the turn started as; attach is the separate, detached watch on it.
            const started = StartedSchema.safeParse(await call(procedurePath(agentContract.run), { method: "POST", json: turn, signal })).data ?? {};
            // The attach stream runs as long as the turn does, so it is the one call outside the JSON transport's deadline.
            const response = await fetch(`${url}${procedurePath(agentContract.attach)}`, {
                method: "POST",
                headers: { ...headers, "content-type": "application/json" },
                body: JSON.stringify({ conversationId: turn.conversationId, ...(started.run === undefined ? {} : { run: started.run }) }),
                signal,
            });
            if (!response.ok) {
                raise(response.status, await response.text().catch(() => ""));
            }
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
            await call(procedurePath(agentContract.reply), { method: "POST", json: reply });
        },
        getSession: async (id) => {
            // No transcript under that id (a 404, answered as undefined) is nothing to replay; a refused token or a
            // failing sandbox is not that.
            const answer = await call(procedurePath(sessionsContract.get, { id }), { accept: [404] });
            // A row this bridge cannot read is skipped, as an unknown attach frame is, rather than failing the replay.
            const rows = TranscriptSchema.safeParse(answer).data?.messages ?? [];
            return rows.flatMap((row) => TranscriptRowSchema.safeParse(row).data ?? []);
        },
        listSessions: async () => {
            await call(procedurePath(sessionsContract.list));
        },
    };
};
