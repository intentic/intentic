import type { AgentEvent } from "@intentic/sandbox-contract/events/agent-events";
import type { DomainEventMap } from "../../../seams/domain-events.js";
import { resultContract } from "../child-result.js";
import type { ChildRecord, ChildSpawnSpec } from "../children.js";

/* A CHILD'S BRIEF IS ITS TURN 0 FOR GOOD. A spawn's prompt is the only place its task is written down, and a child reads
   it only as its first turn's opening words. A first turn that never reached a model (refused for memory, a runner that
   could not prepare, a provider refusing it at once) left the task unread, and whatever came next opened on its own: in
   the shinobi-society audit (2026-11-17) sub-pillow-27hp was refused for memory, its parent sent "There is room on the
   machine now: please carry out the task you were given when you were spawned", and the child answered "I don't have
   the original brief"; parents rebuilt their own prompts from running.jsonl with jq, and 20 of 49 messages to children
   were restarts rather than work. Until a model has answered a turn that carried it, or such a turn finished (`briefRead`,
   kept on the child's file across a restart), every turn the sandbox starts on the child carries it first: a follow-up,
   a move to another provider or a fallback, and the re-run of any of them, which sends its held turn's words again. A
   child a restart caught before any model read its brief starts again on it by itself (child-restore.ts). */

// What a child is told between its brief and the message that follows it, so it reads the two for what they are.
const SINCE = "(That is the task you were spawned with: no earlier turn of yours got to read it. What you are told since follows.)";

/** The child's brief: the very words its first turn opens with, the result contract its parent asked for included. */
export const briefOf = (spec: Pick<ChildSpawnSpec, "prompt" | "result">): string =>
    spec.result === undefined ? spec.prompt : `${spec.prompt}\n\n${resultContract(spec.result.schema)}`;

/** What a turn opens with: the message alone once a model read the brief, else the brief whole and the message after it. */
export const withBrief = (kid: { readonly spec: Pick<ChildSpawnSpec, "prompt" | "result">; readonly briefRead?: boolean | undefined }, message: string): string =>
    kid.briefRead === true ? message : `${briefOf(kid.spec)}\n\n${SINCE}\n\n${message}`;

/** Whether a turn the sandbox started on the child by itself (a re-run of a held turn) opens with its brief. */
export const opensWithBrief = (kid: Pick<ChildRecord, "spec">, started: Pick<DomainEventMap["run.started"], "prompt">): boolean =>
    started.prompt.includes(kid.spec.prompt);

// The frames that are the model's own answer: its words, its thinking, a tool it called. A sub-delegation's are not.
const ANSWERS: ReadonlySet<AgentEvent["kind"]> = new Set(["delta", "thinking", "tool_call"]);

/**
 * Notes the brief as read on the first answer of a turn that carried it; answers whether that changed the record, for
 * the caller to write it down.
 */
export const takeBriefRead = (kid: ChildRecord | undefined, carried: boolean, event: AgentEvent): boolean => {
    if (kid === undefined || kid.briefRead === true || !carried || !ANSWERS.has(event.kind) || ("parentToolUseId" in event && event.parentToolUseId !== undefined)) {
        return false;
    }
    kid.briefRead = true;
    return true;
};
