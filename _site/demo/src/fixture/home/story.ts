import type { AgentEvent } from "@intentic/sandbox-contract/events/agent-events";
import type { ToolCallContent, ToolKind } from "@intentic/sandbox-contract/events/requests";
import type { TranscriptRow } from "@intentic/sandbox-contract/events/transcript";
import type { Beat } from "../../turn";

// THE PIECES A HOME RECORDING IS WRITTEN IN: the turn a sandbox's home conversation plays when it is first opened
// (turn.ts createRun), in the agent events a real run streams, so the real chat draws it. Each helper is one thing a
// person watching would recognise: words arriving, a step started and finished, a question asked.

/** One sandbox's home conversation: what was said before, what the person asks now, and the work that follows. */
export interface HomeStory {
    /** The conversation before this turn, as the transcript route answers it. */
    readonly history: TranscriptRow[];
    /** What the person asked, which opens the turn the recording plays. */
    readonly prompt: string;
    readonly beats: readonly Beat[];
}

// How a model's words arrive: a few at a time, quickly.
const WORDS_PER_CHUNK = 3;
const CHUNK_MS = 45;

/** The agent saying `text`, streamed a few words at a time, `after` ms from the beat before. */
export const say = (after: number, text: string): Beat[] => {
    const words = text.match(/\S+\s*/gu) ?? [text];
    const chunks: Beat[] = [];
    for (let index = 0; index < words.length; index += WORDS_PER_CHUNK) {
        chunks.push({ after: index === 0 ? after : CHUNK_MS, event: { kind: `delta`, text: words.slice(index, index + WORDS_PER_CHUNK).join(``) } });
    }
    return [...chunks, { after: 150, event: { kind: `text_end` } }];
};

/** Words already said in full when the turn is opened, as the poster of the landing page's hero shows them. */
export const said = (text: string): Beat[] => [
    { after: 0, event: { kind: `delta`, text } },
    { after: 0, event: { kind: `text_end` } },
];

/** One step of the work: a tool call that runs for `takes` ms and ends with what it found. */
export interface Step {
    readonly id: string;
    readonly name: string;
    readonly category: ToolKind;
    readonly target: string;
    readonly path?: string;
    readonly takes: number;
    readonly result?: readonly ToolCallContent[];
}

export const act = (after: number, step: Step): Beat[] => [
    {
        after,
        event: {
            kind: `tool_call`,
            id: step.id,
            name: step.name,
            category: step.category,
            status: `in_progress`,
            target: step.target,
            locations: step.path === undefined ? [] : [{ path: step.path }],
        },
    },
    {
        after: step.takes,
        event: { kind: `tool_call_update`, id: step.id, status: `completed`, content: [...(step.result ?? [])] },
    },
];

/** A tool's plain output. */
export const text = (output: string): ToolCallContent[] => [{ type: `text`, text: output }];

export interface Choice {
    readonly label: string;
    readonly description: string;
    /** What the agent does on this answer instead of the rest of the story; the first choice is the story itself. */
    readonly onPick?: readonly Beat[];
}

// An answer in the visitor's own words: the recording cannot act on them, so it stops and says so.
const OWN_WORDS: readonly Beat[] = [
    ...say(400, `Got it. I'll leave everything as it is for now, so nothing changes until you say so.`),
    { after: 200, event: { kind: `done` } },
];

// How long a question waits for the visitor before the recording answers it with its first choice, so the work goes on
// for someone only watching.
const ANSWER_AFTER_MS = 7_000;

/** A question the turn parks on; the first choice is the one the recording takes if nobody answers. */
export const ask = (after: number, requestId: string, header: string, question: string, choices: readonly [Choice, ...Choice[]]): Beat => ({
    after,
    event: {
        kind: `question`,
        requestId,
        questions: [{ question, header, multiSelect: false, options: choices.map(({ label, description }) => ({ label, description })) }],
    },
    park: requestId,
    answer: { after: ANSWER_AFTER_MS, reply: { kind: `question`, requestId, answers: { [question]: [choices[0].label] } } },
    instead: (reply) => {
        const picked = reply?.kind === `question` ? reply.answers?.[question]?.[0] : undefined;
        if (picked === undefined || picked === choices[0].label) {
            return undefined;
        }
        return choices.find((choice) => choice.label === picked)?.onPick ?? OWN_WORDS;
    },
});

/** How every recording opens: the model it runs on. */
export const opening = (): Beat => ({ after: 0, event: { kind: `init`, model: `claude-opus-5` } });

/** How every recording ends: what it spent, then done. */
export const closing = (spend: Extract<AgentEvent, { kind: "usage" }>): Beat[] => [
    { after: 300, event: spend },
    { after: 200, event: { kind: `done` } },
];
