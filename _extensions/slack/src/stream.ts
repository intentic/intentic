import { type CardView, clipLine, statusCardOf, stepPhrase } from "@intentic/connector-runtime";
import type { ChatAppendStreamArguments } from "@slack/web-api";

// The opt-in alternative to the status card: Slack's own streamed message (chat.startStream / appendStream /
// stopStream) in its plan display, one block titled with where the work stands and holding each step of the agent's
// work as one of Slack's tasks, with the answer streamed into the same message below it. Slack draws the block itself. A stream can carry no button that goes away when the work ends, so Stop here is a ⏹️ reaction on the request (or
// Slack's own stop on the stream). Pure: what a view adds to what a stream already shows.

export type StreamChunk = NonNullable<ChatAppendStreamArguments["chunks"]>[number];

// Slack caps a task's title, and a plan's.
const CHUNK_TITLE_MAX = 256;

const TASK_STATUS = { running: "in_progress", done: "complete", failed: "error" } as const;

// What a stream has shown so far, so each edit sends only what changed.
export interface StreamShown {
    readonly tasks: Map<string, string>;
    title: string | undefined;
}

export const streamShown = (): StreamShown => ({ tasks: new Map(), title: undefined });

// Where the work stands, as the stream's title says it: the checklist item in progress and how far along the checklist
// is, else the agent's latest line of narration; how it ended once it has.
export const streamTitle = (view: CardView): string => {
    const card = statusCardOf(view);
    switch (card.state) {
        case "working": {
            const plan = view.progress.plan ?? [];
            const current = plan.find((item) => item.status === "in_progress");
            const lead =
                current === undefined
                    ? (card.headline ?? (card.idle === "writing" ? "Writing the reply" : "Working on it"))
                    : `${current.text} (${plan.filter((item) => item.status === "completed").length + 1}/${plan.length})`;
            return clipLine(`${lead} · ${card.elapsed}`, CHUNK_TITLE_MAX);
        }
        case "done":
            return `Done · ${card.elapsed}${card.stepCount === 0 ? "" : ` · ${card.stepCount} ${card.stepCount === 1 ? "step" : "steps"}`}`;
        case "stopping":
        case "stopped":
            return clipLine(`Stopped by ${card.stoppedBy ?? "someone"} · ${card.elapsed}`, CHUNK_TITLE_MAX);
        case "failed":
        case "not-started":
            return `Failed · ${card.elapsed}`;
        case "held":
        case "queued":
        case "not-run":
            return clipLine(card.note ?? "Waiting", CHUNK_TITLE_MAX);
    }
};

// What the view adds to the stream: a new title when it changed, and each step that is new or has moved on.
export const streamChunks = (view: CardView, shown: StreamShown): StreamChunk[] => {
    const chunks: StreamChunk[] = [];
    const title = streamTitle(view);
    if (title !== shown.title) {
        chunks.push({ type: "plan_update", title });
        shown.title = title;
    }
    for (const step of view.progress.steps) {
        const { verb, object } = stepPhrase(step, view.detail === "quiet");
        const taskTitle = clipLine(object === undefined ? verb : `${verb} ${object}`, CHUNK_TITLE_MAX);
        const status = TASK_STATUS[step.status];
        const seen = `${status}\u0000${taskTitle}`;
        if (shown.tasks.get(step.id) !== seen) {
            chunks.push({ type: "task_update", id: step.id, title: taskTitle, status });
            shown.tasks.set(step.id, seen);
        }
    }
    return chunks;
};
