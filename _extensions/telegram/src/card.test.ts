import type { CardView, TurnProgress } from "@intentic/connector-runtime";
import { renderCard } from "./card.js";

// The status card as Telegram draws it: HTML and an inline keyboard, from the shared model.

const notOpened = (over: Partial<TurnProgress> = {}): TurnProgress => ({ startedAt: 0, steps: [], stepCount: 0, writing: false, ended: false, ...over });
const progress = (over: Partial<TurnProgress> = {}): TurnProgress =>
    notOpened({ openedAt: 0, opened: { conversationId: "conv-1", link: "https://app.intentic.dev/?conversation=conv-1" }, ...over });

const stopData = (conversationId: string): string => `stop:${conversationId.length}`;
const drawn = (over: Partial<CardView>) => renderCard({ progress: progress(), now: 72_000, detail: "steps", ...over }, stopData);

test("a working card leads with the elapsed time, lists the steps, and offers Stop by token and the link", () => {
    const steps = [
        { id: "1", tool: "Read", kind: "read" as const, target: "src/a<b>.ts", status: "done" as const },
        { id: "2", tool: "Bash", kind: "execute" as const, target: "pnpm test", status: "running" as const },
    ];
    expect(drawn({ progress: progress({ steps, stepCount: 2 }), headline: "Found it & fixing" })).toEqual({
        text: [
            "⚙️ <b>Working</b> · 1m 12s",
            "<blockquote><i>Found it &amp; fixing</i></blockquote>",
            "✓ Read <code>src/a&lt;b&gt;.ts</code>",
            "▸ Running <code>pnpm test</code>",
        ].join("\n"),
        parse_mode: "HTML",
        reply_markup: {
            inline_keyboard: [
                [
                    { text: "⏹️ Stop", callback_data: "stop:6" },
                    { text: "Open in Intentic", url: "https://app.intentic.dev/?conversation=conv-1" },
                ],
            ],
        },
    });
});

test("a finished card is one line with its checklist and the link, and no Stop", () => {
    const plan = [{ text: "Fix the guard", status: "completed" as const }];
    const card = drawn({ progress: progress({ ended: true, stepCount: 3, plan }), now: 5_000 });
    expect(card.text).toBe("✅ <b>Done</b> · 5s · 3 steps\n\n<b>Plan</b>\n✅ Fix the guard");
    expect(card.reply_markup.inline_keyboard).toEqual([[{ text: "Open in Intentic", url: "https://app.intentic.dev/?conversation=conv-1" }]]);
});

test("a held request says why with no buttons left, so an edit takes the old ones away", () => {
    const card = renderCard({ progress: notOpened({ held: "Needs <owner> approval." }), now: 0, detail: "steps" }, stopData);
    expect(card.text).toBe("✋ <b>Waiting for approval</b>\nNeeds &lt;owner&gt; approval.");
    expect(card.reply_markup).toEqual({ inline_keyboard: [] });
});
