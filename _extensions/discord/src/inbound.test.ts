import { type IncomingMessage, type OurSide, routeOf, threadNameOf } from "./inbound.js";

const ours = (joined: readonly string[] = []): OurSide => ({ botIds: new Set(["111"]), joined: (id) => joined.includes(id) });

const heard = (over: Partial<IncomingMessage>): IncomingMessage => ({
    id: "m1",
    channelId: "c1",
    content: "<@111> the login redirect loops on Safari, can you fix it?",
    authorName: "alice",
    mentionsUs: true,
    channel: { kind: "threadable" },
    ...over,
});

test("a mention in a channel opens a thread of its own, named after the message and carrying its id", () => {
    expect(routeOf(heard({}), ours())).toEqual({
        addressed: true,
        channelId: "c1",
        thread: "m1",
        room: "c1",
        opens: { parentId: "c1", messageId: "m1", name: "the login redirect loops on Safari, can you fix it?" },
    });
});

test("a message in a channel that does not mention us is not for us, and opens nothing", () => {
    expect(routeOf(heard({ mentionsUs: false }), ours())).toEqual({ addressed: false, channelId: "c1", room: "c1" });
});

test("in a thread we opened or answered in, nobody has to mention us; the channel filter names the thread's channel", () => {
    const inOurs = heard({ id: "m9", channelId: "t1", mentionsUs: false, channel: { kind: "thread", parentId: "c1", ownerId: "111" } });
    expect(routeOf(inOurs, ours())).toEqual({ addressed: true, channelId: "c1", thread: "t1", room: "t1" });
    const inJoined = heard({ id: "m9", channelId: "t2", mentionsUs: false, channel: { kind: "thread", parentId: "c1", ownerId: "someone" } });
    expect(routeOf(inJoined, ours(["t2"])).addressed).toBe(true);
    expect(routeOf(inJoined, ours()).addressed).toBe(false);
});

test("a direct message is always for us and stays in the conversation it is", () => {
    expect(routeOf(heard({ channelId: "dm1", mentionsUs: false, channel: { kind: "dm" } }), ours())).toEqual({ addressed: true, channelId: "dm1", room: "dm1" });
});

test("a mention where no thread can be opened is answered where it was said", () => {
    expect(routeOf(heard({ channel: { kind: "other" } }), ours())).toEqual({ addressed: true, channelId: "c1", room: "c1" });
});

test("a thread's name is the message's first readable line, cut at a word, or the asker when nothing readable is left", () => {
    expect(threadNameOf("<@123> **fix** the `build`\nmore detail", "alice")).toBe("fix the build");
    expect(threadNameOf("<@123> <:party:999>", "alice")).toBe("Request from alice");
    const long = threadNameOf(`<@1> ${"word ".repeat(40)}`, "alice");
    expect(long.length).toBeLessThanOrEqual(81);
    expect(long.endsWith("…")).toBe(true);
    expect(long).not.toContain("  ");
});
