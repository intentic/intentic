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

const labelOf = (question: AskQuestion): string => question.header || question.question;

export const formatAnswers = (questions: readonly AskQuestion[], reply: QuestionReply): string => {
    if (reply.cancelled || reply.answers === undefined) {
        return DISMISSED;
    }
    const answers = reply.answers;
    const lines = questions.map((question) => {
        const picks = answers[question.question] ?? [];
        return `- ${labelOf(question)}: ${picks.length > 0 ? picks.join(PICK_SEPARATOR) : NO_ANSWER}`;
    });
    return `${ANSWERED}\n${lines.join("\n")}`;
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
    const lines = text.slice(ANSWERED.length + 1).split("\n");
    const answers: Record<string, string[]> = {};
    for (const question of questions) {
        const prefix = `- ${labelOf(question)}: `;
        const line = lines.find((candidate) => candidate.startsWith(prefix));
        if (line === undefined) {
            continue;
        }
        const picks = line.slice(prefix.length);
        answers[question.question] = picks === NO_ANSWER ? [] : picks.split(PICK_SEPARATOR);
    }
    return { kind: "question", requestId, answers };
};
