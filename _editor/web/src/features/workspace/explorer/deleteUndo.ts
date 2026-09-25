import { sandboxRef } from "@intentic/extension-api";
import { computed, toRaw } from "vue";

// Deletes this tab can take back. A delete sends each entry to the daemon's trash and answers an id; the ids of one
// gesture are one batch, so Mod+Z brings back the whole gesture and a second Mod+Z the one before it. Held per sandbox
// and only in memory: an undo is a reflex right after the fact, not an archive. The daemon keeps the trash a day, so a
// batch this tab still holds can outlive what it names; restoring one of those says so.

export interface TrashedEntry {
    // Where it was deleted from, which is where it goes back to.
    readonly path: string;
    readonly type: "file" | "dir";
    readonly trashed: string;
}

export interface DeleteBatch {
    readonly entries: readonly TrashedEntry[];
}

// Deep enough for a run of deletes worth walking back; past it the oldest drop off the bottom.
const DEPTH = 50;

const stack = sandboxRef<readonly DeleteBatch[]>(() => []);

export const deleteUndoable = computed(() => stack.value.length > 0);

export const rememberDelete = (batch: DeleteBatch): void => {
    if (batch.entries.length > 0) {
        stack.value = [...stack.value, batch].slice(-DEPTH);
    }
};

// Takes the batch off the stack, or the newest with none named; undefined when it was taken already (an Undo button
// pressed after Mod+Z took the same delete back), so a batch is never restored twice.
// Compared raw: the stack hands out reactive proxies, a receipt holds the batch as it was made.
export const takeDelete = (batch?: DeleteBatch): DeleteBatch | undefined => {
    const wanted = batch ?? stack.value.at(-1);
    const taken = wanted === undefined ? undefined : toRaw(wanted);
    if (taken === undefined || !stack.value.some((held) => toRaw(held) === taken)) {
        return undefined;
    }
    stack.value = stack.value.filter((held) => toRaw(held) !== taken);
    return taken;
};
