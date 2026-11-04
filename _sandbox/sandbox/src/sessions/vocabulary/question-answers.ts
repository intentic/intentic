import { isAbsolute, join } from "node:path";
import type { AgentReply } from "@intentic/sandbox-contract/schemas/providers/plan-limits";
import { type AskQuestion, sharedOwnWords } from "@intentic/sandbox-contract/events/requests";

// formatAnswers renders the ask tool's result (picks or dismissal) as the text returned to the model, read the same way
// regardless of which of the three callers produced it. parseAnswers is the inverse, for a session rebuilt from stored
// text; it reads only the shapes the formatter writes, so the two must change together.

type QuestionReply = Extract<AgentReply, { kind: "question" }>;

// Model-facing and SDK-registered names for the same tool; a stored session may carry either spelling.
export const ASK_TOOL_NAMES: ReadonlySet<string> = new Set(["mcp__ui__ask", "AskUserQuestion"]);

const ANSWERED = "The user answered:";
// One reply in the user's own words to a card of several questions (the chat's composer answers a card that way): said
// once, as the one message it is, not repeated under every question as if each had been answered apart.
const ANSWERED_ALL = "The user answered all of these questions at once, in their own words:";
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

// What the agent reads when night hours answered for the owner (agent/night): the night first, so it never mistakes the
// pick for one a person made, then what to do with it. Both open the same way, which is how parseAnswers tells them.
const NIGHT_OPENING = "Nobody answered: it is the owner's night";
const nightHead = (until: string): string =>
    `${NIGHT_OPENING} (their night hours run until ${until} on the sandbox's clock) and nobody is at the editor, so`;
const NIGHT_PICKED_TAIL =
    'Carry on with it, keep the choice easy to undo, and list it in your final message under "Decided while you slept", so they can overturn it in the morning.';
const NIGHT_SAVED = "this question is kept for the morning instead of waiting on them";

/** The answer night hours give a question kept for the morning: also what a runtime handed answers verbatim reads. */
export const nightSavedWords = (until: string): string =>
    `${nightHead(until)} ${NIGHT_SAVED}. Do not decide it yourself: finish everything that does not depend on the answer, ` +
    "leave the rest as it is, and end your turn with this question and your recommendation at the top of your final message.";

/** One line a runtime that hands picks over as they are adds beside them, so its agent knows who chose (codex-agent.ts). */
export const nightPickedNote = (until: string): string => `${nightHead(until)} the sandbox picked the option you recommended. ${NIGHT_PICKED_TAIL}`;

const nightPicked = (questions: readonly AskQuestion[], answers: Readonly<Record<string, readonly string[]>>, until: string): string => {
    const lines = questions.map((question) => {
        const picks = answers[question.question] ?? [];
        return `- ${labelOf(question)}: ${picks.length > 0 ? picks.join(PICK_SEPARATOR) : NO_ANSWER}`;
    });
    return `${nightHead(until)} the sandbox answered for them with the option you recommended:\n${lines.join("\n")}\n\n${NIGHT_PICKED_TAIL}`;
};

// A night answer read back from what it wrote, for a session rebuilt from stored text.
const parseNight = (questions: readonly AskQuestion[], requestId: string, text: string): QuestionReply | undefined => {
    const until = /run until (\d{2}:\d{2})/.exec(text)?.[1];
    if (until === undefined) {
        return undefined;
    }
    if (text.includes(NIGHT_SAVED)) {
        const words = nightSavedWords(until);
        return { kind: "question", requestId, answers: Object.fromEntries(questions.map((question) => [question.question, [words]])), night: { outcome: "saved", until } };
    }
    const answers: Record<string, string[]> = {};
    for (const question of questions) {
        const line = text.split("\n").find((candidate) => candidate.startsWith(`- ${labelOf(question)}: `));
        const picks = line?.slice(`- ${labelOf(question)}: `.length);
        if (picks !== undefined) {
            answers[question.question] = picks === NO_ANSWER ? [] : picks.split(PICK_SEPARATOR);
        }
    }
    return { kind: "question", requestId, answers, night: { outcome: "picked", until } };
};

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
    if (reply.night !== undefined) {
        return reply.night.outcome === "saved" ? nightSavedWords(reply.night.until) : nightPicked(questions, answers, reply.night.until);
    }
    const note = answerFiles(questions, reply).length > 0 ? `\n\n${ATTACHED_NOTE}` : "";
    const words = sharedOwnWords(questions, answers);
    if (words !== undefined) {
        const files = answerFiles(questions, reply, root).map((path) => `${ATTACHED}${path}`);
        return `${ANSWERED_ALL}\n${[words, ...files].join("\n")}${note}`;
    }
    const lines = questions.flatMap((question) => {
        const picks = answers[question.question] ?? [];
        const files = (reply.attachments?.[question.question] ?? []).map((path) => `${ATTACHED}${placed(root, path)}`);
        return [`- ${labelOf(question)}: ${picks.length > 0 ? picks.join(PICK_SEPARATOR) : NO_ANSWER}`, ...files];
    });
    return `${ANSWERED}\n${lines.join("\n")}${note}`;
};

// The written body without its head and trailing note; a stored result flattens the pictures that rode after the text
// into `[image]` marks (tool-calls resultText), dropped here too.
const bodyOf = (text: string, head: string): string => {
    const body = text.slice(head.length + 1).replace(/(\[image\])+$/, "");
    return body.endsWith(`\n\n${ATTACHED_NOTE}`) ? body.slice(0, -(ATTACHED_NOTE.length + 2)) : body;
};

// A shared answer read back: the words every question took, the files after them on the first question, as the chat
// sends them (composerAnswer).
const parseShared = (questions: readonly AskQuestion[], requestId: string, text: string): QuestionReply => {
    const lines = bodyOf(text, ANSWERED_ALL).split("\n");
    const at = lines.findIndex((line) => line.startsWith(ATTACHED));
    const words = (at === -1 ? lines : lines.slice(0, at)).join("\n");
    const files = at === -1 ? [] : lines.slice(at).map((line) => line.slice(ATTACHED.length));
    const answers = Object.fromEntries(questions.map((question) => [question.question, [words]]));
    const first = questions[0]?.question;
    const reply: QuestionReply = { kind: "question", requestId, answers };
    if (first !== undefined && files.length > 0) {
        reply.attachments = { [first]: files };
    }
    return reply;
};

// Undefined when the text isn't one the formatter wrote, so the caller leaves the card unanswered rather than inventing
// a decision. Picks split on their join separator, so a label containing ", " would misparse; bounded by the recovery
// path, not the record.
export const parseAnswers = (questions: readonly AskQuestion[], requestId: string, text: string): QuestionReply | undefined => {
    if (text === DISMISSED) {
        return { kind: "question", requestId, cancelled: true };
    }
    if (text.startsWith(`${ANSWERED_ALL}\n`)) {
        return parseShared(questions, requestId, text);
    }
    if (text.startsWith(NIGHT_OPENING)) {
        return parseNight(questions, requestId, text);
    }
    if (!text.startsWith(`${ANSWERED}\n`)) {
        return undefined;
    }
    const lines = bodyOf(text, ANSWERED).split("\n");
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
