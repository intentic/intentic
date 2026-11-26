import { oneLine } from "@intentic/base/one-line";
import type { ChildNewsKind, TranscriptChildNews, TranscriptRow } from "./transcript.js";

// WHAT THE SANDBOX TELLS A PARENT ABOUT ONE OF ITS SUBAGENTS between its start and its report: it moved, it stays
// stopped, it starts again, a message to it did not go. The parent reads each as a prompt nobody typed; a reader draws
// it as news about that subagent, never as the owner's own words (2026-11-26: four of these, one cause, drew as four of
// the owner's bubbles and filled the screen). Composing and recognising stay one piece of knowledge here, so every
// sentence below is also what the parser anchors on: keep each one's opening and the words that follow the name
// unchanged across releases, or news already in a record reads as the owner's words again.

/** The subagent a piece of news is about: its id, and its title where the sentence names one. */
export interface NewsSubject {
    readonly child: string;
    readonly title?: string | undefined;
}

// `sub-x7` or `sub-x7 ("Port the parser")`; a title is one line, since the parser reads the name off one.
const named = ({ child, title }: NewsSubject): string => {
    const label = title === undefined ? "" : oneLine(title);
    return label === "" ? `\`${child}\`` : `\`${child}\` ("${label}")`;
};

// Paths and repos as a sentence names them: each in backticks, past `shown` the rest counted.
export const listed = (items: readonly string[], shown: number = items.length): string =>
    [
        items
            .slice(0, shown)
            .map((item) => `\`${item}\``)
            .join(", "),
        ...(items.length > shown ? [`and ${items.length - shown} more`] : []),
    ].join(" ");

/** Its runner could not prepare its copy of the workspace, so it runs in this sandbox instead. */
export const movedHereWords = (who: NewsSubject, runner: string, failure: string): string =>
    `Your subagent ${named(who)} could not start on the runner "${runner}": ${failure} It runs here, in this sandbox, instead, and its report reaches you when it ends.`;

/** It ended without running again, and nothing will run it again by itself. */
export const stoppedWords = (who: NewsSubject, why: string): string => `Your subagent ${named(who)} stays stopped: ${why}`;

/** A restart cut it before any model read its brief, so it starts again by itself. */
export const restartedWords = (who: NewsSubject): string =>
    `Your subagent ${named(who)} had not started when the sandbox restarted, so it starts again by itself, from its task: its report reaches you when it ends.`;

/** Its turn opened on another model than it was spawned on. */
export const otherModelWords = (who: NewsSubject, served: string, asked: string): string =>
    `Your subagent ${named(who)} runs this turn on ${served}, not on ${asked} as it was spawned: ${asked} was not offered when the turn started. Cancel it if that model will not do.`;

/** Refused where it ran, it moved itself to the next of its fallbacks (`provider/model` both). */
export const fellBackWords = (who: NewsSubject, from: string, to: string, refusal: string): string =>
    `Your subagent ${named(who)} was refused on ${from} and moved itself to ${to}, the next of the fallbacks you gave it: it carries on in the same worktree, and its report comes when that turn ends. The refusal: ${refusal}`;

/** A turn started on it without its parent; `why` says what started it. */
export const workingWords = (who: NewsSubject, why: string): string =>
    `Your subagent ${named(who)} is working: ${why}. Its report reaches you when it ends, like any turn of its: do not send it the task again or give the task to another agent meanwhile.`;

/** A start the owner had to allow never ran. */
export const notStartedWords = (child: string, why: string): string => `Your subagent \`${child}\` did not start: ${why}`;

/** The owner allowed a held start; `note` says what the start did beyond that. */
export const allowedWords = (child: string, note: string): string => `The owner allowed your subagent \`${child}\` to start. ${note}`;

/** A message the parent sent it never reached it. */
export const messageLostWords = (child: string, why: string): string => `Your message to subagent \`${child}\` did not go: ${why}`;

/** An answer the parent gave it never reached it. */
export const answerLostWords = (child: string, why: string): string => `Your answer to subagent \`${child}\` did not go: ${why}`;

/** One question a subagent stopped on, as its card asked it. */
export interface NewsQuestion {
    readonly question: string;
    readonly options: readonly { readonly label: string }[];
    readonly multiSelect?: boolean | undefined;
}

const QUESTION_OPENS = "stopped on a question and is waiting for your answer";

/** It stopped on a question: the questions whole, options and all, and the door that answers them, since the parent may
 *  have no wait open to read them from. */
export const questionWords = (who: NewsSubject, questions: readonly NewsQuestion[]): string =>
    [
        `Your subagent ${named(who)} ${QUESTION_OPENS}; until you give one it does nothing and keeps its seat.`,
        ...questions.map((asked) => {
            const options = asked.options.map((option) => option.label);
            return `- ${asked.question}${options.length === 0 ? "" : ` (options: ${options.join(", ")}${asked.multiSelect === true ? "; pick any number" : ""})`}`;
        }),
        `Answer with answer(child: "${who.child}", answers: [{ question, picks }]), one entry per question in its own words. If it is not yours to decide, say so to the owner rather than guessing.`,
    ].join("\n");

/** A task handed to a linked sandbox stopped on a question over there. */
export const linkedQuestionWords = (child: string, sandbox: string, questions: readonly NewsQuestion[]): string =>
    [
        `Subagent \`${child}\`, the task you handed to the linked sandbox "${sandbox}", asks:`,
        "",
        ...questions.map((entry) => {
            const options = entry.options.map((option) => option.label).join(" / ");
            return options === "" ? `- ${entry.question}` : `- ${entry.question} (${options})`;
        }),
        "",
        `Answer it with answer(child: "${child}"), or send it words with send.`,
    ].join("\n");

/** Its work reached the main tree. */
export const landedWords = (who: NewsSubject, repos: readonly string[]): string =>
    `Your subagent ${named(who)} landed in the main tree${repos.length === 0 ? "" : ` (${listed(repos)})`}.`;

// Paths a conflict sentence names before counting the rest.
const PATHS_NAMED = 5;

/** The owner's Land on it hit a merge conflict, so nothing of it reached the main tree. */
export const landConflictWords = (who: NewsSubject, paths: readonly string[]): string =>
    [
        `The owner pressed Land on your subagent ${named(who)}, and it hit a merge conflict${paths.length === 0 ? "" : ` on ${listed(paths, PATHS_NAMED)}`}: nothing of it reached the main tree.`,
        "It lands once its branch is rebased onto the main line and the conflicts are resolved. The owner can have it do that from its card, or you can tell it to; a message you send while another turn runs on it waits for that turn to end.",
    ].join(" ");

/** Its finished work waits on its branch, and the parent's checkout moved under it; `line` says how. */
export const driftWords = (who: NewsSubject, line: string): string =>
    `Your subagent ${named(who)} has finished work held on its branch, and your checkout moved under it: ${line} ` +
    `Bring it in now while the clash is small (the merge tool, or \`agents merge ${who.child}\`, with conflict markers to resolve), or send it a message to rebase onto your checkout.`;

// THE PARSER. Each sentence is matched whole from its opening: the id, the title where it has one (lazy, so a title
// holding quotes or brackets still ends where the fixed words after it begin), then what each kind carries.
const NAME = "`([^`]+)`(?: \\(\"(.*?)\"\\))?";
const BARE = "`([^`]+)`";

interface Reading {
    readonly kind: ChildNewsKind;
    readonly pattern: RegExp;
    // Whether the pattern reads a title after the id: then group 2 is the title and what the kind carries follows.
    readonly titled: boolean;
    readonly carries?: (rest: readonly (string | undefined)[]) => Carried;
}

type Carried = Pick<TranscriptChildNews, "runner" | "model" | "cause">;

// What a kind carries, each field only where the sentence had it.
const carried = (fields: { readonly runner?: string | undefined; readonly model?: string | undefined; readonly cause?: string | undefined }): Carried => {
    const kept: Carried = {};
    if (fields.runner !== undefined) {
        kept.runner = fields.runner;
    }
    if (fields.model !== undefined) {
        kept.model = fields.model;
    }
    const cause = fields.cause?.trim();
    if (cause !== undefined && cause !== "") {
        kept.cause = cause;
    }
    return kept;
};

// The first question a subagent asks, without the options the sentence lists after it.
const firstQuestion = (prompt: string): Carried =>
    carried({
        cause: prompt
            .split("\n")
            .find((line) => line.startsWith("- "))
            ?.slice(2)
            .replace(/ \(options: .*\)$/u, ""),
    });

const READINGS: readonly Reading[] = [
    {
        kind: "movedHere",
        pattern: new RegExp(`^Your subagent ${NAME} could not start on the runner "([^"]+)": ([\\s\\S]*) It runs here, in this sandbox, instead, and its report reaches you when it ends\\.$`, "u"),
        titled: true,
        carries: ([runner, failure]) => carried({ runner, cause: failure }),
    },
    { kind: "stopped", pattern: new RegExp(`^Your subagent ${NAME} stays stopped: ([\\s\\S]*)$`, "u"), titled: true, carries: ([why]) => carried({ cause: why }) },
    { kind: "restarted", pattern: new RegExp(`^Your subagent ${NAME} had not started when the sandbox restarted, so it starts again by itself`, "u"), titled: true },
    {
        kind: "otherModel",
        pattern: new RegExp(`^Your subagent ${NAME} runs this turn on (\\S+), not on (\\S+) as it was spawned:`, "u"),
        titled: true,
        carries: ([served]) => carried({ model: served }),
    },
    {
        kind: "fellBack",
        pattern: new RegExp(`^Your subagent ${NAME} was refused on (\\S+) and moved itself to (\\S+), the next of the fallbacks you gave it:[\\s\\S]*? The refusal: ([\\s\\S]*)$`, "u"),
        titled: true,
        carries: ([, to, refusal]) => carried({ model: to, cause: refusal }),
    },
    {
        kind: "working",
        pattern: new RegExp(`^Your subagent ${NAME} is working: ([\\s\\S]*?)\\. Its report reaches you when it ends, like any turn of its`, "u"),
        titled: true,
        carries: ([why]) => carried({ cause: why }),
    },
    { kind: "notStarted", pattern: new RegExp(`^Your subagent ${BARE} did not start: ([\\s\\S]*)$`, "u"), titled: false, carries: ([why]) => carried({ cause: why }) },
    { kind: "allowed", pattern: new RegExp(`^The owner allowed your subagent ${BARE} to start\\.`, "u"), titled: false },
    { kind: "messageLost", pattern: new RegExp(`^Your message to subagent ${BARE} did not go: ([\\s\\S]*)$`, "u"), titled: false, carries: ([why]) => carried({ cause: why }) },
    { kind: "answerLost", pattern: new RegExp(`^Your answer to subagent ${BARE} did not go: ([\\s\\S]*)$`, "u"), titled: false, carries: ([why]) => carried({ cause: why }) },
    { kind: "question", pattern: new RegExp(`^Your subagent ${NAME} ${QUESTION_OPENS};`, "u"), titled: true },
    { kind: "question", pattern: new RegExp(`^Subagent ${BARE}, the task you handed to the linked sandbox "[^"]*", asks:\\n`, "u"), titled: false },
    { kind: "landed", pattern: new RegExp(`^Your subagent ${NAME} landed in the main tree`, "u"), titled: true },
    { kind: "landConflict", pattern: new RegExp(`^The owner pressed Land on your subagent ${NAME}, and it hit a merge conflict`, "u"), titled: true },
    {
        kind: "drift",
        pattern: new RegExp(`^Your subagent ${NAME} has finished work held on its branch, and your checkout moved under it: ([\\s\\S]*?) Bring it in now while the clash is small`, "u"),
        titled: true,
        carries: ([line]) => carried({ cause: line }),
    },
];

/** Which subagent news a stored prompt is; undefined for every other prompt. */
export const childNewsOf = (prompt: string): TranscriptChildNews | undefined => {
    for (const reading of READINGS) {
        const match = reading.pattern.exec(prompt);
        const from = match?.[1];
        if (match === null || from === undefined) {
            continue;
        }
        const title = reading.titled ? match[2] : undefined;
        const rest = match.slice(reading.titled ? 3 : 2);
        const news: TranscriptChildNews = { kind: reading.kind, from, sent: prompt };
        if (title !== undefined && title !== "") {
            news.title = title;
        }
        return Object.assign(news, reading.kind === "question" ? firstQuestion(prompt) : reading.carries?.(rest));
    }
    return undefined;
};

// The row's one line, for a reader with no words of its own for the kind; the prompt itself is disclosed under it.
const HEADLINE = {
    movedHere: (news) => `could not start on the runner "${news.runner ?? ""}" and runs here instead`,
    stopped: () => "stays stopped",
    restarted: () => "starts again after a restart",
    otherModel: (news) => `runs on ${news.model ?? "another model"}`,
    fellBack: (news) => `moved to ${news.model ?? "its next fallback"}`,
    working: () => "is working again",
    notStarted: () => "did not start",
    allowed: () => "was allowed to start",
    messageLost: () => "did not get a message",
    answerLost: () => "did not get an answer",
    question: () => "asks a question",
    landed: () => "landed",
    landConflict: () => "hit a merge conflict on Land",
    drift: () => "has held work your checkout moved under",
} as const satisfies Record<ChildNewsKind, (news: TranscriptChildNews) => string>;

const headline = (news: TranscriptChildNews): string => {
    const sender = news.title === undefined ? news.from : `"${news.title}" (${news.from})`;
    return `Subagent ${sender} ${HEADLINE[news.kind](news)}.`;
};

/** News about a subagent is a notice: it is neither this conversation's user nor its agent. */
export const childNewsRow = (prompt: string): TranscriptRow | undefined => {
    const childNews = childNewsOf(prompt);
    return childNews === undefined ? undefined : { role: "notice", text: headline(childNews), childNews };
};

/** A row recorded before news had a row of its own, as the user's: read as the news it is, keeping its place and its
 *  moment. Every other row comes back as it was, the same object. */
export const asChildNews = (row: TranscriptRow): TranscriptRow => {
    if (row.role !== "user" || row.childNews !== undefined || row.speaker?.kind === "person" || row.speaker?.kind === "program") {
        return row;
    }
    const news = childNewsRow(row.text);
    if (news === undefined) {
        return row;
    }
    const { sentAt, speaker: _speaker, errand: _errand, checkpointId: _checkpoint, rewindIndex: _rewind, ...kept } = row;
    const read: TranscriptRow = { ...kept, ...news };
    if (sentAt !== undefined) {
        read.openedAt = sentAt;
    }
    return read;
};
