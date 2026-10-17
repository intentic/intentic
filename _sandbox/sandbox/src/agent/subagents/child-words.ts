import type { AskQuestion, ChildMove } from "@intentic/sandbox-contract/events/requests";
import type { ResumeReason } from "@intentic/sandbox-contract/events/resume";
import type { DomainEventMap } from "../../seams/domain-events.js";
import { taskLine } from "./child-spec.js";
import type { ChildActionResult, ChildSpawnSpec } from "./children.js";

// Every sentence a parent is told about its children, in one place: why a start or a message did not go, what a card
// asks, where a moved or stopped child went. children.ts decides; these say it.

// How long one wait behind another turn may last; past it the parent is told its words were not delivered.
export const BEHIND_MAX_MS = 2 * 60 * 60_000;

// Why a child's turn never started, as the ending its parent reads.
export const NOT_STARTED = {
    stuck: `The turn already running on it did not end within ${BEHIND_MAX_MS / 3_600_000} hours, so your message was not delivered: send it again once it is free.`,
    busy: "Other turns kept its conversation busy, so your message was not delivered: send it again once it is free.",
    archived: "That child is archived: only a person's message reopens it.",
    cancelled: "Cancelled by its parent before it started.",
} as const satisfies Record<string, string>;

// What a cancelled child's ending says, whatever its turn was doing when the cancel came.
export const CANCELLED = "Stopped: its parent cancelled it.";

// What a parent is told of the question its child parked on: the questions whole, options and all, and the door that
// answers them, since the parent may have no wait open to read them from.
export const questionWords = (childId: string, spec: ChildSpawnSpec, questions: readonly AskQuestion[]): string =>
    [
        `Your subagent \`${childId}\` ("${taskLine(spec)}") stopped on a question and is waiting for your answer; until you give one it does nothing and keeps its seat.`,
        ...questions.map((asked) => {
            const options = asked.options.map((option) => option.label);
            return `- ${asked.question}${options.length === 0 ? "" : ` (options: ${options.join(", ")}${asked.multiSelect ? "; pick any number" : ""})`}`;
        }),
        `Answer with answer(child: "${childId}", answers: [{ question, picks }]), one entry per question in its own words. If it is not yours to decide, say so to the owner rather than guessing.`,
    ].join("\n");

// A paused child's re-run is no longer coming: the sandbox gave it up or dropped it, or a person ran the turn themselves.
export const noRerun = (ranElsewhere: boolean): string =>
    ranElsewhere
        ? "Its turn was run again from its own chat rather than for you: read its chat for how that went, or send it again."
        : "The sandbox did not run it again after all (the re-run was given up or dropped), so it is not coming back by itself: send it again, or give the task to another agent.";

// What a child moved by its fallbacks is told as its turn there opens: why it moved, and to carry on.
export const carryOnWords = (from: ChildSpawnSpec, to: ChildSpawnSpec, failure: string): string =>
    `Your last turn on ${from.provider}/${from.model} was refused ("${failure.replaceAll(/\s+/gu, " ").trim().slice(0, 300)}"), so you now run on ` +
    `${to.provider}/${to.model}, in the same worktree with your work so far. Carry on with your task from where you stopped, and end with your report as before.`;

// Why the sandbox sent a child's turn again by itself, in its parent's words.
const RERUN_WHY = {
    auth: "its Claude sign-in was renewed",
    outage: "its model provider came back",
    restart: "the sandbox restarted in the middle of its turn",
    stopped: "its last turn stopped short",
    limit: "its allowance reopened",
    switched: "its allowance ran out and it moved to another account",
    carried: "its allowance ran out and it moved to another account",
    trimmed: "its allowance ran out and it went on in a trimmed copy of its session",
    summarized: "its allowance ran out and it went on in a fresh session opened with a summary",
    refused: "its allowance refused the last attempt before anything ran",
    door: "its last attempt was turned away before anything ran",
    overflow: "its session outgrew the model's window",
    flagged: "its model's safety classifier stopped the last attempt and a person chose to go on",
    continued: "a person chose to carry on after its last turn stopped",
    answered: "the sandbox restarted while it waited on an answer",
} as const satisfies Record<ResumeReason, string>;

// What started a turn on a child without its parent, in words for the parent.
export const startedWhy = (started: DomainEventMap["run.started"]): string => {
    if (started.resume !== undefined) {
        return `the sandbox sent its turn again by itself because ${RERUN_WHY[started.resume]}`;
    }
    const speaker = started.speaker;
    if (speaker?.kind === "agent") {
        return `another conversation, \`${speaker.conversationId}\`, sent it a message`;
    }
    return speaker?.kind === "sandbox" && speaker.source !== undefined
        ? `the sandbox started a turn on it (${speaker.source})`
        : "the sandbox started a turn on it";
};

// Which supervisor move is held, so the card names the action truthfully rather than a generic one. The owner reads a
// spawned child as the editor names every agent another one started, whichever mechanism started it.
export const MOVE_TITLE = {
    spawn: "Start a subagent",
    send: "Send this to a subagent",
    answer: "Answer a subagent",
} as const satisfies Readonly<Record<ChildMove, string>>;
export const MOVE_BUTTON = { spawn: "Start it", send: "Send it", answer: "Answer it" } as const satisfies Readonly<Record<ChildMove, string>>;

// The card's second allow: this move, and every held one on the same provider for the rest of the parent's turn.
export const ALWAYS_LABEL = "Allow for the rest of this turn";

// What the card quotes of the parent's words to a child: enough to judge it by, not a second transcript.
const MESSAGE_SHOWN = 600;

// The parent's words as the card quotes them: cut at MESSAGE_SHOWN, back to the last word that fits whole where one ends
// near the cut, and marked, so a quote never stops mid-word as though that were all it said.
export const quoted = (words: string): string => {
    const trimmed = words.trim();
    if (trimmed.length <= MESSAGE_SHOWN) {
        return trimmed;
    }
    const cut = trimmed.slice(0, MESSAGE_SHOWN);
    const lastSpace = cut.search(/\s\S*$/u);
    return `${(lastSpace > MESSAGE_SHOWN - 40 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
};

// Why a hold refuses with nowhere to ask: a detached `agents` shell, or a turn that already ended.
export const nowhereToAsk = (reason: string): string =>
    `Held for the owner: ${reason}. This call arrived outside a live turn, so there was nowhere to ask them. Ask in chat; they can also set the agents.spawn action rule.`;

// What a move that went unanswered tells its parent: why the owner was asked, and that it may ask again, which raises a
// new card; nothing about it was declined. A card lives exactly as long as the parent's turn: no clock ends it
// (docs/architecture/conventions.md, "A person's answers"). 2026-10-12: it also ended after six hours; dropped, since
// the turn that holds it is the one bound that means anything to the owner.
export const unansweredWords = (move: ChildMove, reason: string): string =>
    `Nobody answered the owner's card to ${move === "spawn" ? "start" : move} this subagent before your turn ended, so it did not run. It was held because ${reason}. Nothing was declined: you may ask again, which raises a new card, and waiting on it keeps your turn (and so the card) open. If the work cannot wait for the owner, say what you left undone.`;

// What a parent is told of a move held for the owner: why it was held, and how long the card waits. Nothing holds its
// call open while they decide: it carries on, and hears what becomes of the move.
const heldFor = (reason: string): string =>
    `Held for the owner's approval, because ${reason}. A card in your chat asks them, and you carry on meanwhile. The card lasts while your turn does: if nobody answers by then the move does not happen, nothing is declined, and you may ask again.`;
export const heldStart = (reason: string): string =>
    `${heldFor(reason)} It starts once they allow it; wait on it like any child, which also keeps your turn, and the card, open. If they decline, or your turn ends first, it ends as failed without having run.`;
export const heldMessage = (reason: string): string => `${heldFor(reason)} It goes to the child once they allow it, and you are told if it does not.`;
export const heldAnswer = (reason: string): string => `${heldFor(reason)} Your answer goes once they allow it, and you are told if it does not.`;
// What a held start's roster row says while the owner decides.
export const START_SUMMARY = "Waiting for the owner to allow its start, on the card in your chat.";

export const laneHeldNote = (id: string, reason: string): string =>
    `Held before it starts: ${reason}. It starts by itself, or comes back unstarted (having spent nothing) if the records call its model spent by then; supervise it with wait(target: "${id}").`;

export const movedWords = (from: ChildSpawnSpec, to: ChildSpawnSpec): string =>
    `Moved from ${from.provider}/${from.model} to ${to.provider}/${to.model}: its next turn runs there in the same worktree, in a fresh session seeded from its own record.`;

// What a cancel found to stop, as its parent reads it.
export const CANCEL_NOTES = {
    running:
        "Cancelled: its turn is being stopped, and it ends as killed. Whatever it already wrote stays in its worktree: send it a message to carry on (naming a provider and model moves it there), or merge it to bring that work into your checkout.",
    waiting: "Cancelled: it will not start. Send it a message if you want it after all.",
    paused: "Cancelled: the sandbox will not run it again by itself, and it ends as killed. Send it a message to carry on from where it stopped.",
} as const satisfies Record<string, string>;

// A linked task runs on the other sandbox's own providers, which this one does not choose.
export const LINKED_REHOME: ChildActionResult = {
    ok: false,
    message: "That task runs in another sandbox, on that sandbox's providers: it cannot be moved from here. Send it without a provider and model.",
};

// A merge has nothing to bring in from a linked task: its work never comes into this checkout.
export const LINKED_MERGE: ChildActionResult = {
    ok: false,
    message: "That task ran in another sandbox and lands there: there is nothing of it to merge into this checkout.",
};
