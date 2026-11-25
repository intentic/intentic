import { setTimeout as sleep } from "node:timers/promises";
import { sandboxContract } from "@intentic/sandbox-contract";
import type { TranscriptRow, TranscriptTool } from "@intentic/sandbox-contract/events/transcript";
import type { AgentStatus } from "@intentic/sandbox-contract/schemas/agents";
import { createORPCClient } from "@orpc/client";
import type { ContractRouterClient } from "@orpc/contract";
import { OpenAPILink } from "@orpc/openapi-client/fetch";
import type { Observation, ToolCall } from "./grade.testing.js";

// One owner message sent to a real daemon as the editor sends it (POST /agent), waited out, and read back from the
// daemon's records: the conversation's card state, its transcript and the needs it raised.

export type DaemonClient = ContractRouterClient<typeof sandboxContract>;

export const daemonClient = (base: string): DaemonClient => createORPCClient(new OpenAPILink(sandboxContract, { url: base }));

// Where a turn is still going; anything else is where it ended (awaiting: parked on a question for the owner).
const MOVING: ReadonlySet<AgentStatus> = new Set(["running", "resuming", "stopping"]);

const flatten = (tools: readonly TranscriptTool[]): readonly ToolCall[] =>
    tools.flatMap((tool) => [{ name: tool.name, category: tool.category, target: tool.target }, ...flatten(tool.children ?? [])]);

const rowsOf = async (client: DaemonClient, conversationId: string, run: string): Promise<readonly TranscriptRow[]> =>
    (await client.agents.transcript({ id: conversationId })).messages.filter((row) => row.run === run);

export interface TurnOptions {
    readonly model?: string | undefined;
    // The most a turn may take before it is stopped and graded as it stands.
    readonly deadlineMs: number;
}

export interface Turn extends Observation {
    readonly run: string;
    readonly timedOut: boolean;
    // What happened to the turn rather than what the agent said: a refusal, a failure, a stop.
    readonly notices: readonly string[];
}

// Polled, as the e2e harness polls (`until` in harness/e2e-harness.ts): the daemon's /agent/attach stream would say it
// sooner, but a turn takes minutes and a two-second beat costs nothing against that.
const POLL_MS = 2_000;

export const runTurn = async (client: DaemonClient, conversationId: string, prompt: string, options: TurnOptions): Promise<Turn> => {
    const message: Parameters<DaemonClient["agent"]["run"]>[0] = { conversationId, prompt };
    if (options.model !== undefined) {
        message.model = options.model;
    }
    const receipt = await client.agent.run(message);
    const run = receipt.run;
    if (receipt.delivered !== "started" || run === undefined) {
        throw new Error(`the message to ${conversationId} did not start a turn (${receipt.delivered})`);
    }
    const deadline = Date.now() + options.deadlineMs;
    let status: AgentStatus = "running";
    let rows: readonly TranscriptRow[] = [];
    let timedOut = false;
    for (;;) {
        status = (await client.agents.get({ id: conversationId })).status;
        rows = await rowsOf(client, conversationId, run);
        // Settled once the card has stopped moving and the run has written something of its own, so a card read in the
        // instant before the run marked it running is not taken for the end.
        if (!MOVING.has(status) && rows.some((row) => row.role !== "user")) {
            break;
        }
        if (Date.now() > deadline) {
            timedOut = true;
            break;
        }
        await sleep(POLL_MS);
    }
    // A turn parked on a question, or out of time, is stopped so it holds nothing while the rest run.
    if (timedOut || status === "awaiting") {
        await client.agent.stop({ conversationId, run }).catch(() => undefined);
    }
    const { needs } = await client.needs.list({ conversationId });
    const spoken = rows.filter((row) => row.role === "assistant" && row.text.trim() !== "");
    return {
        run,
        timedOut,
        status,
        needs,
        tools: flatten(rows.flatMap((row) => row.tools ?? [])),
        reply: spoken.at(-1)?.text ?? "",
        notices: rows.filter((row) => row.role === "notice").map((row) => row.text),
    };
};
