import type { ListenerDispatchFrame, Logger } from "@intentic/connector-runtime";
import { waitFor } from "@intentic/testing/bun";
import type { RequestData, RouteLike } from "discord.js";
import type { DiscordRest } from "./discord-rest.js";
import { routeOf } from "./inbound.js";
import { createMessageReply, EMOJI, LOST_NOTICE, type ReplyRegistry, type ReplyTiming, type RunControl } from "./reply.js";

// One addressed message's answer, against a recording fake of Discord's REST: what was posted where, in what order.

interface Call {
    readonly method: "get" | "post" | "patch" | "put" | "delete";
    readonly route: string;
    readonly body?: unknown;
}

const fakeDiscord = (options: { readonly threadsRefused?: boolean } = {}) => {
    const calls: Call[] = [];
    let posted = 0;
    const record = (method: Call["method"], route: RouteLike, data?: RequestData): void => {
        calls.push(data?.body === undefined ? { method, route } : { method, route, body: data.body });
    };
    const rest: DiscordRest = {
        get: async (route, data) => {
            record("get", route, data);
            return {};
        },
        post: async (route, data) => {
            record("post", route, data);
            if (route.endsWith("/threads")) {
                if (options.threadsRefused === true) {
                    throw new Error("Missing Permissions");
                }
                // Discord gives a thread started from a message that message's id.
                return { id: route.split("/")[4] };
            }
            posted += 1;
            return { id: `p${posted}` };
        },
        patch: async (route, data) => {
            record("patch", route, data);
            return {};
        },
        put: async (route, data) => {
            record("put", route, data);
            return undefined;
        },
        delete: async (route, data) => {
            record("delete", route, data);
            return undefined;
        },
    };
    // SAFETY: every message body this reply posts is a plain object with optional content and embeds.
    const bodyOf = (call: Call) => (call.body ?? {}) as { content?: string; embeds?: Array<{ description: string }>; message_reference?: { message_id: string } };
    return {
        rest,
        calls,
        // What was posted into a room, in order: text, or a card's first line.
        postedIn: (room: string): string[] =>
            calls
                .filter((call) => call.method === "post" && call.route === `/channels/${room}/messages`)
                .map((call) => bodyOf(call).content ?? `card: ${(bodyOf(call).embeds?.[0]?.description ?? "").split("\n")[0]}`),
        // How the status card read after its last edit.
        lastCard: (): string | undefined => {
            const edits = calls.filter((call) => (call.method === "patch" || call.method === "post") && bodyOf(call).embeds !== undefined);
            const last = edits.at(-1);
            return last === undefined ? undefined : bodyOf(last).embeds?.[0]?.description;
        },
        reactions: (messageId: string): string[] =>
            calls
                .filter((call) => call.route.includes(`/messages/${messageId}/reactions/`))
                .map((call) => `${call.method === "put" ? "+" : "-"}${decodeURIComponent(call.route.split("/reactions/")[1]?.split("/")[0] ?? "")}`),
        bodyOf,
    };
};

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

const registry = (): ReplyRegistry & { readonly runs: Map<string, RunControl> } => {
    const runs = new Map<string, RunControl>();
    const rooms = new Map<string, RunControl>();
    return {
        runs,
        opened: (conversationId, room, run) => {
            runs.set(conversationId, run);
            rooms.set(room, run);
        },
        closed: (conversationId, room) => {
            runs.delete(conversationId);
            rooms.delete(room);
        },
        running: (room) => rooms.get(room),
    };
};

const mention = routeOf(
    { id: "m1", channelId: "c1", content: "<@bot> fix the login redirect", authorName: "alice", mentionsUs: true, channel: { kind: "threadable" } },
    { botIds: new Set(["bot"]), joined: () => false },
);

const replyTo = (discord: ReturnType<typeof fakeDiscord>, runs = registry(), route = mention, messageId = "m1", channelId = "c1") =>
    createMessageReply({ rest: discord.rest, log: quiet, detail: "steps", registry: runs, joined: () => {}, timing: FAST }, { messageId, channelId, authorId: "u1", route });

const frame = (over: Partial<ListenerDispatchFrame>): ListenerDispatchFrame => ({ automationId: "a", ...over });

test("a mention opens a thread, shows a card once the work outlasts a quick answer, and posts the reply below it", async () => {
    const discord = fakeDiscord();
    const reply = replyTo(discord);
    reply.frame(frame({ opened: { conversationId: "conv-1", link: "https://app.intentic.dev/?conversation=conv-1" } }));
    reply.frame(frame({ delta: "Let me look at the auth module." }));
    reply.frame(frame({ step: { id: "t1", tool: "Read", kind: "read", target: "src/auth.ts", status: "running" } }));
    await waitFor(() => expect(discord.lastCard()).toContain("⚙️ **Working**"));
    reply.frame(frame({ step: { id: "t1", tool: "Read", kind: "read", target: "src/auth.ts", status: "done" } }));
    reply.frame(frame({ delta: "Fixed: the guard compared the wrong origin.\n\n```ts\nconst same = url.origin === location.origin;\n```" }));
    reply.frame(frame({ end: true }));
    await reply.settle();

    // The thread is opened from the message before anything is said in it, and the asker is put in it.
    const opened = discord.calls.findIndex((call) => call.route === "/channels/c1/messages/m1/threads");
    const firstPost = discord.calls.findIndex((call) => call.method === "post" && call.route === "/channels/m1/messages");
    expect(opened).toBeGreaterThan(-1);
    expect(opened).toBeLessThan(firstPost);
    expect(discord.calls.some((call) => call.method === "put" && call.route === "/channels/m1/thread-members/u1")).toBe(true);
    // The short line before the agent acted went on the card; the reply itself is one message, code block intact.
    expect(discord.postedIn("m1")).toEqual([
        "card: ⚙️ **Working** · 0s",
        "Fixed: the guard compared the wrong origin.\n\n```ts\nconst same = url.origin === location.origin;\n```",
    ]);
    expect(discord.lastCard()?.startsWith("✅ **Done**")).toBe(true);
    expect(discord.reactions("m1")).toEqual([`+${EMOJI.heard}`, `+${EMOJI.done}`, `-${EMOJI.heard}`]);
    // Nothing went onto the channel itself.
    expect(discord.postedIn("c1")).toEqual([]);
});

test("a quick answer posts no card at all, just the reply and a check", async () => {
    const discord = fakeDiscord();
    const reply = replyTo(discord);
    reply.frame(frame({ opened: { conversationId: "conv-2" } }));
    reply.frame(frame({ delta: "It's in `src/auth.ts`." }));
    reply.frame(frame({ end: true }));
    await reply.settle();
    expect(discord.postedIn("m1")).toEqual(["It's in `src/auth.ts`."]);
    expect(discord.lastCard()).toBeUndefined();
    expect(discord.reactions("m1").at(-2)).toBe(`+${EMOJI.done}`);
});

test("a wake held for approval says so on a card at once, and keeps ✋ after the stream ends", async () => {
    const discord = fakeDiscord();
    const reply = replyTo(discord);
    reply.frame(frame({ held: "This needs the owner's approval before I start on it." }));
    reply.frame(frame({ end: true }));
    await reply.settle();
    expect(discord.lastCard()).toBe("✋ **Waiting for approval**\nThis needs the owner's approval before I start on it.");
    expect(discord.reactions("m1")).toEqual([`+${EMOJI.heard}`, `+${EMOJI.held}`, `-${EMOJI.heard}`]);
});

test("a failed turn says why in the thread and marks the message ❌", async () => {
    const discord = fakeDiscord();
    const reply = replyTo(discord);
    reply.frame(frame({ opened: { conversationId: "conv-3" } }));
    reply.frame(frame({ failed: "the model provider is at capacity" }));
    reply.frame(frame({ end: true }));
    await reply.settle();
    expect(discord.postedIn("m1")).toEqual(["⚠️ the model provider is at capacity"]);
    expect(discord.reactions("m1")).toContain(`+${EMOJI.failed}`);
});

test("a message nothing answered opens no thread, and its 👀 is taken back", async () => {
    const discord = fakeDiscord();
    const reply = replyTo(discord);
    await reply.settle();
    expect(discord.calls.some((call) => call.route.endsWith("/threads"))).toBe(false);
    expect(discord.reactions("m1")).toEqual([`+${EMOJI.heard}`, `-${EMOJI.heard}`]);
});

test("where no thread can be opened, the answer goes into the channel, quoting the message it answers", async () => {
    const discord = fakeDiscord({ threadsRefused: true });
    const reply = replyTo(discord);
    reply.frame(frame({ opened: { conversationId: "conv-4" } }));
    reply.frame(frame({ delta: "Done." }));
    reply.frame(frame({ end: true }));
    await reply.settle();
    const post = discord.calls.find((call) => call.method === "post" && call.route === "/channels/c1/messages");
    expect(post === undefined ? undefined : discord.bodyOf(post)).toMatchObject({ content: "Done.", message_reference: { message_id: "m1" } });
});

test("a message steered into a running turn takes its reactions from that turn", async () => {
    const discord = fakeDiscord();
    const runs = registry();
    const first = replyTo(discord, runs);
    first.frame(frame({ opened: { conversationId: "conv-5" } }));
    const inThread = routeOf(
        { id: "m2", channelId: "m1", content: "also check the docs", authorName: "bob", mentionsUs: false, channel: { kind: "thread", parentId: "c1", ownerId: "bot" } },
        { botIds: new Set(["bot"]), joined: () => false },
    );
    const followUp = replyTo(discord, runs, inThread, "m2", "m1");
    followUp.frame(frame({ steered: true }));
    followUp.frame(frame({ end: true }));
    await followUp.settle();
    // Heard, and nothing more yet: the turn that took it has not answered.
    expect(discord.reactions("m2")).toEqual([`+${EMOJI.heard}`]);
    first.frame(frame({ delta: "Checked the docs too." }));
    first.frame(frame({ end: true }));
    await first.settle();
    expect(discord.reactions("m2")).toEqual([`+${EMOJI.heard}`, `+${EMOJI.done}`, `-${EMOJI.heard}`]);
});

test("Stop marks who pressed it on the card, and the message ends ⏹️", async () => {
    const discord = fakeDiscord();
    const runs = registry();
    const reply = replyTo(discord, runs);
    reply.frame(frame({ opened: { conversationId: "conv-6", link: "https://app.intentic.dev/?conversation=conv-6" } }));
    reply.frame(frame({ step: { id: "t1", tool: "Bash", kind: "execute", target: "pnpm test", status: "running" } }));
    await waitFor(() => expect(discord.lastCard()).toContain("Running `pnpm test`"));
    runs.runs.get("conv-6")?.stopping("Mark");
    await waitFor(() => expect(discord.lastCard()).toContain("⏹️ **Stopping** by Mark"));
    reply.frame(frame({ end: true }));
    await reply.settle();
    expect(discord.lastCard()?.startsWith("⏹️ **Stopped** by Mark")).toBe(true);
    expect(discord.reactions("m1")).toContain(`+${EMOJI.stopped}`);
});

test("a stream that breaks before its turn ends leaves no card working forever: the thread is told, and the message ❌", async () => {
    const discord = fakeDiscord();
    const reply = replyTo(discord);
    reply.frame(frame({ opened: { conversationId: "conv-7" } }));
    reply.frame(frame({ step: { id: "t1", tool: "Bash", kind: "execute", target: "pnpm build", status: "running" } }));
    await waitFor(() => expect(discord.lastCard()).toContain("Running `pnpm build`"));
    await reply.settle();
    expect(discord.postedIn("m1").at(-1)).toBe(`⚠️ ${LOST_NOTICE}`);
    expect(discord.lastCard()?.startsWith("❌ **Failed**")).toBe(true);
    expect(discord.reactions("m1")).toContain(`+${EMOJI.failed}`);
});
