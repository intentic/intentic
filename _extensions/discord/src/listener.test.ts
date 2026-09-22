import type { Message } from "discord.js";
import { test, expect } from "bun:test";
import { authorOf, toHistory } from "./listener.js";

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
