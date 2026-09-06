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

/* The loop routes, "run this conversation again until the goal is met".
 *
 * TWO HALVES THAT LOOK LIKE ONE FEATURE AND ARE NOT, which is why they share a file and share nothing else.
 *
 * A RUNNING LOOP has no editor. It is started against a conversation, it converges or it gives up, and then it
 * is history: `start`, `stop`, and a `list` of what has run. No upsert, no enabled toggle, no id of its own,
 * the conversation IS the id.
 *
 * A SAVED LOOP is a manifest entry like a workflow, and gets the manifest treatment: list, save, remove. It is
 * the loop's MACHINERY without its goal (LoopDesignSchema says why at length), so it is authored once and
 * pointed at a different job every time. It has no `run` route of its own on purpose, running one is `start`
 * with the design's fields and the composer's sentence, so there is exactly one way a loop begins and exactly
 * one place that can refuse it.
 *
 * `start` acks immediately with the loop as recorded and runs detached, the same contract POST /agent keeps: the
 * first iteration alone can take minutes, and every surface that would render progress is already attached to
 * the conversation. What comes back is the record, not an outcome, the outcome arrives on the fleet card.
 */
export const loopsContract = {
    // Every loop this workspace has run, newest first, the record is kept after the loop ends, because "why did
    // it stop at iteration 4" is the question a loop is read for, and the answer is its iteration history.
    list: oc
        .route({
            method: "GET",
            path: "/loops",
            summary: "Every loop that has run",
            description:
                "The loops this workspace has run, newest first, kept after they end. Why it stopped on the fourth round is the question a loop gets read for, and the round-by-round history is the answer.",
        })
        .output(LoopsListSchema),
    /* Start looping a conversation. Rejects when that conversation is already looping, a second loop on one
     * agent would have two pumps racing the same worktree and the same turn mutex, and the loser would spend a
     * turn to discover it.
     *
     * The conversation need not exist yet: a loop against a fresh id opens it, exactly as a first chat turn
     * does, which is what lets "run this until it's green" be the FIRST thing said to a new agent. */
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
    /* Stop the loop, leaving the turn in flight alone.
     *
     * The split is deliberate and it is the one thing about this route that has to be right: stopping a LOOP
     * means "do not start another iteration", not "kill what is running". A user watching iteration 6 do good
     * work should be able to say "this is the last one" without throwing that work away. Killing the turn is
     * what /agent/stop is for, and pressing both is the ordinary way to abandon a loop outright. */
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

    // Every saved loop. A literal path segment under /loops rather than a surface of its own, because a saved
    // loop is not a different feature, it is the same loop with its goal left blank until somebody types one.
    designs: oc
        .route({
            method: "GET",
            path: "/loops/designs",
            summary: "Saved loop designs",
            description:
                "Loops somebody authored once and can point at a different job each time. A saved loop is the same loop with its goal left blank until you type one, not a different feature.",
        })
        .output(LoopDesignsListSchema),
    /* Create or replace a saved loop, with the operation explicit so a name collision cannot turn a create into
     * a replacement. Refuses a design that could never finish, nothing to produce and nothing to check, with
     * the same sentence `start` refuses an ad-hoc loop for, because it is the same mistake made earlier and
     * catching it at save time is the whole advantage of saving. */
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
    // Deleting a saved loop does NOT stop a loop running from it: a running loop copied the fields it needed
    // when it started, so it converges or gives up on its own terms, and its record stays readable.
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
