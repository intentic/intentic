import { GatewayRefusal } from "@intentic/connector-runtime";
import { type Client, DiscordAPIError, type Message, type REST } from "discord.js";
import { authorOf, type ChannelLookup, clientLookup, deliverToChannel, restLookup, toHistory } from "./listener.js";

// A fetched discord message, only the fields toHistory reads.
const msg = (id: string, authorId: string, name: string, content: string): Message =>
    ({ id, author: { id: authorId, username: name }, content, createdAt: new Date(`2026-07-08T13:${id}:00.000Z`) }) as unknown as Message;

test("toHistory reverses newest-first fetch into chronological order and flags our own bots", () => {
    // discord.js fetch returns newest-first: the bot's reply, then the two user lines before it.
    const newestFirst = [
        msg("35", "bot", "intentic", "Hey! How can I help you?"),
        msg("34", "u1", "radarsu", "what model?"),
        msg("33", "u1", "radarsu", "yo"),
    ];
    const history = toHistory(newestFirst, new Set(["bot"]));

    expect(history.map((h) => h.content)).toEqual(["yo", "what model?", "Hey! How can I help you?"]);
    expect(history.map((h) => h.self)).toEqual([undefined, undefined, true]);
});

// A guild message as authorOf reads it: the user, and the member's role cache (a Map, like discord.js's Collection).
const guildMessage = (roleIds: readonly string[]): Pick<Message, "author" | "member"> =>
    ({
        author: { id: "u1", username: "radarsu" },
        member: { roles: { cache: new Map(roleIds.map((id) => [id, { id }])) } },
    }) as unknown as Pick<Message, "author" | "member">;

test("authorOf names the sender by id and carries the member's role ids as groups", () => {
    expect(authorOf(guildMessage(["guild-1", "role-staff"]))).toEqual({ id: "u1", name: "radarsu", groups: ["guild-1", "role-staff"] });
});

test("authorOf carries no groups for a DM, which has no member", () => {
    const dm = { author: { id: "u1", username: "radarsu" }, member: null } as unknown as Pick<Message, "author" | "member">;
    expect(authorOf(dm)).toEqual({ id: "u1", name: "radarsu" });
});

/* WHO CAN POST HERE, as Discord answers it: a bot Discord says cannot see the channel is passed over, while an outage
 * is not an answer about the channel at all and must not read as "no bot can post in this channel". */
const deliveringBot = (fetched: () => Promise<unknown>): ChannelLookup => clientLookup({ channels: { fetch: fetched } } as unknown as Client);

const channelThatRecords = (sent: string[]) => ({ guildId: "g1", send: async (content: string) => ({ id: `m${sent.push(content)}` }) });

test("deliverToChannel passes over a bot Discord says cannot see the channel, and posts through the next", async () => {
    const sent: string[] = [];
    const hidden = new DiscordAPIError({ code: 50001, message: "Missing Access" }, 50001, 403, "GET", "/channels/c1", { body: undefined, files: undefined });
    const bots = [deliveringBot(() => Promise.reject(hidden)), deliveringBot(async () => channelThatRecords(sent))];
    expect(await deliverToChannel(bots, "c1", "hello")).toEqual({ url: "https://discord.com/channels/g1/c1/m1" });
    expect(sent).toEqual(["hello"]);
});

test("deliverToChannel lets an outage through instead of reading it as a channel no bot can post in", async () => {
    const sent: string[] = [];
    const bots = [deliveringBot(() => Promise.reject(new Error("connect ETIMEDOUT")))];
    await expect(deliverToChannel(bots, "c1", "hello")).rejects.toThrow("connect ETIMEDOUT");
    expect(sent).toEqual([]);
});

test("a reply past Discord's ceiling goes out as consecutive messages, linked by the first", async () => {
    const sent: string[] = [];
    const delivered = await deliverToChannel([deliveringBot(async () => channelThatRecords(sent))], "c1", `${"a".repeat(2_000)  }b`);
    expect(sent).toEqual(["a".repeat(2_000), "b"]);
    expect(delivered).toEqual({ url: "https://discord.com/channels/g1/c1/m1" });
});

test("when no bot can see the channel, or there is no bot at all, the refusal says which", async () => {
    const hidden = new DiscordAPIError({ code: 10003, message: "Unknown Channel" }, 10003, 404, "GET", "/channels/c1", { body: undefined, files: undefined });
    const nowhere = deliverToChannel([deliveringBot(() => Promise.reject(hidden))], "c1", "hello");
    await expect(nowhere).rejects.toThrow(new GatewayRefusal("no connected Discord bot can post in this channel"));
    await expect(deliverToChannel([], "c1", "hello")).rejects.toThrow("Discord isn't connected in this workspace, so there is no bot to post as.");
});

/* WITH NO CLIENT CONNECTED (no automation holds one), a delivery goes over the bot token's REST handle: the channel is
 * looked up first, for the same "can this bot see it" answer and for the guild a link needs. */
const fakeRest = (channel: () => Promise<{ id: string; guild_id?: string }>, posted: { route: string; body: unknown }[]): Pick<REST, "get" | "post"> => ({
    get: channel,
    post: async (route, options) => {
        posted.push({ route, body: options?.body });
        return { id: "m9" };
    },
});

test("a token-only bot posts over REST and links to the message in its guild", async () => {
    const posted: { route: string; body: unknown }[] = [];
    const delivered = await deliverToChannel([restLookup(fakeRest(async () => ({ id: "c1", guild_id: "g7" }), posted))], "c1", "approved post");
    expect(posted).toEqual([{ route: "/channels/c1/messages", body: { content: "approved post" } }]);
    expect(delivered).toEqual({ url: "https://discord.com/channels/g7/c1/m9" });
});

test("a token-only bot Discord refuses the channel to is passed over for the next", async () => {
    const posted: { route: string; body: unknown }[] = [];
    const missing = new DiscordAPIError({ code: 50001, message: "Missing Access" }, 50001, 403, "GET", "/channels/c1", { body: undefined, files: undefined });
    const blind = restLookup(fakeRest(() => Promise.reject(missing), posted));
    const sees = restLookup(fakeRest(async () => ({ id: "c1" }), posted));
    expect(await deliverToChannel([blind, sees], "c1", "hi")).toEqual({ url: "https://discord.com/channels/@me/c1/m9" });
    expect(posted).toHaveLength(1);
});

test("Discord's own refusal of the post reaches the owner in its words, after every bot was tried", async () => {
    const forbidden = new DiscordAPIError({ code: 50013, message: "Missing Permissions" }, 50013, 403, "POST", "/channels/c1/messages", {
        body: undefined,
        files: undefined,
    });
    const refusing = deliveringBot(async () => ({ guildId: "g1", send: () => Promise.reject(forbidden) }));
    await expect(deliverToChannel([refusing], "c1", "hi")).rejects.toThrow(
        new GatewayRefusal("Discord refused the message (HTTP 403): Missing Permissions"),
    );
});
