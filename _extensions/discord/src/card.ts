import { currentStep, elapsedOf, formatElapsed, type ListenerStep, stepPhrase, type TurnProgress } from "@intentic/connector-runtime";
import type { MessageBody } from "./discord-rest.js";

// The status card a thread shows while the agent works: one embed, edited in place, saying what the agent is doing now,
// the last few things it did, its checklist, and how long it has been at it, with Stop and Open in Intentic under it.
// When the turn ends it collapses to one line (done, failed, stopped) and keeps the link, a record that stays put while
// the answer itself is posted below as ordinary messages. Pure: the same progress always draws the same card.

// How much of the agent's work a card shows: every step with what it touched, the steps without it (for a channel
// that should see that the agent works, not which files and commands), or no card at all.
export type ProgressDetail = "steps" | "quiet" | "off";

export const progressDetailOf = (value: string | undefined): ProgressDetail => (value === "quiet" || value === "off" ? value : "steps");

// A Stop button's id carries the conversation it stops; the gateway reads it back when someone presses it.
export const STOP_BUTTON = "intentic:stop:";

export const stopTarget = (customId: string): string | undefined =>
    customId.startsWith(STOP_BUTTON) && customId.length > STOP_BUTTON.length ? customId.slice(STOP_BUTTON.length) : undefined;

export interface CardView {
    readonly progress: TurnProgress;
    readonly now: number;
    readonly detail: Exclude<ProgressDetail, "off">;
    // The agent's latest short line of narration, which reads better on the card than as a message of its own.
    readonly headline?: string;
    // Someone pressed Stop: who, while it winds down and after.
    readonly stoppedBy?: string;
}

// How many steps a card lists, and checklist items; the rest are counted.
export const STEPS_SHOWN = 6;
export const PLAN_SHOWN = 8;
const LINE_MAX = 140;

const COLORS = {
    working: 0x5865f2,
    done: 0x57f287,
    failed: 0xed4245,
    waiting: 0xf0b232,
    stopped: 0x80848e,
} as const;

const clip = (text: string, max = LINE_MAX): string => (text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`);

// Inline code that cannot be closed early by a backtick in what it quotes.
const code = (text: string): string => `\`${text.replaceAll("`", "ˋ")}\``;

const STEP_MARK = { running: "▸", done: "✓", failed: "✗" } as const satisfies Record<ListenerStep["status"], string>;

const stepLine = (step: ListenerStep, detail: CardView["detail"]): string => {
    const { verb, object } = stepPhrase(step, detail === "quiet");
    return clip(`${STEP_MARK[step.status]} ${verb}${object === undefined ? "" : ` ${code(object)}`}`);
};

const PLAN_MARK = { completed: "✅", in_progress: "▸", pending: "▢" } as const;

const planLines = (progress: TurnProgress): string[] => {
    const plan = progress.plan ?? [];
    if (plan.length === 0) {
        return [];
    }
    const shown = plan.slice(0, PLAN_SHOWN).map((item) => {
        const text = clip(item.text);
        return `${PLAN_MARK[item.status]} ${item.status === "in_progress" ? `**${text}**` : text}`;
    });
    const more = plan.length > PLAN_SHOWN ? [`*… ${plan.length - PLAN_SHOWN} more*`] : [];
    return ["", "**Plan**", ...shown, ...more];
};

const stepsSummary = (count: number): string => (count === 0 ? "" : ` · ${count} ${count === 1 ? "step" : "steps"}`);

// What the agent is doing right now, and the few steps before it, while the turn runs.
const workingLines = (view: CardView): string[] => {
    const { progress } = view;
    const shown = progress.steps.slice(-STEPS_SHOWN);
    const earlier = progress.stepCount - shown.length;
    const lines = [
        ...(view.headline === undefined ? [] : [`> *${clip(view.headline)}*`]),
        ...(earlier > 0 ? [`*… ${earlier} earlier ${earlier === 1 ? "step" : "steps"}*`] : []),
        ...shown.map((step) => stepLine(step, view.detail)),
    ];
    if (currentStep(progress) === undefined) {
        lines.push(progress.writing ? "✍️ Writing the reply…" : "💭 Thinking…");
    }
    return lines;
};

interface Status {
    readonly color: number;
    readonly lines: readonly string[];
    readonly live: boolean;
}

// Where a turn stands before it opened: parked for a person (its stream ends there, so this outlives the stream),
// waiting behind another turn, or never run at all.
const notOpened = (progress: TurnProgress): Status | undefined => {
    if (progress.held !== undefined) {
        return { color: COLORS.waiting, lines: ["✋ **Waiting for approval**", progress.held], live: false };
    }
    if (progress.failed !== undefined) {
        return { color: COLORS.failed, lines: ["❌ **Did not start**"], live: false };
    }
    if (progress.ended) {
        return { color: COLORS.stopped, lines: ["⚪ **Did not run**"], live: false };
    }
    if (progress.queued !== undefined) {
        return { color: COLORS.waiting, lines: ["⏳ **Queued**", progress.queued], live: false };
    }
    return undefined;
};

const statusOf = (view: CardView): Status => {
    const { progress, now } = view;
    const elapsed = formatElapsed(elapsedOf(progress, now));
    const waiting = progress.opened === undefined ? notOpened(progress) : undefined;
    if (waiting !== undefined) {
        return waiting;
    }
    if (view.stoppedBy !== undefined) {
        const verb = progress.ended ? "Stopped" : "Stopping";
        return { color: COLORS.stopped, lines: [`⏹️ **${verb}** by ${view.stoppedBy} · ${elapsed}`], live: false };
    }
    if (progress.ended && progress.failed !== undefined) {
        return { color: COLORS.failed, lines: [`❌ **Failed** · ${elapsed}`], live: false };
    }
    if (progress.ended) {
        return { color: COLORS.done, lines: [`✅ **Done** · ${elapsed}${stepsSummary(progress.stepCount)}`], live: false };
    }
    return { color: COLORS.working, lines: [`⚙️ **Working** · ${elapsed}`, ...workingLines(view)], live: true };
};

// Buttons under the card: Stop while a turn runs and nobody has pressed it yet, and the conversation's link always.
const buttonsOf = (view: CardView, live: boolean): object[] => {
    const opened = view.progress.opened;
    const buttons: object[] = [];
    if (live && opened !== undefined && view.stoppedBy === undefined) {
        buttons.push({ type: 2, style: 4, label: "Stop", emoji: { name: "⏹️" }, custom_id: `${STOP_BUTTON}${opened.conversationId}` });
    }
    if (opened?.link !== undefined) {
        buttons.push({ type: 2, style: 5, label: "Open in Intentic", url: opened.link });
    }
    return buttons.length === 0 ? [] : [{ type: 1, components: buttons }];
};

export const renderCard = (view: CardView): MessageBody => {
    const status = statusOf(view);
    // The checklist stays on a finished card as the record of what was done; a turn that never opened has none.
    const description = [...status.lines, ...(view.progress.opened === undefined ? [] : planLines(view.progress))].join("\n");
    return { embeds: [{ description, color: status.color }], components: buttonsOf(view, status.live) };
};
