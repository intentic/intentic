import { oc } from "@orpc/contract";
import { LoopIdParamSchema, LoopRecordSchema, LoopSchema, LoopsListSchema, OkSchema } from "../schemas.js";

/* The loop routes — "run this conversation again until the goal is met".
 *
 * Deliberately three routes and no editor. A loop is not a manifest the user maintains the way automations are:
 * it is started against a conversation, it converges or it gives up, and then it is history. So there is a
 * `start`, a `stop`, and a `list` for what has run — no upsert, no enabled toggle, and no id of its own (the
 * conversation IS the id).
 *
 * `start` acks immediately with the loop as recorded and runs detached, the same contract POST /agent keeps: the
 * first iteration alone can take minutes, and every surface that would render progress is already attached to
 * the conversation. What comes back is the record, not an outcome — the outcome arrives on the fleet card.
 */
export const loopsContract = {
    // Every loop this workspace has run, newest first — the record is kept after the loop ends, because "why did
    // it stop at iteration 4" is the question a loop is read for, and the answer is its iteration history.
    list: oc.route({ method: "GET", path: "/loops" }).output(LoopsListSchema),
    /* Start looping a conversation. Rejects when that conversation is already looping — a second loop on one
     * agent would have two pumps racing the same worktree and the same turn mutex, and the loser would spend a
     * turn to discover it.
     *
     * The conversation need not exist yet: a loop against a fresh id opens it, exactly as a first chat turn
     * does, which is what lets "run this until it's green" be the FIRST thing said to a new agent. */
    start: oc.route({ method: "POST", path: "/loops" }).input(LoopSchema).output(LoopRecordSchema),
    /* Stop the loop, leaving the turn in flight alone.
     *
     * The split is deliberate and it is the one thing about this route that has to be right: stopping a LOOP
     * means "do not start another iteration", not "kill what is running". A user watching iteration 6 do good
     * work should be able to say "this is the last one" without throwing that work away. Killing the turn is
     * what /agent/stop is for, and pressing both is the ordinary way to abandon a loop outright. */
    stop: oc.route({ method: "POST", path: "/loops/{conversationId}/stop" }).input(LoopIdParamSchema).output(OkSchema),
};
