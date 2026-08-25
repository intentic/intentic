import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { getSubagentMessages } from "@anthropic-ai/claude-agent-sdk";
import type { RestoredMessage, RestoredToolCall } from "@intentic/sandbox-contract";
import { subagentAgentId, subagentSource } from "../agent/subagents.js";
import { turnRunOf } from "../agent/turn-runs.js";
import { displayNameOf, toolCategoryOf } from "../agent/tool-calls.js";
import type { OpenCodeService } from "../grok/opencode.js";
import type { TranscriptAgent } from "./agent-transcript.js";
import { readCodexSession } from "./codex-sessions.js";
import { restoredSessionMessages } from "./sessions.js";
import { restoredTurn, subagentTurn } from "./turn-transcript.js";

/* ONE SUBAGENT'S TRANSCRIPT, in the shape every other transcript route already answers in.
 *
 * The split here is the one the daemon already makes for a conversation, and it is why surfacing a subagent needed
 * no new streaming channel: a RUNNING child is served from its parent turn's frame log (its frames are in there,
 * tagged with the tool call that spawned it, see subagentTurn), and a FINISHED one is served from whatever store
 * actually ran it. So nothing is buffered twice, and nothing depends on how eagerly a provider flushes its own
 * files while work is in flight.
 *
 * Each kind has its reader already, which is the whole reason delegations could join this surface at the same
 * cost as the SDK's own children:
 *   • subagent, the SDK writes a per-child JSONL beside its session's, and exposes getSubagentMessages over it.
 *     Reduced by the SAME function a parent conversation is (restoredSessionMessages), so a child's cards read
 *     identically to its parent's.
 *   • codex, a rollout under CODEX_HOME, already read by readCodexSession.
 *   • grok, an OpenCode session in the store the delegated `opencode run` shares with the daemon's warm server
 *     (composition.ts wires them to one XDG_DATA_HOME), so its own client can read it.
 *
 * An empty result is a real answer: a child that has produced nothing yet, or one whose store has been swept. The
 * caller renders "nothing recorded" rather than an error, the same way a conversation with no transcript does. */

// What a delegated read needs from the composition, threaded in rather than imported: this module is reached from
// a route, which has the services, and importing them here would tie a transcript reader to the container.
export interface SubagentTranscriptDeps {
    readonly root: string;
    readonly codexHome: string | undefined;
    readonly openCode: OpenCodeService;
    // A spawned child is a conversation of its own, so its settled record is the conversation's transcript
    // record, read under the same (id, provider, harness) its turns were filed under.
    readonly conversation: (agent: TranscriptAgent) => Promise<RestoredMessage[]>;
}

/* WHICH delegated thread/session a record refers to, when its command did not name one.
 *
 * A fresh `codex exec` prints its thread id and we deliberately do not parse that: an output format is a thing
 * that changes, and the store itself carries the answer. Codex names each rollout `rollout-<ISO>-<threadId>.jsonl`
 * and OpenCode stamps every session with its creation time, so "the newest one created at or after this
 * delegation started" identifies it without reading a byte of stdout.
 *
 * The slack absorbs the gap between the tool call being streamed and the CLI actually writing its first line. Two
 * delegations to the SAME provider started inside that window could in principle be resolved to each other's
 * thread; the honest fix is the CLI naming its own session id on the command line, and until then this is the
 * failure worth having, a transcript from the wrong sibling, rather than none for either.
 */
const RESOLVE_SLACK_MS = 5_000;

// Rollouts are filed under sessions/YYYY/MM/DD, so the walk is shallow and the NAME carries the timestamp, no
// file has to be opened to rank candidates.
const rollouts = async (dir: string): Promise<{ readonly threadId: string; readonly at: number }[]> => {
    const found: { threadId: string; at: number }[] = [];
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
        if (entry.isDirectory()) {
            found.push(...(await rollouts(join(dir, entry.name))));
            continue;
        }
        const match = /^rollout-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(.+)\.jsonl$/u.exec(entry.name);
        if (match === null) {
            continue;
        }
        const at = Date.parse(`${match[1]}T${match[2]}:${match[3]}:${match[4]}Z`);
        if (!Number.isNaN(at)) {
            found.push({ threadId: match[5] ?? "", at });
        }
    }
    return found;
};

const codexThreadSince = async (home: string, since: number): Promise<string | undefined> =>
    (await rollouts(join(home, "sessions"))).filter((entry) => entry.at >= since - RESOLVE_SLACK_MS).toSorted((left, right) => left.at - right.at)[0]
        ?.threadId;

const grokSessionSince = async (openCode: OpenCodeService, cwd: string, since: number): Promise<string | undefined> => {
    const client = await openCode.client();
    const listed = (await client.session.list({ query: { directory: cwd } })).data ?? [];
    const candidates = listed
        .map((session) => ({ id: session.id, at: session.time?.created ?? 0 }))
        .filter((session) => session.at >= since - RESOLVE_SLACK_MS);
    return candidates.toSorted((left, right) => left.at - right.at)[0]?.id;
};

/* An OpenCode session read back as a transcript. Its own vocabulary is close to ours: one message per turn with a
 * `parts` array, where a text part is prose and a tool part is a card carrying its own state. Read through a
 * narrow local shape rather than the SDK's full union (the same thing sessions.ts does for stored Anthropic
 * blocks), this needs five fields, and pinning to more of a generated type buys nothing but breakage. */
interface OpenCodePart {
    readonly type?: string;
    readonly text?: string;
    readonly tool?: string;
    readonly callID?: string;
    readonly state?: { readonly status?: string; readonly output?: string; readonly error?: string; readonly title?: string };
}

const readGrokSession = async (openCode: OpenCodeService, cwd: string, sessionId: string): Promise<RestoredMessage[]> => {
    const client = await openCode.client();
    const listed = (await client.session.messages({ path: { id: sessionId }, query: { directory: cwd } })).data ?? [];
    return listed.flatMap((entry): RestoredMessage[] => {
        const role = entry.info.role === "user" ? "user" : "assistant";
        let text = "";
        const tools: RestoredToolCall[] = [];
        for (const part of entry.parts as readonly OpenCodePart[]) {
            if (part.type === "text" && part.text !== undefined) {
                text += part.text;
                continue;
            }
            if (part.type !== "tool" || part.tool === undefined) {
                continue;
            }
            const failed = part.state?.status === "error";
            const output = failed ? part.state?.error : part.state?.output;
            tools.push({
                id: part.callID ?? `${entry.info.id}:${tools.length}`,
                name: displayNameOf(part.tool),
                category: toolCategoryOf(part.tool),
                // A part still pending/running is a session read mid-turn, which is honest to redraw as such.
                status: failed ? "failed" : part.state?.status === "completed" ? "completed" : "in_progress",
                ...(part.state?.title !== undefined ? { target: part.state.title } : {}),
                ...(output !== undefined ? { content: [{ type: "text" as const, text: output }] } : {}),
            });
        }
        return text.length > 0 || tools.length > 0 ? [{ role, text, ...(tools.length > 0 ? { tools } : {}) }] : [];
    });
};

export const readSubagentTranscript = async (deps: SubagentTranscriptDeps, id: string): Promise<RestoredMessage[]> => {
    const source = subagentSource(id);
    if (source === undefined) {
        return [];
    }
    /* WHILE IT RUNS, the parent's frame log is the only complete account, and for a subagent it is a BETTER one
     * than the file, because the frames were normalized on their way through (display names, call-time diffs) by
     * the same helpers a card is built from. A delegation has no frames of its own (its work happens inside one
     * Bash call), so it falls through to its store even while running, and its live view stays the terminal.
     */
    if (source.kind === "subagent" && source.running) {
        const run = turnRunOf(source.conversationId);
        if (run !== undefined) {
            return subagentTurn(run.events, id, source.description);
        }
    }
    if (source.kind === "subagent") {
        // Both ids are needed and either can be missing: the session's is the turn's own, and the child's is
        // paired to the spawning tool call out of the SDK's meta files here, at read time (subagentAgentId says
        // why it cannot be known earlier). A child from a session neither ever named has no file to point at.
        const agentId = await subagentAgentId(id);
        if (source.sessionId === undefined || agentId === undefined) {
            return [];
        }
        const messages = await getSubagentMessages(source.sessionId, agentId, { dir: source.cwd });
        return restoredSessionMessages(messages, deps.root);
    }
    /* A SPAWNED child is a conversation of its own, and the record's id IS that conversation's id, so both
     * halves of the split read the stores a conversation already writes: live from its own detached pump (the
     * pump holds the prompt too, so the transcript opens with what it was asked), settled from the
     * conversation's transcript record, under the provider and harness key its turns were filed with. */
    if (source.kind === "spawned") {
        if (source.running) {
            const run = turnRunOf(id);
            if (run !== undefined) {
                return restoredTurn({ prompt: run.prompt }, run.events, deps.root, source.startedAt);
            }
        }
        if (source.provider === undefined || source.harness === undefined) {
            return [];
        }
        return deps.conversation({ id, provider: source.provider, harness: source.harness });
    }
    if (source.kind === "codex") {
        if (deps.codexHome === undefined) {
            return [];
        }
        const thread = source.thread ?? (await codexThreadSince(deps.codexHome, source.startedAt));
        return thread === undefined ? [] : readCodexSession(deps.codexHome, thread, deps.root);
    }
    const session = source.thread ?? (await grokSessionSince(deps.openCode, source.cwd, source.startedAt));
    return session === undefined ? [] : readGrokSession(deps.openCode, source.cwd, session);
};
