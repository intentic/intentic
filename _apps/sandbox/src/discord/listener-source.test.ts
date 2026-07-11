import type { Message } from "discord.js";
import { expect, test } from "vitest";
import { toHistory } from "./listener-source.js";

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

    expect(history?.map((h) => h.content)).toEqual(["yo", "what model?", "Hey! How can I help you?"]);
    expect(history?.map((h) => h.self)).toEqual([undefined, undefined, true]);
});
