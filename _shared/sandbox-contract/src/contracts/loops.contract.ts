import { oc } from "@orpc/contract";
import {
    LoopDesignIdParamSchema,
    LoopDesignSaveSchema,
    LoopDesignSchema,
    LoopDesignsListSchema,
    LoopIdParamSchema,
    LoopRecordSchema,
    LoopSchema,
    LoopsListSchema,
} from "../schemas/loops.js";
import { OkSchema } from "../schemas/shared.js";

// Two halves: a running loop (start/stop/list, no editor, the conversation is its id) and a saved loop
// (list/save/remove, the loop's machinery without a goal). A saved loop has no `run` of its own; running one is `start`
// with the design's fields. `start` acks at once and runs detached; the record comes back, not the outcome.
export const loopsContract = {
    // Kept after the loop ends: the iteration history is the answer to why it stopped when it did.
    list: oc
        .route({
            method: "GET",
            path: "/loops",
            summary: "Every loop that has run",
            description:
                "The loops this workspace has run, newest first, kept after they end. Why it stopped on the fourth round is the question a loop gets read for, and the round-by-round history is the answer.",
        })
        .output(LoopsListSchema),
    // Rejects an already-looping conversation; a fresh conversation id opens it, like a first turn.
    start: oc
        .route({
            method: "POST",
            path: "/loops",
            summary: "Run a conversation until it is done",
            description:
                "Starts repeating a conversation towards a goal and answers straight away with the loop as recorded; the work carries on without you. The conversation need not exist yet, so run this until it passes can be the first thing you ever say to a new agent. A conversation already looping is refused.",
        })
        .input(LoopSchema)
        .output(LoopRecordSchema),
    // Stops future rounds only; the round in flight keeps going. Use /agent/stop to kill it too.
    stop: oc
        .route({
            method: "POST",
            path: "/loops/{conversationId}/stop",
            summary: "Make this round the last",
            description:
                "Means do not start another round, not stop what is running. Somebody watching the sixth round do good work can say this is the last one without throwing that work away. To cut the current round off as well, stop the conversation too.",
        })
        .input(LoopIdParamSchema)
        .output(OkSchema),

    // A saved loop is the same loop with its goal left blank, not a separate feature.
    designs: oc
        .route({
            method: "GET",
            path: "/loops/designs",
            summary: "Saved loop designs",
            description:
                "Loops somebody authored once and can point at a different job each time. A saved loop is the same loop with its goal left blank until you type one, not a different feature.",
        })
        .output(LoopDesignsListSchema),
    // Names create vs replace explicitly, rather than upserting; refuses a design with nothing to produce or check.
    saveDesign: oc
        .route({
            method: "POST",
            path: "/loops/designs",
            summary: "Create or replace a saved loop",
            description:
                "Say which of the two you mean, so a name that happens to collide cannot silently overwrite somebody's work. A design that could never finish, with nothing to produce and nothing to check, is refused in the same words an ad-hoc loop would be: catching that at save time is the whole advantage of saving.",
        })
        .input(LoopDesignSaveSchema)
        .output(LoopDesignSchema),
    // Deleting a design does not stop a loop running from it; it already copied the fields it needed.
    removeDesign: oc
        .route({
            method: "DELETE",
            path: "/loops/designs/{id}",
            summary: "Delete a saved loop",
            description:
                "Removes the design. A loop already running from it keeps going on its own terms, because it took a copy of what it needed when it started.",
        })
        .input(LoopDesignIdParamSchema)
        .output(OkSchema),
};
