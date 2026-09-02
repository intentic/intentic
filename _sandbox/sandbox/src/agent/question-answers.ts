import type { AgentReply, AskQuestion } from "@intentic/sandbox-contract";

/* THE ASK TOOL'S RESULT, in both directions.
 *
 * `formatAnswers` renders the user's picks (or a dismissal) as the text the `ask` tool returns to the model. A
 * dismissal is not a quieter answer: the client stops the turn on it (and the stand-in an aborted turn settles
 * with lands here too), so this text is read on the NEXT turn, where "proceed on defaults" would be an
 * instruction to resume work the user just pulled the plug on. Three callers word an answer with it, the live
 * tool (agent.ts), Cursor's own ask tool (cursor/cursor-tools.ts), and the restart path, where a restored
 * card's answer arrives with no tool call left to feed and rides a resumed turn's prompt instead
 * (turn-resume.ts), so the model reads ONE shape of answer wherever the daemon was in between.
 *
 * `parseAnswers` is the inverse, for the one reader that has the text and not the reply: a conversation rebuilt
 * from the provider's own session store (sessions/sessions.ts), the recovery a turn killed mid-flight goes
 * through, where the ask tool's stored result is the only trace of what the user chose. It reads exactly the
 * shapes the formatter writes and nothing else, so the two live side by side and change together. */

type QuestionReply = Extract<AgentReply, { kind: "question" }>;

// The tool as the model names it and as the SDK server registers it: `AskUserQuestion` is aliased onto the
// daemon's own `ask` (agent.ts toolAliases), and a stored session may carry either spelling of the call.
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

/* Undefined when the text is not one the formatter wrote (a tool result from some other runtime's ask, an
 * error), so the caller keeps the card unanswered rather than inventing a decision. Picks are split on the
 * separator they were joined with, so a label that itself contains ", " reads back as two picks: a bound of
 * the recovery path, not of the record, which keeps the reply verbatim and never comes through here. */
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
