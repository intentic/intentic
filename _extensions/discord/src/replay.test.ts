import type { SleepHeardMessage } from "@intentic/extension-api/runtime";
import type { GatewayCtx } from "@intentic/connector-runtime";
import { unstubbed } from "@intentic/testing";
import type { Client, Message } from "discord.js";
import { type FetchHeard, heardReplay } from "./replay.js";

// What Intentic's servers heard while the sandbox slept is asked for once, after a hosted sleep only, and each bot's
// share is fetched and handed to the live handler as that bot connects, oldest first; what is gone is skipped.

const heard = (connection: string, messageId: string, at: number): SleepHeardMessage => ({
    service: "discord",
    connection,
    channelId: "100",
    messageId,
    guildId: "9",
    at,
});

const setUp = (afterSleep: boolean, answer: () => Promise<readonly SleepHeardMessage[]>) => {
    const asked = jest.fn(answer);
    const warn = jest.fn();
    const info = jest.fn();
    type Ctx = Pick<GatewayCtx, "api" | "log">;
    // The replay reads only `api.sleep`'s boot and heard, and the log's warn and info; anything else throws its name.
    const sleep = unstubbed<Ctx["api"]["sleep"]>("api.sleep", { boot: async () => ({ afterSleep, requestWake: false }), heard: asked });
    const ctx = unstubbed<Ctx>("ctx", { api: unstubbed<Ctx["api"]>("api", { sleep }), log: unstubbed<Ctx["log"]>("log", { warn, info }) });
    const dispatched: string[] = [];
    // SAFETY: the dispatch spy reads only a fetched message's id.
    const fetch: FetchHeard = async (_client, { messageId }) => (messageId === "gone" ? null : ({ id: messageId } as Message));
    const replay = heardReplay(ctx, (message) => dispatched.push(message.id), fetch);
    return { replay, asked, dispatched, warn, info };
};

// SAFETY: the fake fetch never reads the client.
const client = {} as Client;

test("after a hosted sleep, each bot's messages are answered as it connects, oldest first, through the live handler", async () => {
    const { replay, asked, dispatched } = setUp(true, async () => [heard("team", "3", 3), heard("ops", "2", 2), heard("team", "1", 1)]);
    await replay.connected(client, ["team"]);
    expect(dispatched).toEqual(["1", "3"]);
    await replay.connected(client, ["ops"]);
    expect(dispatched).toEqual(["1", "3", "2"]);
    // Handed over once: a bot connecting again answers nothing twice.
    await replay.connected(client, ["team", "ops"]);
    expect(dispatched).toEqual(["1", "3", "2"]);
    expect(asked).toHaveBeenCalledTimes(1);
});

test("a start that followed no hosted sleep asks for nothing", async () => {
    const { replay, asked, dispatched } = setUp(false, async () => [heard("team", "1", 1)]);
    await replay.connected(client, ["team"]);
    expect(asked).not.toHaveBeenCalled();
    expect(dispatched).toEqual([]);
});

test("a message deleted since, or that cannot be fetched, is skipped with a line, and the rest are answered", async () => {
    const { replay, dispatched, info } = setUp(true, async () => [heard("team", "gone", 1), heard("team", "2", 2)]);
    await replay.connected(client, ["team"]);
    expect(dispatched).toEqual(["2"]);
    expect(info).toHaveBeenCalledWith(expect.objectContaining({ message: "gone" }), expect.stringContaining("gone or unreadable; skipped"));
});

test("a platform that could not say leaves nothing to answer, and says so", async () => {
    const { replay, dispatched, warn } = setUp(true, async () => {
        throw new Error("daemon answered 502");
    });
    await replay.connected(client, ["team"]);
    expect(dispatched).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
});
