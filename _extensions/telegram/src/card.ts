import { CARD_LINE_MAX, type CardState, type CardStep, type CardView, clipLine, type StatusCard, statusCardOf } from "@intentic/connector-runtime";
import { escapeHtml } from "./format.js";

// The status card a Telegram chat shows while the agent works on a request: one message in Telegram's HTML, edited in
// place, with Stop and Open in Intentic as buttons under it. What it says is the shared status model (connector-runtime's
// statusCardOf), the same Discord's and Slack's cards draw; this file is only how Telegram draws it. Pure.

// A button's callback data is capped at 64 bytes, too short for a conversation id, so the gateway hands the card a short
// token for each Stop it draws and reads the conversation back from it when the button is pressed.
export type StopData = (conversationId: string) => string;

const HEADLINES = {
    working: "⚙️ <b>Working</b>",
    done: "✅ <b>Done</b>",
    failed: "❌ <b>Failed</b>",
    stopping: "⏹️ <b>Stopping</b>",
    stopped: "⏹️ <b>Stopped</b>",
    held: "✋ <b>Waiting for approval</b>",
    queued: "⏳ <b>Queued</b>",
    "not-started": "❌ <b>Did not start</b>",
    "not-run": "⚪ <b>Did not run</b>",
} as const satisfies Record<CardState, string>;

const STEP_MARK = { running: "▸", done: "✓", failed: "✗" } as const satisfies Record<CardStep["status"], string>;
const PLAN_MARK = { completed: "✅", in_progress: "▸", pending: "▢" } as const;

const stepsSummary = (count: number): string => (count === 0 ? "" : ` · ${count} ${count === 1 ? "step" : "steps"}`);

// The object is cut to what is left of the line before it is drawn as code, so a cut never lands inside a tag.
const stepLine = (step: CardStep): string => {
    const lead = `${STEP_MARK[step.status]} ${step.verb}`;
    return step.object === undefined ? lead : `${lead} <code>${escapeHtml(clipLine(step.object, CARD_LINE_MAX - lead.length - 1))}</code>`;
};

const statusLines = (card: StatusCard): string[] => {
    const head = HEADLINES[card.state];
    switch (card.state) {
        case "held":
        case "queued":
            return [head, escapeHtml(card.note ?? "")];
        case "not-started":
        case "not-run":
            return [head];
        case "stopping":
        case "stopped":
            return [`${head} by ${escapeHtml(card.stoppedBy ?? "someone")} · ${card.elapsed}`];
        case "done":
            return [`${head} · ${card.elapsed}${stepsSummary(card.stepCount)}`];
        case "failed":
            return [`${head} · ${card.elapsed}`];
        case "working":
            return [
                `${head} · ${card.elapsed}`,
                ...(card.headline === undefined ? [] : [`<blockquote><i>${escapeHtml(clipLine(card.headline))}</i></blockquote>`]),
                ...(card.earlier > 0 ? [`<i>… ${card.earlier} earlier ${card.earlier === 1 ? "step" : "steps"}</i>`] : []),
                ...card.steps.map(stepLine),
                ...(card.idle === undefined ? [] : [card.idle === "writing" ? "✍️ Writing the reply…" : "💭 Thinking…"]),
            ];
    }
};

const planLines = (card: StatusCard): string[] => {
    if (card.plan.length === 0) {
        return [];
    }
    const items = card.plan.map((item) => {
        const text = escapeHtml(clipLine(item.text));
        return `${PLAN_MARK[item.status]} ${item.status === "in_progress" ? `<b>${text}</b>` : text}`;
    });
    return ["", "<b>Plan</b>", ...items, ...(card.planMore > 0 ? [`<i>… ${card.planMore} more</i>`] : [])];
};

// One inline keyboard button: a callback (Stop) or a link.
export type TelegramButton = { readonly text: string; readonly callback_data: string } | { readonly text: string; readonly url: string };

export interface TelegramCardBody {
    readonly text: string;
    readonly parse_mode: "HTML";
    // Always present, empty once no button applies: an edit without it would leave a finished card's Stop in place.
    readonly reply_markup: { readonly inline_keyboard: TelegramButton[][] };
}

export const renderCard = (view: CardView, stopData: StopData): TelegramCardBody => {
    const card = statusCardOf(view);
    const buttons: TelegramButton[] = [];
    if (card.stop !== undefined) {
        buttons.push({ text: "⏹️ Stop", callback_data: stopData(card.stop) });
    }
    if (card.link !== undefined) {
        buttons.push({ text: "Open in Intentic", url: card.link });
    }
    return {
        text: [...statusLines(card), ...planLines(card)].join("\n"),
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: buttons.length === 0 ? [] : [buttons] },
    };
};
