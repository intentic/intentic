import type { ListenerDispatchFrame } from "@intentic/sandbox-contract/protocol/doors/listener-protocol";
import { waitFor } from "@intentic/testing/bun";
import { type ChatSurface, createChatReply, LOST_NOTICE, type ReplyTiming } from "./chat-reply.js";
import { runRegistry } from "./chat-runs.js";
import type { Logger } from "./log.js";
import { type CardView, statusCardOf } from "./status-card.js";

// One addressed message's answer, against a surface that records what it was asked to do, in order: the lifecycle every
// chat platform shares, with no platform in it.

const FAST: ReplyTiming = {
    cardAfterMs: 20,
    editEveryMs: 5,
    refreshEveryMs: 10_000,
    typingEveryMs: 10_000,
    typingMaxMs: 60_000,
    mentionAfterMs: 60_000,
    now: Date.now,
};

const quiet: Logger = { info: () => {}, warn: () => {}, error: () => {} };

const fakeSurface = (options: { readonly maxChars?: number } = {}) => {
    const log: string[] = [];
    const cards: CardView[] = [];
    let typingCleared = 0;
    let typingSaid = 0;
    const surface: ChatSurface<number> = {
        maxChars: options.maxChars ?? 2_000,
        prepare: async () => void log.push("prepare"),
        post: async (text, { mention }) => void log.push(`post${mention ? " @asker" : ""}: ${text}`),
        postCard: async (view) => {
            cards.push(view);
            log.push(`card: ${statusCardOf(view).state}`);
            return cards.length;
        },
        editCard: async (_card, view) => {
            cards.push(view);
        },
        mark: async (message, mark) => void log.push(`+${mark} ${message.id}`),
        unmark: async (message, mark) => void log.push(`-${mark} ${message.id}`),
        typing: {
            say: async () => void (typingSaid += 1),
            clear: async () => void (typingCleared += 1),
        },
    };
    return {
        surface,
        log,
        lastCard: () => {
            const last = cards.at(-1);
            return last === undefined ? undefined : statusCardOf(last);
        },
        marks: (id: string) => log.filter((line) => line.endsWith(` ${id}`) && (line.startsWith("+") || line.startsWith("-"))).map((line) => line.split(" ")[0]),
        typing: () => ({ said: typingSaid, cleared: typingCleared }),
    };
};

const frame = (over: Partial<ListenerDispatchFrame>): ListenerDispatchFrame => ({ automationId: "a", ...over });

const replyTo = (fake: ReturnType<typeof fakeSurface>, runs = runRegistry(), message = { channelId: "c1", id: "m1" }, onTaken: () => void = () => {}) =>
    createChatReply({ provider: "test", surface: fake.surface, log: quiet, detail: "steps", registry: runs, timing: FAST }, { message, place: "t1", onTaken });

test("a quick answer posts no card, just the reply, and marks the message done", async () => {
    const fake = fakeSurface();
    const reply = replyTo(fake);
    reply.frame(frame({ opened: { conversationId: "conv-1" } }));
    reply.frame(frame({ delta: "It's in `src/auth.ts`." }));
    reply.frame(frame({ end: true }));
    await reply.settle();
    expect(fake.log).toEqual(["+heard m1", "prepare", "post: It's in `src/auth.ts`.", "+done m1", "-heard m1"]);
    expect(fake.typing()).toEqual({ said: 1, cleared: 1 });
});

test("work that outlasts a quick answer gets a card; narration goes on it and the answer is posted below", async () => {
    const fake = fakeSurface();
    const reply = replyTo(fake);
    reply.frame(frame({ opened: { conversationId: "conv-2", link: "https://app.intentic.dev/?conversation=conv-2" } }));
    reply.frame(frame({ delta: "Let me look at the auth module." }));
    reply.frame(frame({ step: { id: "s1", tool: "Read", kind: "read", target: "src/auth.ts", status: "running" } }));
    await waitFor(() => expect(fake.lastCard()?.state).toBe("working"));
    await waitFor(() => expect(fake.lastCard()?.headline).toBe("Let me look at the auth module."));
    expect(fake.lastCard()?.stop).toBe("conv-2");
    reply.frame(frame({ step: { id: "s1", tool: "Read", kind: "read", target: "src/auth.ts", status: "done" } }));
    reply.frame(frame({ delta: "Fixed: the guard compared the wrong origin.\n\n```ts\nconst same = true;\n```" }));
    reply.frame(frame({ end: true }));
    await reply.settle();
    // The thread is prepared once, before the card, and the narration never became a message of its own.
    expect(fake.log.filter((line) => line === "prepare")).toHaveLength(1);
    expect(fake.log.indexOf("prepare")).toBeLessThan(fake.log.indexOf("card: working"));
    expect(fake.log.filter((line) => line.startsWith("post"))).toEqual(["post: Fixed: the guard compared the wrong origin.\n\n```ts\nconst same = true;\n```"]);
    expect(fake.lastCard()).toMatchObject({ state: "done", live: false, link: "https://app.intentic.dev/?conversation=conv-2" });
    expect(fake.lastCard()?.stop).toBeUndefined();
});

test("a reply past the surface's ceiling is posted as several messages, code blocks kept whole", async () => {
    const fake = fakeSurface({ maxChars: 60 });
    const reply = replyTo(fake);
    reply.frame(frame({ opened: { conversationId: "conv-3" } }));
    reply.frame(frame({ delta: `${"First paragraph is here. ".repeat(2)}\n\n\`\`\`ts\nconst a = 1;\nconst b = 2;\n\`\`\`` }));
    reply.frame(frame({ end: true }));
    await reply.settle();
    const posts = fake.log.filter((line) => line.startsWith("post: ")).map((line) => line.slice("post: ".length));
    expect(posts.length).toBeGreaterThan(1);
    expect(posts.every((post) => post.length <= 60)).toBe(true);
    expect(posts.every((post) => (post.match(/```/g) ?? []).length % 2 === 0)).toBe(true);
});

test("a wake held for approval shows a card at once and ends held; the thread counts as taken", async () => {
    const fake = fakeSurface();
    let taken = 0;
    const reply = replyTo(fake, runRegistry(), { channelId: "c1", id: "m1" }, () => (taken += 1));
    reply.frame(frame({ held: "This needs the owner's approval before I start on it." }));
    reply.frame(frame({ end: true }));
    await reply.settle();
    expect(fake.lastCard()).toMatchObject({ state: "held", note: "This needs the owner's approval before I start on it." });
    expect(fake.marks("m1")).toEqual(["+heard", "+held", "-heard"]);
    expect(taken).toBe(1);
});

test("a failed turn says why, and the message ends failed", async () => {
    const fake = fakeSurface();
    const reply = replyTo(fake);
    reply.frame(frame({ opened: { conversationId: "conv-4" } }));
    reply.frame(frame({ failed: "the model provider is at capacity" }));
    reply.frame(frame({ end: true }));
    await reply.settle();
    expect(fake.log).toContain("post: ⚠️ the model provider is at capacity");
    expect(fake.marks("m1")).toContain("+failed");
});

test("a message nothing answered is never prepared for, and its heard mark is taken back", async () => {
    const fake = fakeSurface();
    let taken = 0;
    const reply = replyTo(fake, runRegistry(), { channelId: "c1", id: "m1" }, () => (taken += 1));
    await reply.settle();
    expect(fake.log).toEqual(["+heard m1", "-heard m1"]);
    expect(taken).toBe(0);
});

test("a message steered into a running turn takes its marks from that turn", async () => {
    const fake = fakeSurface();
    const runs = runRegistry();
    const first = replyTo(fake, runs);
    first.frame(frame({ opened: { conversationId: "conv-5" } }));
    const followUp = replyTo(fake, runs, { channelId: "t1", id: "m2" });
    followUp.frame(frame({ steered: true }));
    followUp.frame(frame({ end: true }));
    await followUp.settle();
    expect(fake.marks("m2")).toEqual(["+heard"]);
    first.frame(frame({ delta: "Checked the docs too." }));
    first.frame(frame({ end: true }));
    await first.settle();
    expect(fake.marks("m2")).toEqual(["+heard", "+done", "-heard"]);
});

test("Stop names who pressed it on the card, and the message ends stopped", async () => {
    const fake = fakeSurface();
    const runs = runRegistry();
    const reply = replyTo(fake, runs);
    reply.frame(frame({ opened: { conversationId: "conv-6" } }));
    reply.frame(frame({ step: { id: "s1", tool: "Bash", kind: "execute", target: "pnpm test", status: "running" } }));
    await waitFor(() => expect(fake.lastCard()?.state).toBe("working"));
    runs.byConversation("conv-6")?.stopping("Mark");
    await waitFor(() => expect(fake.lastCard()).toMatchObject({ state: "stopping", stoppedBy: "Mark" }));
    reply.frame(frame({ end: true }));
    await reply.settle();
    expect(fake.lastCard()?.state).toBe("stopped");
    expect(fake.marks("m1")).toContain("+stopped");
    expect(runs.byConversation("conv-6")).toBeUndefined();
});

test("a stream that breaks before its turn ends says so, and leaves no card working", async () => {
    const fake = fakeSurface();
    const reply = replyTo(fake);
    reply.frame(frame({ opened: { conversationId: "conv-7" } }));
    reply.frame(frame({ step: { id: "s1", tool: "Bash", kind: "execute", target: "pnpm build", status: "running" } }));
    await waitFor(() => expect(fake.lastCard()?.state).toBe("working"));
    await reply.settle();
    expect(fake.log).toContain(`post: ⚠️ ${LOST_NOTICE}`);
    expect(fake.lastCard()?.state).toBe("failed");
    expect(fake.marks("m1")).toContain("+failed");
});

test("an answer after a long turn names the asker; one card setting turns cards off", async () => {
    const fake = fakeSurface();
    let now = 0;
    const reply = createChatReply(
        { provider: "test", surface: fake.surface, log: quiet, detail: "off", registry: runRegistry(), timing: { ...FAST, now: () => now } },
        { message: { channelId: "c1", id: "m1" }, place: "t1" },
    );
    reply.frame(frame({ opened: { conversationId: "conv-8" } }));
    reply.frame(frame({ delta: "Looking." }));
    reply.frame(frame({ step: { id: "s1", tool: "Read", kind: "read", target: "a.ts", status: "running" } }));
    now = FAST.mentionAfterMs + 1;
    reply.frame(frame({ delta: "All done." }));
    reply.frame(frame({ end: true }));
    await reply.settle();
    // With cards off, narration is posted as it comes; only the turn's last block names the asker.
    expect(fake.log.filter((line) => line.startsWith("post"))).toEqual(["post: Looking.", "post @asker: All done."]);
    expect(fake.log.some((line) => line.startsWith("card"))).toBe(false);
});
