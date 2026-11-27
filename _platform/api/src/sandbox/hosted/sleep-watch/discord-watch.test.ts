import { pino } from "pino";
import { addressedToBot } from "./discord-frames.js";
import { DISCORD_GATEWAY_URL, DISCORD_WATCH_INTENTS, type HeardMessage, RECONNECT_CODE, watchDiscord } from "./discord-watch.js";
import { fakeGateway, manualClock } from "./sleep-watch.testing.js";

// One bot held while its sandbox sleeps, against a gateway the test plays: it identifies without the privileged intent,
// hands on where a message for the bot is (never its words), heartbeats, resumes, and stops for good on a refusal.

const BOT = "999";
const log = pino({ level: "silent" });
const MESSAGE_CONTENT = 1 << 15;

const setUp = () => {
    const gateway = fakeGateway();
    const clock = manualClock();
    const heard: HeardMessage[] = [];
    const refused: string[] = [];
    const watch = watchDiscord(
        "bot-token",
        { heard: (message) => heard.push(message), refused: (why) => refused.push(why), log },
        { open: gateway.open, after: clock.after, random: () => 0.5, backoffMs: { first: 1_000, max: 8_000 } },
    );
    return { gateway, clock, heard, refused, watch };
};

const connected = () => {
    const world = setUp();
    world.gateway.hello();
    world.gateway.ready(BOT);
    return world;
};

const message = (fields: Record<string, string | boolean | object | null | undefined>) => ({
    id: "5001",
    channel_id: "100",
    guild_id: "1",
    author: { id: "42" },
    content: "",
    mentions: [],
    ...fields,
});

test("identifies with GUILDS, GUILD_MESSAGES and DIRECT_MESSAGES only, never the privileged message content", () => {
    const { gateway, watch } = setUp();
    expect(gateway.last().url).toBe(DISCORD_GATEWAY_URL);
    gateway.hello();
    const identify = gateway.last().sent.find((frame) => frame.op === 2);
    expect(identify?.d).toMatchObject({ token: "bot-token", intents: DISCORD_WATCH_INTENTS });
    expect(DISCORD_WATCH_INTENTS).toBe(1 + 512 + 4096);
    expect(DISCORD_WATCH_INTENTS & MESSAGE_CONTENT).toBe(0);
    expect(watch.state()).toBe("connecting");
    gateway.ready(BOT);
    expect(watch.state()).toBe("ready");
});

test("hands on where a mention, a reply to the bot or a direct message is, and nothing it says", () => {
    const { gateway, heard } = connected();
    gateway.dispatch("MESSAGE_CREATE", message({ id: "1", mentions: [{ id: BOT }], content: "@bot deploy please" }));
    gateway.dispatch("MESSAGE_CREATE", message({ id: "2", referenced_message: { author: { id: BOT } } }));
    // Discord leaves a direct message's server out; a null one reads the same.
    gateway.dispatch("MESSAGE_CREATE", message({ id: "3", guild_id: undefined, channel_id: "200" }));
    gateway.dispatch("MESSAGE_CREATE", message({ id: "4", guild_id: null, channel_id: "201" }));
    expect(heard).toEqual([
        { channelId: "100", messageId: "1", guildId: "1" },
        { channelId: "100", messageId: "2", guildId: "1" },
        { channelId: "200", messageId: "3" },
        { channelId: "201", messageId: "4" },
    ]);
});

test("a message in a thread the bot owns counts with no mention; elsewhere, chatter, bots and webhooks never do", () => {
    const { gateway, heard } = connected();
    gateway.dispatch("GUILD_CREATE", { id: "1", threads: [{ id: "700", owner_id: BOT }, { id: "701", owner_id: "42" }] });
    gateway.dispatch("THREAD_CREATE", { id: "702", owner_id: BOT });
    gateway.dispatch("MESSAGE_CREATE", message({ id: "10", channel_id: "700" }));
    gateway.dispatch("MESSAGE_CREATE", message({ id: "11", channel_id: "702" }));
    gateway.dispatch("MESSAGE_CREATE", message({ id: "12", channel_id: "701" }));
    gateway.dispatch("MESSAGE_CREATE", message({ id: "13" }));
    gateway.dispatch("MESSAGE_CREATE", message({ id: "14", mentions: [{ id: BOT }], author: { id: "77", bot: true } }));
    gateway.dispatch("MESSAGE_CREATE", message({ id: "15", mentions: [{ id: BOT }], webhook_id: "88" }));
    gateway.dispatch("MESSAGE_CREATE", message({ id: "16", mentions: [{ id: BOT }], author: { id: BOT } }));
    gateway.dispatch("THREAD_DELETE", { id: "700" });
    gateway.dispatch("MESSAGE_CREATE", message({ id: "17", channel_id: "700" }));
    expect(heard.map((each) => each.messageId)).toEqual(["10", "11"]);
});

test("nothing is judged before the gateway says who the bot is", () => {
    const { gateway, heard } = setUp();
    gateway.hello();
    gateway.dispatch("MESSAGE_CREATE", message({ guild_id: undefined }));
    expect(heard).toEqual([]);
    expect(addressedToBot({ id: "1", channel_id: "200", guild_id: undefined, author: { id: "42" } }, BOT, new Set())).toBe(true);
});

test("heartbeats on the gateway's interval, and a beat left unanswered reconnects and resumes the session", () => {
    const { gateway, clock } = connected();
    const first = gateway.last();
    gateway.say({ op: 0, t: "MESSAGE_CREATE", s: 7, d: message({}) });
    clock.advance(41_250);
    expect(first.sent.filter((frame) => frame.op === 1)).toEqual([{ op: 1, d: 7 }]);
    gateway.say({ op: 11 });
    clock.advance(41_250);
    expect(first.sent.filter((frame) => frame.op === 1)).toHaveLength(2);
    // No ack for the second beat: the connection is dead.
    clock.advance(41_250);
    expect(first.closedWith).toBe(RECONNECT_CODE);
    clock.advance(1_000);
    const second = gateway.last();
    expect(second).not.toBe(first);
    expect(second.url).toBe("wss://resume.discord.gg/?v=10&encoding=json");
    gateway.hello();
    expect(second.sent.find((frame) => frame.op === 6)?.d).toEqual({ token: "bot-token", session_id: "session-1", seq: 7 });
});

test("Discord's word to reconnect resumes at once; a session it calls gone identifies afresh after a backoff", () => {
    const { gateway, clock } = connected();
    gateway.say({ op: 7 });
    clock.advance(0);
    expect(gateway.sockets).toHaveLength(2);
    expect(gateway.last().url).toContain("resume.discord.gg");
    gateway.close(4009);
    clock.advance(749);
    expect(gateway.sockets).toHaveLength(2);
    clock.advance(1);
    expect(gateway.sockets).toHaveLength(3);
    expect(gateway.last().url).toBe(DISCORD_GATEWAY_URL);
    gateway.hello();
    expect(gateway.last().sent.some((frame) => frame.op === 2)).toBe(true);
});

test("backs off longer after each failure, up to its ceiling, and starts over once it is ready again", () => {
    const { gateway, clock } = setUp();
    const delays: number[] = [];
    for (let attempt = 0; attempt < 5; attempt++) {
        const before = gateway.sockets.length;
        gateway.close(1006);
        let waited = 0;
        while (gateway.sockets.length === before) {
            clock.advance(250);
            waited += 250;
        }
        delays.push(waited);
    }
    // 0.75 of 1s, 2s, 4s, 8s, then the 8s ceiling, rounded up to the clock's step.
    expect(delays).toEqual([750, 1_500, 3_000, 6_000, 6_000]);
    gateway.hello();
    gateway.ready(BOT);
    gateway.close(1006);
    clock.advance(750);
    expect(gateway.sockets).toHaveLength(7);
});

test("a token Discord refuses ends the watch for good, and says why", () => {
    const { gateway, clock, refused, watch } = connected();
    gateway.close(4004);
    expect(refused).toEqual(["Discord refused the bot token (4004)"]);
    expect(watch.state()).toBe("stopped");
    clock.advance(10 * 60_000);
    expect(gateway.sockets).toHaveLength(1);
});

test("closing stops it: the socket is closed, and nothing reconnects or beats after", () => {
    const { gateway, clock, watch } = connected();
    watch.close();
    expect(gateway.last().closedWith).toBe(RECONNECT_CODE);
    clock.advance(10 * 60_000);
    expect(gateway.sockets).toHaveLength(1);
    expect(gateway.last().sent.filter((frame) => frame.op === 1)).toEqual([]);
});
