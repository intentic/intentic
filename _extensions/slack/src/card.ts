import { CARD_LINE_MAX, type CardState, type CardStep, type CardView, clipLine, type StatusCard, statusCardOf, stopButtonId } from "@intentic/connector-runtime";
import type { ChatUpdateArguments } from "@slack/web-api";

// The status card a Slack thread shows while the agent works, drawn as Block Kit and edited in place: where the work
// stands and for how long, the last few steps, the agent's checklist, and Stop and Open in Intentic under it. When the
// turn ends it collapses to one line and keeps the link. What the card says is the shared status model
// (connector-runtime's statusCardOf), the same one Discord's card draws; this file is only how Slack draws it. Pure.

// One Block Kit block, as Slack's message calls take it.
export type SlackBlock = Extract<ChatUpdateArguments, { blocks: unknown }>["blocks"][number];

// The first block of every status card carries this id, so the thread's history can leave cards out of what the model
// reads: they are the agent's status, not something it said.
export const STATUS_BLOCK_ID = "intentic-status";

// Slack's mrkdwn treats these three as markup; anything quoted from the agent's work is escaped.
export const escapeMrkdwn = (text: string): string => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

// Inline code that cannot be closed early by a backtick in what it quotes.
const code = (text: string): string => `\`${escapeMrkdwn(text.replaceAll("`", "ˋ"))}\``;

const STEP_MARK = { running: "▸", done: "✓", failed: "✗" } as const satisfies Record<CardStep["status"], string>;

// The object is cut to what is left of the line before it is drawn as code, so a cut never lands inside the markup.
const stepLine = (step: CardStep): string => {
    const lead = `${STEP_MARK[step.status]} ${step.verb}`;
    return step.object === undefined ? lead : `${lead} ${code(clipLine(step.object, CARD_LINE_MAX - lead.length - 1))}`;
};

const PLAN_MARK = { completed: "✅", in_progress: "▸", pending: "▢" } as const;

const stepsSummary = (count: number): string => (count === 0 ? "" : ` · ${count} ${count === 1 ? "step" : "steps"}`);

// The card's first line: where the work stands. Its words without markup are the message's notification text.
const HEADLINES = {
    working: "⚙️ Working",
    done: "✅ Done",
    failed: "❌ Failed",
    stopping: "⏹️ Stopping",
    stopped: "⏹️ Stopped",
    held: "✋ Waiting for approval",
    queued: "⏳ Queued",
    "not-started": "❌ Did not start",
    "not-run": "⚪ Did not run",
} as const satisfies Record<CardState, string>;

// The first line in mrkdwn, and the same words plain for the notification.
interface StatusLine {
    readonly marked: string;
    readonly plain: string;
}

const statusLine = (card: StatusCard): StatusLine => {
    const head = HEADLINES[card.state];
    const [emoji = "", ...words] = head.split(" ");
    const bold = `${emoji} *${words.join(" ")}*`;
    switch (card.state) {
        case "held":
        case "queued":
        case "not-started":
        case "not-run":
            return { marked: bold, plain: head };
        case "stopping":
        case "stopped": {
            const tail = ` by ${card.stoppedBy ?? "someone"} · ${card.elapsed}`;
            return { marked: `${bold}${escapeMrkdwn(tail)}`, plain: `${head}${tail}` };
        }
        case "done": {
            const tail = ` · ${card.elapsed}${stepsSummary(card.stepCount)}`;
            return { marked: `${bold}${tail}`, plain: `${head}${tail}` };
        }
        case "failed":
        case "working":
            return { marked: `${bold} · ${card.elapsed}`, plain: `${head} · ${card.elapsed}` };
    }
};

const workingLines = (card: StatusCard): string[] => [
    ...(card.earlier > 0 ? [`_… ${card.earlier} earlier ${card.earlier === 1 ? "step" : "steps"}_`] : []),
    ...card.steps.map(stepLine),
    ...(card.idle === undefined ? [] : [card.idle === "writing" ? "✍️ Writing the reply…" : "💭 Thinking…"]),
];

const planText = (card: StatusCard): string | undefined => {
    if (card.plan.length === 0) {
        return undefined;
    }
    const items = card.plan.map((item) => {
        const text = escapeMrkdwn(clipLine(item.text));
        return `${PLAN_MARK[item.status]} ${item.status === "in_progress" ? `*${text}*` : text}`;
    });
    return ["*Plan*", ...items, ...(card.planMore > 0 ? [`_… ${card.planMore} more_`] : [])].join("\n");
};

// A button, as an actions block takes its elements.
type SlackButton = Extract<SlackBlock, { type: "actions" }>["elements"][number];

const buttonsOf = (card: StatusCard): SlackButton[] => {
    const buttons: SlackButton[] = [];
    if (card.stop !== undefined) {
        buttons.push({
            type: "button",
            action_id: stopButtonId(card.stop),
            text: { type: "plain_text", text: "⏹️ Stop", emoji: true },
            style: "danger",
            value: card.stop,
        });
    }
    if (card.link !== undefined) {
        buttons.push({ type: "button", action_id: "intentic:open", text: { type: "plain_text", text: "Open in Intentic" }, url: card.link });
    }
    return buttons;
};

const mrkdwn = (text: string) => ({ type: "mrkdwn" as const, text });

// A message body Slack's chat.postMessage and chat.update both take.
export interface SlackCardBody {
    readonly text: string;
    readonly blocks: SlackBlock[];
}

export const renderCard = (view: CardView): SlackCardBody => {
    const card = statusCardOf(view);
    const status = statusLine(card);
    const lead = [status.marked, ...(card.note === undefined ? [] : [escapeMrkdwn(card.note)])];
    if (card.headline !== undefined) {
        lead.push(`> _${escapeMrkdwn(clipLine(card.headline))}_`);
    }
    const blocks: SlackBlock[] = [{ type: "section", block_id: STATUS_BLOCK_ID, text: mrkdwn(lead.join("\n")) }];
    const working = card.live ? workingLines(card) : [];
    if (working.length > 0) {
        blocks.push({ type: "context", elements: [mrkdwn(working.join("\n"))] });
    }
    const plan = planText(card);
    if (plan !== undefined) {
        blocks.push({ type: "section", text: mrkdwn(plan) });
    }
    const buttons = buttonsOf(card);
    if (buttons.length > 0) {
        blocks.push({ type: "actions", elements: buttons });
    }
    return { text: status.plain, blocks };
};
