import { type DeliverableKind, deliverableKindOf, type TranscriptTool } from "@intentic/sandbox-contract";
import type { ChatMessage, ChatTurn } from "../transcript";

// The documents a turn made or changed that a person opens rather than reads as code (a Word file, a deck, a sheet, a
// PDF, a web page), for the row under its answer. Read off the calls' own records, so a live chat and a reopened one
// list the same: an edit's locations and diff, and a command's locations, where the daemon names what the command
// wrote (_sandbox/sandbox/src/agent/tools/produced-documents.ts). Pure over the rows, like the turn's pictures (shots.ts).

export interface ChatDeliverable {
    readonly path: string;
    readonly kind: DeliverableKind;
    // The turn it belongs to (ChatTurn.id).
    readonly turnId: number;
}

// One call's effect on a file: written (made or changed), or deleted.
interface RowWrite {
    readonly path: string;
    readonly deleted: boolean;
}

// Paths an adapter spelled with a leading `./` are the same file as without (liveWrites.ts has the same fold).
const tidy = (path: string): string => (path.startsWith(`./`) ? path.slice(2) : path);

// What a settled call wrote. An edit that failed wrote nothing; a command's locations are only what the daemon found it
// wrote, so any settled one counts; a read, a search or a fetch touched files without making them.
const writesOf = (tool: TranscriptTool): readonly RowWrite[] => {
    if (tool.status !== `completed` && !(tool.category === `execute` && tool.status === `failed`)) {
        return [];
    }
    const located = (tool.locations ?? []).map((location) => location.path);
    switch (tool.category) {
        case `edit`: {
            const diffed = (tool.content ?? []).flatMap((entry) => (entry.type === `diff` ? [entry.path] : []));
            return [...located, ...diffed].map((path) => ({ path: tidy(path), deleted: false }));
        }
        case `execute`:
            return located.map((path) => ({ path: tidy(path), deleted: false }));
        case `delete`:
            return located.map((path) => ({ path: tidy(path), deleted: true }));
        default:
            return [];
    }
};

// Depth-first in the order the row drew its calls, a delegation's own calls right after the card that started them.
const writesOfTools = (tools: readonly TranscriptTool[], into: RowWrite[]): RowWrite[] => {
    for (const tool of tools) {
        into.push(...writesOf(tool));
        writesOfTools(tool.children ?? [], into);
    }
    return into;
};

// Keyed by the row object, which a change replaces rather than mutates (shots.ts has the same cache and the reason).
const byRow = new WeakMap<ChatMessage, readonly RowWrite[]>();

const rowWrites = (message: ChatMessage): readonly RowWrite[] => {
    const held = byRow.get(message);
    if (held !== undefined) {
        return held;
    }
    const found = message.role === `assistant` && message.tools !== undefined ? writesOfTools(message.tools, []).filter((write) => deliverableKindOf(write.path) !== undefined) : [];
    byRow.set(message, found);
    return found;
};

// A turn's documents in the order it last wrote them; one it deleted afterwards is gone from the list, since there is
// nothing left to open.
export const deliverablesOfTurn = (turn: ChatTurn): readonly ChatDeliverable[] => {
    const last = new Map<string, DeliverableKind>();
    for (const message of turn.messages) {
        for (const write of rowWrites(message)) {
            last.delete(write.path);
            const kind = deliverableKindOf(write.path);
            if (!write.deleted && kind !== undefined) {
                last.set(write.path, kind);
            }
        }
    }
    return [...last].map(([path, kind]) => ({ path, kind, turnId: turn.id }));
};

// The array a turn had before when its documents are unchanged, so a settled turn's row gets the same prop every paint.
const sameDeliverables = (before: readonly ChatDeliverable[] | undefined, after: readonly ChatDeliverable[]): readonly ChatDeliverable[] =>
    before !== undefined && before.length === after.length && before.every((entry, index) => entry.path === after[index]?.path) ? before : after;

// Every turn's documents by turn id, reusing `previous`'s arrays wherever a turn's list did not change.
export const deliverablesByTurn = (
    turns: readonly ChatTurn[],
    previous: ReadonlyMap<number, readonly ChatDeliverable[]> | undefined,
): ReadonlyMap<number, readonly ChatDeliverable[]> =>
    new Map(turns.map((turn) => [turn.id, sameDeliverables(previous?.get(turn.id), deliverablesOfTurn(turn))]));

// A document's name as the row shows it: the file's own name, extension and all, since the extension says what opens it.
export const deliverableName = (path: string): string => path.slice(path.lastIndexOf(`/`) + 1);
