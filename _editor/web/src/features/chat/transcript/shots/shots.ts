import type { TranscriptTool } from "@intentic/sandbox-contract";
import type { ChatMessage, ChatTurn } from "../transcript";

// The pictures a turn's tools showed the agent (a screenshot it took, an image it read back), for the strip at the
// turn's end and the conversation's one viewer. Pure over the rows, so a live chat and a reopened one agree.

export interface ChatShot {
    // One per call and file, unique within the conversation.
    readonly key: string;
    readonly path: string;
    readonly toolId: string;
    // The turn it belongs to (ChatTurn.id), which the strip, the filmstrip's groups and the caption are keyed by.
    readonly turnId: number;
}

interface RowShot {
    readonly path: string;
    readonly toolId: string;
}

// A shot's identity, shared by the strip and a tool card's own picture so both open the viewer at the same place.
export const shotKey = (toolId: string, path: string): string => `${toolId}\n${path}`;

// Depth-first in the order the row drew its calls, a delegation's own calls right after the card that spawned them.
const shotsOfTools = (tools: readonly TranscriptTool[], into: RowShot[]): RowShot[] => {
    for (const tool of tools) {
        for (const entry of tool.content ?? []) {
            if (entry.type === `image`) {
                into.push({ path: entry.path, toolId: tool.id });
            }
        }
        shotsOfTools(tool.children ?? [], into);
    }
    return into;
};

// Keyed by the row object: a row that changes is replaced, never mutated (transcriptState's mapMessage), so a hit is
// current and a streaming paint costs one lookup per settled row.
const byRow = new WeakMap<ChatMessage, readonly RowShot[]>();

const rowShots = (message: ChatMessage): readonly RowShot[] => {
    const held = byRow.get(message);
    if (held !== undefined) {
        return held;
    }
    const found = message.role === `assistant` && message.tools !== undefined ? shotsOfTools(message.tools, []) : [];
    byRow.set(message, found);
    return found;
};

// Files the user attached anywhere in the conversation: the agent reading one back is not a picture of its own work.
export const attachedPaths = (messages: readonly ChatMessage[]): ReadonlySet<string> =>
    new Set(messages.flatMap((message) => (message.role === `user` ? (message.attachments ?? []) : [])));

// A turn's shots in the order it showed them; a file shown twice (taken, then Read back) stands once, where it was last
// shown, since the path draws whatever is on disk now either way.
export const shotsOfTurn = (turn: ChatTurn, attached: ReadonlySet<string>): readonly ChatShot[] => {
    const last = new Map<string, RowShot>();
    for (const message of turn.messages) {
        for (const shot of rowShots(message)) {
            if (attached.has(shot.path)) {
                continue;
            }
            last.delete(shot.path);
            last.set(shot.path, shot);
        }
    }
    return [...last.values()].map((shot) => ({ key: shotKey(shot.toolId, shot.path), path: shot.path, toolId: shot.toolId, turnId: turn.id }));
};

// The array a turn had before when its shots are unchanged, so a settled turn's strip gets the same prop every paint.
const sameShots = (before: readonly ChatShot[] | undefined, after: readonly ChatShot[]): readonly ChatShot[] =>
    before !== undefined && before.length === after.length && before.every((shot, index) => shot.key === after[index]?.key) ? before : after;

// Every turn's shots by turn id, reusing `previous`'s arrays wherever a turn's shots did not change.
export const shotsByTurn = (
    turns: readonly ChatTurn[],
    attached: ReadonlySet<string>,
    previous: ReadonlyMap<number, readonly ChatShot[]> | undefined,
): ReadonlyMap<number, readonly ChatShot[]> => new Map(turns.map((turn) => [turn.id, sameShots(previous?.get(turn.id), shotsOfTurn(turn, attached))]));

// What a shot is called in a caption: the file's own name, which is the agent's caption when it named the shot.
export const shotName = (path: string): string => {
    const file = path.split(`/`).at(-1) ?? path;
    const dot = file.lastIndexOf(`.`);
    return dot > 0 ? file.slice(0, dot) : file;
};
