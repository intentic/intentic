import { type CardView, stopButtonId, type TurnProgress } from "@intentic/connector-runtime";
import { escapeMrkdwn, renderCard, STATUS_BLOCK_ID } from "./card.js";

// The status card as Slack draws it: Block Kit, the shared model's words in mrkdwn.

const notOpened = (over: Partial<TurnProgress> = {}): TurnProgress => ({ startedAt: 0, steps: [], stepCount: 0, writing: false, ended: false, ...over });
const progress = (over: Partial<TurnProgress> = {}): TurnProgress =>
    notOpened({ openedAt: 0, opened: { conversationId: "conv-1", link: "https://app.intentic.dev/?conversation=conv-1" }, ...over });

const drawn = (over: Partial<CardView>) => renderCard({ progress: progress(), now: 72_000, detail: "steps", ...over });

const section = (text: string) => ({ type: "section", text: { type: "mrkdwn", text } });
const context = (text: string) => ({ type: "context", elements: [{ type: "mrkdwn", text }] });

test("a working card leads with the elapsed time, lists the steps as context, and offers Stop and the link", () => {
    const steps = [
        { id: "1", tool: "Read", kind: "read" as const, target: "src/auth/redirect.ts", status: "done" as const },
        { id: "2", tool: "Bash", kind: "execute" as const, target: "pnpm test login", status: "running" as const },
    ];
    const card = drawn({ progress: progress({ steps, stepCount: 2 }), headline: "Found it: the guard compares <origin> & host." });
    expect(card).toEqual({
        text: "⚙️ Working · 1m 12s",
        blocks: [
            { ...section("⚙️ *Working* · 1m 12s\n> _Found it: the guard compares &lt;origin&gt; &amp; host._"), block_id: STATUS_BLOCK_ID },
            context("✓ Read `src/auth/redirect.ts`\n▸ Running `pnpm test login`"),
            {
                type: "actions",
                elements: [
                    { type: "button", action_id: stopButtonId("conv-1"), text: { type: "plain_text", text: "⏹️ Stop", emoji: true }, style: "danger", value: "conv-1" },
                    { type: "button", action_id: "intentic:open", text: { type: "plain_text", text: "Open in Intentic" }, url: "https://app.intentic.dev/?conversation=conv-1" },
                ],
            },
        ],
    });
});

test("a finished card is one line, its checklist and the link; the in-progress item in bold", () => {
    const plan = [
        { text: "Reproduce the loop", status: "completed" as const },
        { text: "Fix the redirect guard", status: "in_progress" as const },
    ];
    const card = drawn({ progress: progress({ ended: true, stepCount: 14, plan }), now: 192_000 });
    expect(card.text).toBe("✅ Done · 3m 12s · 14 steps");
    expect(card.blocks).toMatchObject([
        section("✅ *Done* · 3m 12s · 14 steps"),
        section("*Plan*\n✅ Reproduce the loop\n▸ *Fix the redirect guard*"),
        { type: "actions", elements: [{ text: { text: "Open in Intentic" } }] },
    ]);
});

test("a wake parked for a person says why, with no buttons; Stop pressed says who", () => {
    const held = renderCard({ progress: notOpened({ held: "Needs the owner's approval.", ended: true }), now: 0, detail: "steps" });
    expect(held).toEqual({ text: "✋ Waiting for approval", blocks: [{ ...section("✋ *Waiting for approval*\nNeeds the owner's approval."), block_id: STATUS_BLOCK_ID }] });
    expect(drawn({ progress: progress({ ended: true }), stoppedBy: "Mark <admin>" }).blocks[0]).toMatchObject(section("⏹️ *Stopped* by Mark &lt;admin&gt; · 1m 12s"));
});

test("what the agent's work quotes cannot break out of its code span or the card's markup", () => {
    const steps = [{ id: "1", tool: "Bash", kind: "execute" as const, target: "echo `<!channel>` && rm -rf x", status: "running" as const }];
    expect(drawn({ progress: progress({ steps, stepCount: 1 }) }).blocks[1]).toEqual(context("▸ Running `echo ˋ&lt;!channel&gt;ˋ &amp;&amp; rm -rf x`"));
    expect(escapeMrkdwn("a<b>&c")).toBe("a&lt;b&gt;&amp;c");
});
