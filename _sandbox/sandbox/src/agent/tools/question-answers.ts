import { isAbsolute, join } from "node:path";
import type { AgentReply, AskQuestion } from "@intentic/sandbox-contract";

// formatAnswers renders the ask tool's result (picks or dismissal) as the text returned to the model, read the same way
// regardless of which of the three callers produced it. parseAnswers is the inverse, for a session rebuilt from stored
// text; it reads only the shapes the formatter writes, so the two must change together.

type QuestionReply = Extract<AgentReply, { kind: "question" }>;

// Model-facing and SDK-registered names for the same tool; a stored session may carry either spelling.
export const ASK_TOOL_NAMES: ReadonlySet<string> = new Set(["mcp__ui__ask", "AskUserQuestion"]);

const ANSWERED = "The user answered:";
const DISMISSED =
    "The user dismissed the questions without answering and stopped the turn. STOP what you are doing and wait for them to say how to proceed.";
const NO_ANSWER = "(no answer)";
const PICK_SEPARATOR = ", ";

// Files that went with an answer: one indented line each under its question, so the reading below can tell them
// from the answer lines, which start at the margin.
const ATTACHED = "  - attached file (read it): ";
// The tail of the answer text when anything is attached, so the model opens the files rather than skipping the paths.
const ATTACHED_NOTE = "The user attached files to their answer; read them with the Read tool before acting on it.";

const labelOf = (question: AskQuestion): string => question.header || question.question;

// Paths ride the reply workspace-relative (as the composer uploads them); the model is handed them absolute, against
// the root it works in, or as they are when no root is given.
const placed = (root: string | undefined, path: string): string => (root === undefined || isAbsolute(path) ? path : join(root, path));

// Every attached file of a reply, absolute against `root`, in question order: what a caller hands a model natively.
export const answerFiles = (questions: readonly AskQuestion[], reply: QuestionReply, root?: string): string[] =>
    reply.cancelled || reply.answers === undefined
        ? []
        : questions.flatMap((question) => (reply.attachments?.[question.question] ?? []).map((path) => placed(root, path)));

export const formatAnswers = (questions: readonly AskQuestion[], reply: QuestionReply, root?: string): string => {
    if (reply.cancelled || reply.answers === undefined) {
        return DISMISSED;
    }
    const answers = reply.answers;
    const lines = questions.flatMap((question) => {
        const picks = answers[question.question] ?? [];
        const files = (reply.attachments?.[question.question] ?? []).map((path) => `${ATTACHED}${placed(root, path)}`);
        return [`- ${labelOf(question)}: ${picks.length > 0 ? picks.join(PICK_SEPARATOR) : NO_ANSWER}`, ...files];
    });
    const note = answerFiles(questions, reply).length > 0 ? `\n\n${ATTACHED_NOTE}` : "";
    return `${ANSWERED}\n${lines.join("\n")}${note}`;
};

// Undefined when the text isn't one the formatter wrote, so the caller leaves the card unanswered rather than inventing
// a decision. Picks split on their join separator, so a label containing ", " would misparse; bounded by the recovery
// path, not the record.
export const parseAnswers = (questions: readonly AskQuestion[], requestId: string, text: string): QuestionReply | undefined => {
    if (text === DISMISSED) {
        return { kind: "question", requestId, cancelled: true };
    }
    if (!text.startsWith(`${ANSWERED}\n`)) {
        return undefined;
    }
    // A stored result flattens the pictures that rode after the text into `[image]` marks (tool-calls resultText).
    const body = text.slice(ANSWERED.length + 1).replace(/(\[image\])+$/, "");
    const lines = (body.endsWith(`\n\n${ATTACHED_NOTE}`) ? body.slice(0, -(ATTACHED_NOTE.length + 2)) : body).split("\n");
    const answers: Record<string, string[]> = {};
    const attachments: Record<string, string[]> = {};
    for (const question of questions) {
        const prefix = `- ${labelOf(question)}: `;
        const at = lines.findIndex((candidate) => candidate.startsWith(prefix));
        if (at === -1) {
            continue;
        }
        const picks = lines[at]!.slice(prefix.length);
        answers[question.question] = picks === NO_ANSWER ? [] : picks.split(PICK_SEPARATOR);
        // The written paths, which may be absolute: a rebuilt card shows what the model was told.
        const files: string[] = [];
        for (const line of lines.slice(at + 1)) {
            if (!line.startsWith(ATTACHED)) {
                break;
            }
            files.push(line.slice(ATTACHED.length));
        }
        if (files.length > 0) {
            attachments[question.question] = files;
        }
    }
    return { kind: "question", requestId, answers, ...(Object.keys(attachments).length > 0 ? { attachments } : {}) };
};
