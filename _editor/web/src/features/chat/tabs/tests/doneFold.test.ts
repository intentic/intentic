// The Finished lane's fold: a done-with chat goes under "N done", and nothing else does (doneFold.ts).
import { unstubbed } from "@intentic/testing";
import type { WorkflowRun } from "@intentic/sandbox-contract/schemas/workflows";
import { ref } from "vue";
import type { Conversation } from "../../../../models/conversations/session/conversation";
import type { FleetAgent } from "../../../../models/fleet/useAgents-fleet";
import type { OpenChat } from "../cardView";
import { chatDoneWith, foldFinished, runDoneWith } from "../doneFold";

// What the rule reads: the agent's verdict is the predicate below, so a card is "done" by its id alone.
const DONE = new Set([`read`, `read-2`, `step-a`, `step-b`]);
const done = (agent: FleetAgent): boolean => DONE.has(agent.id);

const entry = (id: string, facts: { readonly unsent?: boolean; readonly listed?: boolean } = {}): OpenChat => ({
    conversation: unstubbed<Conversation>(`conversation`, { conversationId: id, unsent: ref(facts.unsent ?? false) }),
    agent: facts.listed === false ? undefined : unstubbed<FleetAgent>(`agent`, { id }),
});
const nowhere = (): boolean => false;

describe(`chatDoneWith`, () => {
    test(`folds a chat the roster is done with`, () => {
        expect(chatDoneWith(entry(`read`), nowhere, done)).toBe(true);
    });

    test(`keeps one that still owes something (unread, unlanded, a draft): the roster's verdict`, () => {
        expect(chatDoneWith(entry(`updated`), nowhere, done)).toBe(false);
    });

    test(`keeps the chat on screen, so it never folds from under the reader`, () => {
        expect(chatDoneWith(entry(`read`), (id) => id === `read`, done)).toBe(false);
    });

    test(`keeps one with words typed here that the roster has not heard of yet`, () => {
        expect(chatDoneWith(entry(`read`, { unsent: true }), nowhere, done)).toBe(false);
    });

    test(`keeps one the roster has no entry for: no account of whether it is over`, () => {
        expect(chatDoneWith(entry(`read`, { listed: false }), nowhere, done)).toBe(false);
    });
});

describe(`foldFinished`, () => {
    const lane = [`read`, `updated`, `read-2`, `ready`];
    const isDone = (id: string): boolean => DONE.has(id);

    test(`splits the lane, each side keeping its order`, () => {
        expect(foldFinished(lane, isDone, (id) => id, undefined)).toEqual({ shown: [`updated`, `ready`], folded: [`read`, `read-2`] });
    });

    test(`keeps each chat on the side it was drawn on while the pointer is over the list`, () => {
        const held = { shown: [`read`, `updated`], folded: [`ready`] };
        expect(foldFinished(lane, isDone, (id) => id, held)).toEqual({ shown: [`read`, `updated`], folded: [`read-2`, `ready`] });
    });
});

describe(`runDoneWith`, () => {
    const run = unstubbed<WorkflowRun>(`run`, { runId: `r1` });
    const step = (id: string, runId = `r1`): FleetAgent =>
        // SAFETY: runDoneWith reads only the step's runId; the rest of the workflow facts are never touched.
        unstubbed<FleetAgent>(`step`, { id, workflow: { runId } as FleetAgent["workflow"] });

    test(`folds a run whose every step is done with`, () => {
        expect(runDoneWith(run, [step(`step-a`), step(`step-b`)], false, done)).toBe(true);
    });

    test(`keeps a run with a step that still owes something`, () => {
        expect(runDoneWith(run, [step(`step-a`), step(`unlanded`)], false, done)).toBe(false);
    });

    test(`keeps the run whose diagram is on screen`, () => {
        expect(runDoneWith(run, [step(`step-a`)], true, done)).toBe(false);
    });

    test(`reads only its own steps`, () => {
        expect(runDoneWith(run, [step(`step-a`), step(`unlanded`, `r2`)], false, done)).toBe(true);
    });
});
