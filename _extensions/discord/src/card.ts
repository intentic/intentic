import { type CardState, type CardStep, type CardView, clipLine, type StatusCard, statusCardOf, stopButtonId } from "@intentic/connector-runtime";
import type { MessageBody } from "./discord-rest.js";

// The status card a thread shows while the agent works, drawn as one Discord embed edited in place: what the agent is
// doing now, the last few things it did, its checklist, and how long it has been at it, with Stop and Open in Intentic
// under it. When the turn ends it collapses to one line (done, failed, stopped) and keeps the link, a record that stays
// put while the answer itself is posted below as ordinary messages. What the card says is the shared status model
// (connector-runtime's statusCardOf); this file is only how Discord draws it. Pure: the same progress always draws the
// same card.

export { type CardView, PLAN_SHOWN, type ProgressDetail, progressDetailOf, STEPS_SHOWN, STOP_BUTTON, stopTarget } from "@intentic/connector-runtime";

const COLORS = {
    working: 0x5865f2,
    done: 0x57f287,
    failed: 0xed4245,
    waiting: 0xf0b232,
    stopped: 0x80848e,
} as const;

const COLOR_OF = {
    working: COLORS.working,
    done: COLORS.done,
    failed: COLORS.failed,
    "not-started": COLORS.failed,
    held: COLORS.waiting,
    queued: COLORS.waiting,
    stopping: COLORS.stopped,
    stopped: COLORS.stopped,
    "not-run": COLORS.stopped,
} as const satisfies Record<CardState, number>;

// Inline code that cannot be closed early by a backtick in what it quotes.
const code = (text: string): string => `\`${text.replaceAll("`", "ˋ")}\``;

const STEP_MARK = { running: "▸", done: "✓", failed: "✗" } as const satisfies Record<CardStep["status"], string>;

const stepLine = (step: CardStep): string => clipLine(`${STEP_MARK[step.status]} ${step.verb}${step.object === undefined ? "" : ` ${code(step.object)}`}`);

const PLAN_MARK = { completed: "✅", in_progress: "▸", pending: "▢" } as const;

const planLines = (card: StatusCard): string[] => {
    if (card.plan.length === 0) {
        return [];
    }
    const shown = card.plan.map((item) => {
        const text = clipLine(item.text);
        return `${PLAN_MARK[item.status]} ${item.status === "in_progress" ? `**${text}**` : text}`;
    });
    const more = card.planMore > 0 ? [`*… ${card.planMore} more*`] : [];
    return ["", "**Plan**", ...shown, ...more];
};

const stepsSummary = (count: number): string => (count === 0 ? "" : ` · ${count} ${count === 1 ? "step" : "steps"}`);

// What the agent is doing right now, and the few steps before it, while the turn runs.
const workingLines = (card: StatusCard): string[] => [
    ...(card.headline === undefined ? [] : [`> *${clipLine(card.headline)}*`]),
    ...(card.earlier > 0 ? [`*… ${card.earlier} earlier ${card.earlier === 1 ? "step" : "steps"}*`] : []),
    ...card.steps.map(stepLine),
    ...(card.idle === undefined ? [] : [card.idle === "writing" ? "✍️ Writing the reply…" : "💭 Thinking…"]),
];

const statusLines = (card: StatusCard): string[] => {
    switch (card.state) {
        case "held":
            return ["✋ **Waiting for approval**", card.note ?? ""];
        case "queued":
            return ["⏳ **Queued**", card.note ?? ""];
        case "not-started":
            return ["❌ **Did not start**"];
        case "not-run":
            return ["⚪ **Did not run**"];
        case "stopping":
        case "stopped":
            return [`⏹️ **${card.state === "stopped" ? "Stopped" : "Stopping"}** by ${card.stoppedBy ?? "someone"} · ${card.elapsed}`];
        case "failed":
            return [`❌ **Failed** · ${card.elapsed}`];
        case "done":
            return [`✅ **Done** · ${card.elapsed}${stepsSummary(card.stepCount)}`];
        case "working":
            return [`⚙️ **Working** · ${card.elapsed}`, ...workingLines(card)];
    }
};

// Buttons under the card: Stop while a turn runs and nobody has pressed it yet, and the conversation's link always.
const buttonsOf = (card: StatusCard): object[] => {
    const buttons: object[] = [];
    if (card.stop !== undefined) {
        buttons.push({ type: 2, style: 4, label: "Stop", emoji: { name: "⏹️" }, custom_id: stopButtonId(card.stop) });
    }
    if (card.link !== undefined) {
        buttons.push({ type: 2, style: 5, label: "Open in Intentic", url: card.link });
    }
    return buttons.length === 0 ? [] : [{ type: 1, components: buttons }];
};

export const renderCard = (view: CardView): MessageBody => {
    const card = statusCardOf(view);
    // The checklist stays on a finished card as the record of what was done; a turn that never opened has none.
    const description = [...statusLines(card), ...planLines(card)].join("\n");
    return { embeds: [{ description, color: COLOR_OF[card.state] }], components: buttonsOf(card) };
};
