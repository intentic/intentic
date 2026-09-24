import { type Client, DiscordAPIError, type Message } from "discord.js";
import { authorOf, deliverToChannel, toHistory } from "./listener.js";

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
const deliveringBot = (fetched: () => Promise<unknown>): Client => ({ channels: { fetch: fetched } }) as unknown as Client;

const channelThatRecords = (sent: string[]) => ({ send: async (content: string) => void sent.push(content) });

test("deliverToChannel passes over a bot Discord says cannot see the channel, and posts through the next", async () => {
    const sent: string[] = [];
    const hidden = new DiscordAPIError({ code: 50001, message: "Missing Access" }, 50001, 403, "GET", "/channels/c1", { body: undefined, files: undefined });
    const bots = new Map([
        ["t1", deliveringBot(() => Promise.reject(hidden))],
        ["t2", deliveringBot(async () => channelThatRecords(sent))],
    ]);
    await deliverToChannel(bots, "c1", "hello");
    expect(sent).toEqual(["hello"]);
});

test("deliverToChannel lets an outage through instead of reading it as a channel no bot can post in", async () => {
    const sent: string[] = [];
    const bots = new Map([["t1", deliveringBot(() => Promise.reject(new Error("connect ETIMEDOUT")))]]);
    await expect(deliverToChannel(bots, "c1", "hello")).rejects.toThrow("connect ETIMEDOUT");
    expect(sent).toEqual([]);
});
