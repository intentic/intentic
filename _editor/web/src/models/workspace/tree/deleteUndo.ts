import { sandboxRef } from "@intentic/extension-api";
import { scopeKey, workspaceView, type ViewScope } from "../../../app/workspaceScope";
import { computed, toRaw } from "vue";

// File changes this tab can take back, newest last, as a file manager's Undo walks back its own history: a delete, a
// move or rename, and an entry made (a new file or folder, a copy, an archive unpacked). Mod+Z takes back the newest
// whole gesture, a second Mod+Z the one before it. Held per sandbox and only in memory: an undo is a reflex right after
// the fact, not an archive.
//
// A delete sends each entry to the daemon's trash and answers an id, which is what brings it back; the daemon keeps the
// trash a day, so a batch this tab still holds can outlive what it names, and restoring one of those says so. A move is
// taken back by moving each entry home, which the daemon refuses where something new took the name since. An entry made
// is taken back by sending it to the trash.

export interface TrashedEntry {
    // Where it was deleted from, which is where it goes back to.
    readonly path: string;
    readonly type: "file" | "dir";
    readonly trashed: string;
}

export interface DeleteBatch {
    readonly entries: readonly TrashedEntry[];
}

export interface MoveBatch {
    readonly moves: readonly { readonly from: string; readonly to: string }[];
}

export interface CreateBatch {
    readonly created: readonly string[];
}

export type FileStep = DeleteBatch | MoveBatch | CreateBatch;

// Deep enough for a run of changes worth walking back; past it the oldest drop off the bottom.
const DEPTH = 50;

const stacks = sandboxRef(() => new Map<string, readonly FileStep[]>());
const stackIn = (view: ViewScope): readonly FileStep[] => stacks.value.get(scopeKey(view)) ?? [];

/** Whether there is anything to take back: what decides whether Mod+Z is the workspace's or passes through. */
export const fileUndoable = computed(() => stackIn(workspaceView.value).length > 0);

const remember = (step: FileStep, size: number, view: ViewScope): void => {
    if (size > 0) {
        stacks.value.set(scopeKey(view), [...stackIn(view), step].slice(-DEPTH));
    }
};

export const rememberDelete = (batch: DeleteBatch, view = workspaceView.value): void => remember(batch, batch.entries.length, view);

export const rememberMoves = (moves: MoveBatch[`moves`], view = workspaceView.value): void => remember({ moves }, moves.length, view);

export const rememberCreated = (created: readonly string[], view = workspaceView.value): void => remember({ created }, created.length, view);

// Takes the step off the stack, or the newest with none named; undefined when it was taken already (an Undo button
// pressed after Mod+Z took the same delete back), so a step is never taken back twice.
// Compared raw: the stack hands out reactive proxies, a receipt holds the batch as it was made.
export const takeStep = <T extends FileStep>(step?: T): T | FileStep | undefined => {
    const stack = stackIn(workspaceView.value);
    const wanted = step ?? stack.at(-1);
    const taken = wanted === undefined ? undefined : toRaw(wanted);
    if (taken === undefined || !stack.some((held) => toRaw(held) === taken)) {
        return undefined;
    }
    stacks.value.set(scopeKey(workspaceView.value), stack.filter((held) => toRaw(held) !== taken));
    return taken;
};
