import type { WorkflowRun, WorkflowStepRun } from "@intentic/sandbox-contract";
import { describe, expect, it } from "vitest";
import { runConversations } from "./workflow-state.js";

// Which of a run's step records name a chat that actually exists: the question archiving a run is built on,
// and the one the diagram got wrong for a long time (see the note on `ran` in the browser's chatRun.ts).

const step = (stepId: string, state: WorkflowStepRun["state"], conversationId: string): WorkflowStepRun =>
    ({ stepId, state, conversationId }) as WorkflowStepRun;

const runOf = (...steps: WorkflowStepRun[]): WorkflowRun => ({ steps }) as WorkflowRun;

describe("runConversations", () => {
    it("names every step that took a turn, however it ended", () => {
        expect(runConversations(runOf(step(`a`, `done`, `c1`), step(`b`, `failed`, `c2`), step(`c`, `stopped`, `c3`)))).toEqual([`c1`, `c2`, `c3`]);
    });

    /* The ids that are STRINGS AND NOTHING ELSE. A step's conversation id is derived (wf-<run>-<step>) and
     * written into the record before the run begins, so a step that never started has one for a chat that was
     * never created. Handing those to the registry would be asking it to archive agents that do not exist. */
    it("leaves out the steps that never ran", () => {
        expect(runConversations(runOf(step(`a`, `done`, `c1`), step(`b`, `pending`, `c2`), step(`c`, `skipped`, `c3`)))).toEqual([`c1`]);
    });

    // A `continue` step runs on its predecessor's conversation, so a four-step run can own two chats, and the
    // caller must not be handed the same id twice.
    it("counts a chained pair's shared conversation once", () => {
        expect(runConversations(runOf(step(`a`, `done`, `c1`), step(`b`, `done`, `c1`)))).toEqual([`c1`]);
    });
});
