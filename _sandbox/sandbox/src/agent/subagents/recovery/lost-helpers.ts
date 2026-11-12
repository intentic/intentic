import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { undefinedIfMissing } from "@intentic/base/errors";
import type { TranscriptRow, TranscriptTool, TurnNote } from "@intentic/sandbox-contract/events/transcript";
import type { RoutedTurn } from "../../../seams/turn-starter.js";
import type { HeldTurn } from "../../run/turn/holds/held-turn.js";
import type { Services } from "../../../composition.js";
import { findSubagentRecord } from "../subagent-transcript.js";
import { thawClaudeSession } from "../../../sessions/session-freeze.js";

const toolsIn = (tools: readonly TranscriptTool[]): TranscriptTool[] => tools.flatMap((tool) => [tool, ...toolsIn(tool.children ?? [])]);

/** Helpers whose runtime ended with the previous turn, read from the durable cards after a restart too. */
export const lostHelperNote = async (
    services: Pick<Services, "agents" | "agentWorktrees" | "transcripts">,
    params: {
        readonly conversationId: string;
        readonly sessionId: string | undefined;
        readonly history: readonly TranscriptRow[];
        readonly localCwd: string;
        readonly reason: string;
    },
): Promise<TurnNote | undefined> => {
    const rows = params.history.length > 0 ? params.history : (await services.transcripts.page({ id: params.conversationId }, { turns: 1 })).rows;
    const run = rows.findLast((row) => row.run !== undefined)?.run;
    const helpers = rows.filter((row) => run === undefined || row.run === run).flatMap((row) => toolsIn(row.tools ?? []))
        .filter((tool) => tool.subagent?.kind === "subagent" &&
            tool.subagent.status !== "completed" && tool.subagent.status !== "failed");
    if (helpers.length === 0) {
        return undefined;
    }
    const store = services.agentWorktrees.sessionStore(services.agents.entry(params.conversationId));
    const worktrees = (await readdir(join(params.localCwd, ".claude/worktrees"), { withFileTypes: true }).catch(undefinedIfMissing)) ?? [];
    const lines = await Promise.all(helpers.map(async (tool) => {
        const sdk = tool.subagent?.sdk ?? (params.sessionId === undefined ? undefined : await findSubagentRecord(store, params.sessionId, tool.id));
        const text = (tool.content ?? []).flatMap((part) => part.type === "text" ? [part.text] : []).join("\n");
        const agentId = sdk?.agentId ?? /agentId:\s*(a[\da-f]{16})\b/u.exec(text)?.[1];
        const tree = agentId === undefined ? undefined : worktrees.find((entry) => entry.isDirectory() && entry.name === `agent-${agentId}`);
        const outputs = [...text.matchAll(/(?:output_file|worktree_path):\s*(\S+)/gu)].map((match) => match[1]);
        // The record named here plain again, if the cold-session sweep compressed it (sessions/session-freeze.ts).
        if (sdk !== undefined) {
            await thawClaudeSession(store, sdk.sessionId);
        }
        const record = sdk === undefined ? [] : [`${store}/projects/*/${sdk.sessionId}/subagents/agent-${sdk.agentId}.jsonl`];
        return `- ${agentId ?? tool.id}: ${tool.subagent?.description ?? tool.target ?? tool.name}. ` +
            `Worktree: ${tree === undefined ? ".claude/worktrees/agent-* (check for a retained worktree)" : `.claude/worktrees/${tree.name}`}. ` +
            `Partial work: edits in that worktree; saved tool calls in this conversation's helper card` +
            `${outputs.length + record.length === 0 ? "" : `; output/record: ${[...outputs, ...record].join(", ")}`}.`;
    }));
    return {
        title: "In-process helpers lost with the previous turn",
        text: `The sandbox ended these in-process helpers when the previous turn ended (${params.reason}). ${params.reason === "allowance hand-off" || params.reason === "sandbox restart" ? "This was not a user stop. " : ""}They cannot receive SendMessage or continue running. Inspect their retained worktrees and partial output before assigning their unfinished work again. A container recreation may have cleared output under /tmp; keep recovered evidence in /work/.intentic/records/artifacts/.\n${lines.join("\n")}`,
    };
};


/** A continuing turn recovers helper locations even when it resumes its provider session without history. */
export const continuationHelperNote = async (
    services: Services,
    params: { readonly input: RoutedTurn; readonly held: HeldTurn | undefined; readonly history: readonly TranscriptRow[]; readonly localCwd?: string },
): Promise<TurnNote | undefined> => {
    const { input, held, history } = params;
    const conversationId = input.conversationId;
    if (conversationId === undefined || (input.resume === undefined && held === undefined && history.length === 0)) {
        return undefined;
    }
    const reason = held?.reason === "limit" ? "allowance hand-off" : input.resume === "restart" || input.resume === "answered" ? "sandbox restart" : "previous turn ended";
    return lostHelperNote(services, {
        conversationId, sessionId: held?.sessionId ?? input.sessionId, history,
        localCwd: params.localCwd ?? services.workspace.root, reason,
    }).catch((error: unknown) => {
        services.logger.warn({ err: error, conversationId }, "could not recover lost helper locations");
        return undefined;
    });
};
