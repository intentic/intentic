import type { TranscriptTool } from "@intentic/sandbox-contract";
import type { ShotLook } from "./shotLook";
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
// Read off the turns, since every user row is a turn's opener or folded into one: a few rows per turn rather than every
// row. `previous` is handed back when nothing was attached since, which is what lets each turn's shots below be kept
// from one frame to the next.
export const attachedPathsOf = (turns: readonly ChatTurn[], previous?: ReadonlySet<string>): ReadonlySet<string> => {
    const paths = new Set<string>();
    for (const turn of turns) {
        for (const message of [turn.messages[0], ...turn.folded]) {
            if (message?.role === `user`) {
                for (const path of message.attachments ?? []) {
                    paths.add(path);
                }
            }
        }
    }
    return previous !== undefined && previous.size === paths.size && [...paths].every((path) => previous.has(path)) ? previous : paths;
};

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

// A turn's shots as last read, by the turn object (turnsOf hands an unchanged turn back as the same object) and the set
// of attached paths they were read against: a streamed frame reads the one turn it changed, not every turn.
const byTurn = new WeakMap<ChatTurn, { readonly attached: ReadonlySet<string>; readonly shots: readonly ChatShot[] }>();

// Every turn's shots by turn id, reusing `previous`'s arrays wherever a turn's shots did not change.
export const shotsByTurn = (
    turns: readonly ChatTurn[],
    attached: ReadonlySet<string>,
    previous: ReadonlyMap<number, readonly ChatShot[]> | undefined,
): ReadonlyMap<number, readonly ChatShot[]> =>
    new Map(
        turns.map((turn) => {
            const held = byTurn.get(turn);
            if (held !== undefined && held.attached === attached) {
                return [turn.id, held.shots];
            }
            const shots = sameShots(previous?.get(turn.id), shotsOfTurn(turn, attached));
            byTurn.set(turn, { attached, shots });
            return [turn.id, shots];
        }),
    );

// Why a shot is set aside: nothing on it (shotLook.ts), or the same pixels as one the turn showed before it.
export type AsideReason = "plain" | "repeat";

export interface SortedShots {
    // What the strip and the viewer draw, in the turn's order.
    readonly shown: readonly ChatShot[];
    // Kept from the reader unless asked for, by key.
    readonly aside: ReadonlyMap<string, AsideReason>;
}

// A turn's shots split into what is worth a look and what is not. A shot not yet judged is shown: nothing is held back on
// a guess. A repeat is set aside after its first showing, which stays; a plain first showing is set aside as plain.
export const sortShots = (shots: readonly ChatShot[], look: (shot: ChatShot) => ShotLook | undefined): SortedShots => {
    const shown: ChatShot[] = [];
    const aside = new Map<string, AsideReason>();
    const seen = new Set<string>();
    for (const shot of shots) {
        const judged = look(shot);
        const print = judged?.print;
        if (print !== undefined && seen.has(print)) {
            aside.set(shot.key, `repeat`);
            continue;
        }
        if (print !== undefined) {
            seen.add(print);
        }
        if (judged?.plain === true) {
            aside.set(shot.key, `plain`);
            continue;
        }
        shown.push(shot);
    }
    return { shown, aside };
};

// What a shot is called in a caption: the file's own name, which is the agent's caption when it named the shot.
export const shotName = (path: string): string => {
    const file = path.split(`/`).at(-1) ?? path;
    const dot = file.lastIndexOf(`.`);
    return dot > 0 ? file.slice(0, dot) : file;
};
