import type { TurnProgress } from "@intentic/connector-runtime";
import { type CardView, progressDetailOf, renderCard, STEPS_SHOWN, stopTarget } from "./card.js";

const OPENED: Pick<TurnProgress, "opened" | "openedAt"> = {
    openedAt: 0,
    opened: { conversationId: "conv-1", link: "https://app.intentic.dev/?sandbox=s1&conversation=conv-1" },
};

// A turn's progress before it opened, and once it has.
const notOpened = (over: Partial<TurnProgress> = {}): TurnProgress => ({ startedAt: 0, steps: [], stepCount: 0, writing: false, ended: false, ...over });
const progress = (over: Partial<TurnProgress> = {}): TurnProgress => notOpened({ ...OPENED, ...over });

const card = (over: Partial<CardView>) => {
    const body = renderCard({ progress: progress(), now: 72_000, detail: "steps", ...over });
    // SAFETY: renderCard draws exactly one embed with a description and a color.
    const embed = (body.embeds ?? [])[0] as { description: string; color: number };
    // SAFETY: renderCard draws at most one row of buttons, each with a label and a style.
    const row = (body.components ?? [])[0] as { components: Array<{ label: string; style: number; custom_id?: string; url?: string }> } | undefined;
    return { description: embed.description, color: embed.color, buttons: row?.components ?? [] };
};

test("a working card leads with the elapsed time, lists the last steps oldest first, and offers Stop and the link", () => {
    const steps = [
        { id: "1", tool: "Read", kind: "read" as const, target: "src/auth/redirect.ts", status: "done" as const },
        { id: "2", tool: "Edit", kind: "edit" as const, target: "src/auth/login.ts", status: "done" as const },
        { id: "3", tool: "Bash", kind: "execute" as const, target: "pnpm test login", status: "running" as const },
    ];
    const drawn = card({ progress: progress({ steps, stepCount: 3 }), headline: "Found it: the guard compares the wrong origin." });
    expect(drawn.description.split("\n")).toEqual([
        "⚙️ **Working** · 1m 12s",
        "> *Found it: the guard compares the wrong origin.*",
        "✓ Read `src/auth/redirect.ts`",
        "✓ Edited `src/auth/login.ts`",
        "▸ Running `pnpm test login`",
    ]);
    expect(drawn.buttons.map((button) => [button.label, button.style])).toEqual([
        ["Stop", 4],
        ["Open in Intentic", 5],
    ]);
    expect(stopTarget(drawn.buttons[0]?.custom_id ?? "")).toBe("conv-1");
    expect(drawn.buttons[1]?.url).toBe("https://app.intentic.dev/?sandbox=s1&conversation=conv-1");
});

test("past the steps it shows, a card counts the earlier ones; quiet drops what each touched; idle says what it is doing", () => {
    const steps = Array.from({ length: STEPS_SHOWN + 3 }, (_, index) => ({ id: `${index}`, tool: "Read", kind: "read" as const, target: `f${index}.ts`, status: "done" as const }));
    const drawn = card({ progress: progress({ steps, stepCount: steps.length, writing: true }), detail: "quiet" });
    const lines = drawn.description.split("\n");
    expect(lines[1]).toBe("*… 3 earlier steps*");
    expect(lines.filter((line) => line === "✓ Read")).toHaveLength(STEPS_SHOWN);
    expect(drawn.description).not.toContain("f8.ts");
    expect(lines.at(-1)).toBe("✍️ Writing the reply…");
});

test("the checklist follows the steps, the item in progress in bold", () => {
    const drawn = card({
        progress: progress({
            plan: [
                { text: "Reproduce the loop", status: "completed" },
                { text: "Fix the redirect guard", status: "in_progress" },
                { text: "Add a regression test", status: "pending" },
            ],
        }),
    });
    expect(drawn.description.split("\n").slice(-4)).toEqual(["**Plan**", "✅ Reproduce the loop", "▸ **Fix the redirect guard**", "▢ Add a regression test"]);
});

test("a finished card is one line and the link: done with its step count, failed, or stopped by whom", () => {
    const done = card({ progress: progress({ ended: true, stepCount: 14 }), now: 192_000 });
    expect(done.description).toBe("✅ **Done** · 3m 12s · 14 steps");
    expect(done.buttons.map((button) => button.label)).toEqual(["Open in Intentic"]);
    expect(card({ progress: progress({ ended: true, failed: "the model refused" }) }).description).toBe("❌ **Failed** · 1m 12s");
    expect(card({ progress: progress({ ended: true }), stoppedBy: "Mark" }).description).toBe("⏹️ **Stopped** by Mark · 1m 12s");
    // Pressed, still winding down: no second Stop.
    const stopping = card({ progress: progress(), stoppedBy: "Mark" });
    expect(stopping.description).toBe("⏹️ **Stopping** by Mark · 1m 12s");
    expect(stopping.buttons.map((button) => button.label)).toEqual(["Open in Intentic"]);
});

test("a wake parked for a person says so, and keeps saying so after its stream ended; a queued one says why it waits", () => {
    expect(card({ progress: notOpened({ held: "Needs the owner's approval.", ended: true }) })).toEqual({
        description: "✋ **Waiting for approval**\nNeeds the owner's approval.",
        color: 0xf0b232,
        buttons: [],
    });
    expect(card({ progress: notOpened({ queued: "Another task is running." }) }).description).toBe("⏳ **Queued**\nAnother task is running.");
});

test("the progress setting reads anything unknown as the full card", () => {
    expect(progressDetailOf(undefined)).toBe("steps");
    expect(progressDetailOf("quiet")).toBe("quiet");
    expect(progressDetailOf("off")).toBe("off");
    expect(progressDetailOf("loud")).toBe("steps");
    expect(stopTarget("intentic:stop:")).toBeUndefined();
    expect(stopTarget("something-else")).toBeUndefined();
});
