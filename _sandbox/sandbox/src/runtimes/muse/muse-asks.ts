import type { AgentEvent, AgentReply, AskQuestion, PermissionMode, ProgramAsk } from "@intentic/sandbox-contract";
import { errorMessage } from "@intentic/base/errors";
import type { TurnHooks } from "../../agent/providers/agent-request.js";
import type { ParkedCards } from "../../conversations/actor/parked-cards.js";
import { type CommandGuard, consultWith, type GuardOutcome, vendorSubject } from "../../guard/command-guard.js";
import { opt } from "../../opt.js";
import { CONSULT_FAILED } from "../decorators/vendor-ask.js";
import type { MuseHost } from "./muse-host.js";
import {
    AcceptedSchema,
    type MuseApprovalChoice,
    type MuseApprovalRequest,
    type MuseQuestion,
    type MuseUserInputRequest,
    toolArgsOf,
} from "./muse-wire.js";

// How a Muse turn answers what its host asks while it runs: an approval for a call Muse would not run on its own, and a
// question for the person. Every session runs under approval mode `promptUnmatched`, so Muse raises an approval for every
// shell command off its own allow rules, and the owner's rulebook answers each one first:
// - ask: `default` mode. A command the gate lets through is put to the person on the same per-tool card the Claude loop
//   raises, unless the gate's own card already put it to them.
// - auto: every other mode. The gate's verdict is the answer.
// - plan: a planning phase, read-only: every approval is refused with a sentence telling the model to plan instead.
// Answers only ever pick a once-scoped choice, never a standing rule Muse would remember: a rule saved in Muse's own store
// would stop it asking, and the owner's rulebook would never see that command again.

export type MusePosture = "ask" | "auto" | "plan";

export const musePosture = (mode: PermissionMode | undefined, planning: boolean): MusePosture => {
    if (planning) {
        return "plan";
    }
    return mode === "default" ? "ask" : "auto";
};

export interface MuseAsks {
    readonly host: Pick<MuseHost, "command">;
    readonly sessionId: string;
    readonly posture: MusePosture;
    readonly gate: CommandGuard;
    readonly cards: Pick<ParkedCards, "create">;
    readonly conversationId?: string | undefined;
    readonly signal: AbortSignal;
    readonly restoredGrant?: TurnHooks["restoredGrant"];
    // Tools the person said not to ask about again, for the whole run: a planning phase's answer still holds after it.
    readonly always: Set<string>;
    // Where the cards' frames go: the loop's own queue, so they reach the stream while the loop keeps reading.
    readonly push: (event: AgentEvent) => void;
    // The loop's watchdog hold: a card open on a person is not a silent turn.
    readonly hold: () => () => void;
    // Each approval's verdict, so a later stage of the same compound command is answered the same way.
    readonly verdicts: Map<string, Verdict>;
}

type Verdict = { readonly allow: true } | { readonly allow: false; readonly reason: string };

export const PLANNING_REFUSAL =
    "This turn is planning, and planning is read-only: nothing that changes the workspace runs now. " +
    "Read what you need, then put the change into the plan instead of making it.";

const SHOWN_PROGRAM = 2_000;

const programOf = (command: string): ProgramAsk => ({
    text: command.slice(0, SHOWN_PROGRAM),
    language: "bash",
    truncated: command.length > SHOWN_PROGRAM,
    spans: [],
});

// The once-scoped choice that matches the verdict: an allow is the approval Muse names `approved` once; a refusal is its
// `denied` where offered, else the abort that rejects just this call (the turn carries on, told why).
const choiceFor = (choices: readonly MuseApprovalChoice[], verdict: Verdict): MuseApprovalChoice | undefined =>
    verdict.allow
        ? choices.find((choice) => choice.decision === "approved" && choice.scope === "once")
        : (choices.find((choice) => choice.decision === "denied") ?? choices.find((choice) => choice.decision === "abort"));

const decide = async (
    asks: MuseAsks,
    approval: { readonly approvalId: string; readonly availableChoices: readonly MuseApprovalChoice[]; readonly currentRequirementId: { readonly approvalId: string; readonly sourceIndex: number } },
    verdict: Verdict,
): Promise<void> => {
    const choice = choiceFor(approval.availableChoices, verdict);
    if (choice === undefined) {
        // Nothing offered says what the verdict means: leave it unanswered rather than pick a rule Muse would keep.
        return;
    }
    await asks.host.command(
        "approval/decide",
        {
            sessionId: asks.sessionId,
            approvalId: approval.approvalId,
            choiceId: choice.choiceId,
            requirementId: { ...approval.currentRequirementId },
            ...opt("feedback", !verdict.allow && choice.acceptsFeedback === true ? verdict.reason : undefined),
        },
        AcceptedSchema,
    );
};

// The owner's rulebook on the command, noting whether reaching a verdict already put a card in front of a person.
const consultGate = async (asks: MuseAsks, command: string, cwd: string | undefined): Promise<{ outcome: GuardOutcome; asked: boolean }> => {
    if (!asks.gate.enforcing) {
        return { outcome: { allow: true }, asked: false };
    }
    let asked = false;
    const release = asks.hold();
    try {
        const outcome = await consultWith(
            asks.gate,
            command,
            vendorSubject("Bash"),
            (event) => {
                asked ||= event.kind === "permission";
                asks.push(event);
            },
            { cwd },
        );
        return { outcome, asked };
    } catch {
        // allow(silent-catch): a consult that threw has no verdict to stand on; the refusal names the failure.
        return { outcome: { allow: false, reason: CONSULT_FAILED }, asked };
    } finally {
        release();
    }
};

interface OwnerAsk {
    readonly toolName: string;
    readonly displayName: string;
    readonly title: string;
    readonly path?: string | undefined;
    readonly program?: ProgramAsk | undefined;
}

// The per-tool card, as the Claude loop's askOwner raises it: parked until somebody presses a button, the resolved frame
// going out before the answer so a replayed transcript freezes the card.
const askOwner = async (asks: MuseAsks, ask: OwnerAsk): Promise<boolean> => {
    if (asks.always.has(ask.toolName)) {
        return true;
    }
    const restored = asks.restoredGrant?.(ask.toolName);
    if (restored !== undefined) {
        if (restored.always) {
            asks.always.add(ask.toolName);
        }
        return true;
    }
    const { id, wait } = asks.cards.create(
        "permission",
        { kind: "permission", requestId: "", decision: "deny", feedback: "The turn was cancelled before you answered." },
        asks.conversationId,
    );
    asks.push({
        kind: "permission",
        requestId: id,
        toolName: ask.toolName,
        title: ask.title,
        displayName: ask.displayName,
        ...opt("path", ask.path),
        ...opt("program", ask.program),
        alwaysLabel: `Don't ask again for ${ask.displayName}`,
    });
    const release = asks.hold();
    try {
        const { reply, resolved } = await wait(asks.signal);
        asks.push(resolved);
        if (reply.kind !== "permission" || reply.decision === "deny") {
            return false;
        }
        if (reply.decision === "always" || reply.decision === "everything") {
            asks.always.add(ask.toolName);
        }
        return true;
    } finally {
        release();
    }
};

const PERSON_REFUSED = "The user declined this call. Do not retry it: carry on without it, or ask what they would rather you did.";

// What the person is asked about a call Muse raised that is not a shell command (a write outside the workspace, a new
// network target): named by Muse's own subject.
const ownerAskOf = (request: MuseApprovalRequest): OwnerAsk => {
    if (request.subject.command !== undefined) {
        return { toolName: "Bash", displayName: "Run command", title: "Run this command?", program: programOf(request.subject.command) };
    }
    const what = request.subject.path ?? request.subject.host ?? request.subject.target;
    return {
        toolName: request.toolName,
        displayName: request.toolName,
        title: what === undefined ? `Let Muse Code use ${request.toolName}?` : `Let Muse Code use ${request.toolName} on ${what}?`,
        ...opt("path", request.subject.path),
    };
};

const verdictOf = async (asks: MuseAsks, request: MuseApprovalRequest): Promise<Verdict> => {
    if (asks.posture === "plan") {
        return { allow: false, reason: PLANNING_REFUSAL };
    }
    const command = request.subject.command;
    const judged = command === undefined ? { outcome: { allow: true } as const, asked: false } : await consultGate(asks, command, toolArgsOf(request.rawArgs).workdir ?? request.subject.workspaceRoot);
    if (!judged.outcome.allow) {
        return { allow: false, reason: judged.outcome.reason };
    }
    if (asks.posture !== "ask" || judged.asked) {
        return { allow: true };
    }
    return (await askOwner(asks, ownerAskOf(request))) ? { allow: true } : { allow: false, reason: PERSON_REFUSED };
};

/** Answers one approval Muse raised; a failure to answer is said in the stream and leaves Muse's own default-deny. */
export const answerApproval = async (asks: MuseAsks, request: MuseApprovalRequest): Promise<void> => {
    try {
        const verdict = await verdictOf(asks, request);
        asks.verdicts.set(request.approvalId, verdict);
        await decide(asks, request, verdict);
    } catch (error) {
        asks.push({ kind: "error", message: `Muse Code's approval for ${request.toolName} could not be answered: ${errorMessage(error)}` });
    }
};

/** A later stage of an approval already judged (a compound command's next program), answered as the first one was. */
export const answerApprovalStage = async (
    asks: MuseAsks,
    update: { readonly approvalId: string; readonly availableChoices: readonly MuseApprovalChoice[]; readonly currentRequirementId: { readonly approvalId: string; readonly sourceIndex: number } },
): Promise<void> => {
    const verdict = asks.verdicts.get(update.approvalId);
    if (verdict === undefined) {
        return;
    }
    try {
        await decide(asks, update, verdict);
    } catch (error) {
        // A stage already decided answers `approvalAlreadyResolved` or a stale requirement: nothing is waiting on it.
        asks.push({ kind: "error", code: "codex-advisory", message: `Muse Code's approval stage could not be answered: ${errorMessage(error)}` });
    }
};

const askQuestion = (question: MuseQuestion): AskQuestion => ({
    question: question.question,
    header: question.header,
    multiSelect: question.selection.mode === "multiple",
    options: question.options.map((option) => ({ label: option.label, description: option.description ?? "" })),
});

// Free text Muse accepts per answer.
const FREE_TEXT_CHARS = 500;

// One answer in the shape Muse validates: a picked label where the person picked one Muse offered, else their words.
const answerOf = (question: MuseQuestion, picked: readonly string[]) => {
    const labels = new Set(question.options.map((option) => option.label));
    const offered = picked.filter((label) => labels.has(label));
    if (question.selection.mode === "single" && offered.length === 1 && picked.length === 1) {
        return { questionId: question.id, selectedLabel: offered[0] ?? "" };
    }
    if (question.selection.mode === "multiple" && offered.length === picked.length && offered.length > 0) {
        return { questionId: question.id, selectedLabels: offered };
    }
    return { questionId: question.id, freeText: picked.join("; ").slice(0, FREE_TEXT_CHARS) };
};

const QUESTIONS_DISMISSED = "The user dismissed the questions without answering.";

/** The question card the `ask` tool raises, answered back to Muse; a dismissal declines the prompt. */
export const answerQuestions = async (asks: Omit<MuseAsks, "posture" | "gate" | "verdicts" | "always" | "restoredGrant">, request: MuseUserInputRequest): Promise<void> => {
    const { id, wait } = asks.cards.create("question", { kind: "question", requestId: "", cancelled: true }, asks.conversationId);
    asks.push({ kind: "question", requestId: id, questions: request.questions.map(askQuestion) });
    const release = asks.hold();
    let reply: AgentReply;
    try {
        const answered = await wait(asks.signal);
        asks.push(answered.resolved);
        reply = answered.reply;
    } finally {
        release();
    }
    try {
        const answers = reply.kind === "question" && reply.cancelled !== true ? reply.answers : undefined;
        if (answers === undefined) {
            await asks.host.command("userInput/cancel", { sessionId: asks.sessionId, userInputId: request.userInputId, reason: QUESTIONS_DISMISSED }, AcceptedSchema);
            return;
        }
        await asks.host.command(
            "userInput/answer",
            { sessionId: asks.sessionId, userInputId: request.userInputId, answers: request.questions.map((question) => answerOf(question, answers[question.question] ?? [])) },
            AcceptedSchema,
        );
    } catch (error) {
        asks.push({ kind: "error", message: `Muse Code's question could not be answered: ${errorMessage(error)}` });
    }
};
