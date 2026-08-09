import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { RestoredMessage, RestoredToolCall } from "@intentic/sandbox-contract";
import { stripAttachmentNote } from "../agent/attachment-note.js";
import { displayNameOf, toolCategoryOf } from "../agent/tool-calls.js";
import { preambleNotes, stripTurnPreamble } from "../agent/turn-preamble.js";

// Codex persists each thread as a rollout under <CODEX_HOME>/sessions/YYYY/MM/DD/rollout-<ISO8601>-<threadId>.jsonl
// (the id is the app-server `thread/start` result). Readiness and transcript backfill must answer without
// starting another app-server process, so finding a thread's rollout means scanning the home's sessions/ tree
// for the file whose name carries the thread id. There is a single sandbox-wide CODEX_HOME (Codex authenticates
// through the translator subscription, not per-account homes), so this is a plain lookup.
const ownsRollout = (fileName: string, threadId: string): boolean => fileName.startsWith("rollout-") && fileName.endsWith(`-${threadId}.jsonl`);

const findRollout = async (home: string, threadId: string): Promise<string | undefined> => {
    const walk = async (dir: string): Promise<string | undefined> => {
        for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
            const path = join(dir, entry.name);
            if (entry.isDirectory()) {
                const hit = await walk(path);
                if (hit !== undefined) {
                    return hit;
                }
            } else if (ownsRollout(entry.name, threadId)) {
                return path;
            }
        }
        return undefined;
    };
    return walk(join(home, "sessions"));
};

export const codexThreadExists = async (home: string, threadId: string): Promise<boolean> => (await findRollout(home, threadId)) !== undefined;

/* One rollout line. Two channels are interleaved in the file and they say different things:
 *
 * `event_msg` is the stream Codex hands its embedders — the user's message and the agent's replies, already
 * assembled. `response_item` is the raw model protocol underneath it: reasoning items, and the tool calls with
 * their outputs. So the conversation is read from the first and the tool cards from the second; taking messages
 * from both would double every reply, since `response_item.message` carries the same text (alongside the
 * developer/system messages, which are not part of the conversation and are dropped with it). */
interface RolloutLine {
    type?: string;
    payload?: {
        type?: string;
        // event_msg/user_message and event_msg/agent_message
        message?: string;
        // response_item/reasoning — present only when reasoning summaries are on; the item's real content is
        // encrypted, so a thread without summaries restores with no thinking rather than with ciphertext.
        summary?: { type?: string; text?: string }[];
        // response_item/custom_tool_call and /function_call, and their *_output counterparts
        call_id?: string;
        name?: string;
        input?: string;
        arguments?: string;
        status?: string;
        output?: string | { type?: string; text?: string }[];
    };
}

// A tool call's target line: the first line of what it was asked to run, bounded. The rollout stores the raw
// argument blob (a shell script, a JSON payload), and a card's target is a heading, not the payload.
const TARGET_LIMIT = 120;
const targetOf = (raw: string | undefined): string | undefined => {
    const first = raw
        ?.split("\n")
        .find((line) => line.trim().length > 0)
        ?.trim();
    if (first === undefined || first.length === 0) {
        return undefined;
    }
    return first.length > TARGET_LIMIT ? `${first.slice(0, TARGET_LIMIT)}…` : first;
};

const outputText = (output: string | { type?: string; text?: string }[] | undefined): string => {
    if (typeof output === "string") {
        return output;
    }
    return (output ?? []).map((block) => block.text ?? "").join("");
};

/* A finished Codex thread, in the shape a reopened chat redraws.
 *
 * This is the BACKFILL path, not the live one: a thread that ran under the transcript record reads back from
 * there, exactly as it streamed. What is here is the thread that ran before it — the rollout is a lower-level
 * format than the frames the client saw (the tool vocabulary is the model's, not the daemon's normalized one),
 * so the cards it yields are coarser than they were live. Coarse and present beats a blank conversation, which
 * is what every native Codex agent showed before this existed. */
export const readCodexSession = async (home: string, threadId: string, root: string): Promise<RestoredMessage[]> => {
    const path = await findRollout(home, threadId);
    if (path === undefined) {
        return [];
    }
    const raw = await readFile(path, "utf8").catch(() => undefined);
    if (raw === undefined) {
        return [];
    }

    const out: RestoredMessage[] = [];
    const cards = new Map<string, RestoredToolCall>();
    // The bubble the tool calls of the moment hang off. Codex emits an agent_message, then the calls it
    // introduced, so a message opens a fresh bubble and the calls that follow land under it.
    let bubble: RestoredMessage | undefined;
    const assistant = (): RestoredMessage => {
        if (bubble === undefined) {
            bubble = { role: "assistant", text: "" };
            out.push(bubble);
        }
        return bubble;
    };

    for (const line of raw.split("\n")) {
        if (line.length === 0) {
            continue;
        }
        let entry: RolloutLine;
        try {
            entry = JSON.parse(line) as RolloutLine;
        } catch {
            // A rollout the CLI was still writing when the daemon read it — a torn tail costs its own line.
            continue;
        }
        const payload = entry.payload;
        if (payload === undefined) {
            continue;
        }

        if (entry.type === "event_msg" && payload.type === "user_message" && payload.message !== undefined) {
            // The daemon folds its own notes into a Codex prompt exactly as it does a Claude one, and the
            // rollout stores the combined text — so the same unwrapping applies (see turn-transcript.ts).
            const stripped = stripAttachmentNote(stripTurnPreamble(payload.message));
            const attachments = stripped.attachments.map((file) => (file.startsWith(`${root}/`) ? file.slice(root.length + 1) : file));
            // And what was folded in, disclosed rather than merely removed — carried on the message exactly as
            // the other two readers carry it, because a Codex turn is told the same things a Claude one is.
            const notes = preambleNotes(payload.message);
            if (stripped.text.length > 0 || attachments.length > 0) {
                out.push({
                    role: "user",
                    text: stripped.text,
                    ...(attachments.length > 0 ? { attachments } : {}),
                    ...(notes.length > 0 ? { notes } : {}),
                });
            }
            bubble = undefined;
            continue;
        }
        if (entry.type === "event_msg" && payload.type === "agent_message" && payload.message !== undefined) {
            bubble = undefined;
            assistant().text = payload.message;
            continue;
        }
        if (entry.type !== "response_item") {
            continue;
        }
        if (payload.type === "reasoning") {
            const thinking = (payload.summary ?? []).map((part) => part.text ?? "").join("");
            if (thinking.length > 0) {
                const target = assistant();
                target.thinking = `${target.thinking ?? ""}${thinking}`;
            }
            continue;
        }
        if ((payload.type === "custom_tool_call" || payload.type === "function_call") && payload.call_id !== undefined) {
            const name = displayNameOf(payload.name ?? "tool");
            const target = targetOf(payload.input ?? payload.arguments);
            const card: RestoredToolCall = {
                id: payload.call_id,
                name,
                category: toolCategoryOf(name),
                // The rollout is written as the call settles, so a call recorded here ran; only its OUTPUT says
                // whether it worked, and that arrives on the line below.
                status: "in_progress",
                ...(target !== undefined ? { target } : {}),
            };
            const holder = assistant();
            holder.tools = [...(holder.tools ?? []), card];
            cards.set(payload.call_id, card);
            continue;
        }
        if ((payload.type === "custom_tool_call_output" || payload.type === "function_call_output") && payload.call_id !== undefined) {
            const card = cards.get(payload.call_id);
            if (card === undefined) {
                continue;
            }
            card.status = payload.status === "failed" ? "failed" : "completed";
            card.content = [{ type: "text", text: outputText(payload.output) }];
        }
    }
    // A bubble that never got prose (a turn that only ran tools) still carries its cards; one that got neither
    // is not a message and was never pushed.
    return out.filter((message) => message.role === "user" || message.text.length > 0 || (message.tools?.length ?? 0) > 0);
};
