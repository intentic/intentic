import { readFile } from "node:fs/promises";
import { type FakeExtension, fakeExtensionApi } from "@intentic/extension-api/testing";
import type { Fetch } from "./publish.js";
import { discordBackend } from "./server.js";

// The posts the owner approved for Discord are published by this backend (the daemon hands one over only after the yes
// was matched and spent: approvals-executor.integration.test.ts in the daemon), through the first connected bot that can
// see the channel, as the gateway's /deliver door picks one. Discord itself is a stand-in `fetch`.

// SAFETY: the extension's own manifest, read for who it is, what it may reach and which listener it owns.
const manifest = JSON.parse(await readFile(new URL("../intentic-extension.json", import.meta.url), "utf8")) as {
    publisher: string;
    name: string;
    contributes: { listener: { provider: string } };
};

interface Sent {
    readonly method: string;
    readonly url: string;
    readonly authorization: string | null;
    readonly body?: unknown;
}

// One Discord: `sees` names which token sees which channel (in guild g1), `post` answers a message's POST.
const discord = (sees: Readonly<Record<string, readonly string[]>>, post: (sent: Sent) => Response = () => Response.json({ id: "m1", channel_id: "123456789" })) => {
    const sent: Sent[] = [];
    const fetchStub: Fetch = async (url, init) => {
        const authorization = new Headers(init?.headers).get("authorization");
        const entry: Sent = { method: init?.method ?? "GET", url, authorization, body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) };
        sent.push(entry);
        if (entry.method === "GET") {
            const channel = /\/channels\/(\d+)$/u.exec(url)?.[1] ?? "";
            const token = (authorization ?? "").replace(/^Bot /u, "");
            return (sees[token] ?? []).includes(channel) ? Response.json({ id: channel, guild_id: "g1" }) : Response.json({ message: "Missing Access" }, { status: 403 });
        }
        return post(entry);
    };
    return { sent, fetch: fetchStub };
};

const withCards = async (tokens: readonly string[], world: ReturnType<typeof discord>): Promise<FakeExtension> => {
    const extension = await fakeExtensionApi({
        manifest,
        daemon: (request) =>
            new URL(request.url).pathname === "/listeners/discord/state"
                ? Response.json({ automations: [], connectors: tokens.map((botToken, index) => ({ id: `discord-${index}`, config: { provider: "discord", botToken } })) })
                : undefined,
    });
    await extension.activate({ activateServer: discordBackend({ fetch: world.fetch, sleep: async () => undefined }) });
    return extension;
};

const POST = { platform: "discord", content: "v2 is out", target: "123456789" } as const;

describe("an approved Discord post", () => {
    test("goes out through the first bot that can see the channel, as written, pinging nobody, and its link is the result", async () => {
        const world = discord({ hidden: [], visible: ["123456789"] });
        const extension = await withCards(["hidden", "visible", "visible"], world);
        expect(await extension.publish(POST)).toEqual({ outcome: "done", result: "https://discord.com/channels/g1/123456789/m1" });
        const posts = world.sent.filter((entry) => entry.method === "POST");
        expect(posts).toEqual([
            {
                method: "POST",
                url: "https://discord.com/api/v10/channels/123456789/messages",
                authorization: "Bot visible",
                body: { content: "v2 is out", allowed_mentions: { parse: [] } },
            },
        ]);
        // The token two cards share is asked once.
        expect(world.sent.filter((entry) => entry.authorization === "Bot visible" && entry.method === "GET")).toHaveLength(1);
        await extension.dispose();
    });

    test("past the card's declared limit is refused before anything is sent, not split into several messages", async () => {
        const world = discord({ visible: ["123456789"] });
        const extension = await withCards(["visible"], world);
        expect(await extension.publish({ ...POST, content: "a".repeat(2_001) })).toEqual({
            outcome: "refused",
            error: "Discord caps a message at 2000 characters and this one is 2001",
        });
        expect(world.sent).toEqual([]);
        await extension.dispose();
    });

    test("with no bot connected, or none that sees the channel, is refused saying so", async () => {
        const none = await withCards([], discord({}));
        expect(await none.publish(POST)).toEqual({ outcome: "refused", error: "Discord isn't connected in this workspace, so there is no bot to post as" });
        await none.dispose();
        const blind = await withCards(["hidden"], discord({ hidden: [] }));
        expect(await blind.publish(POST)).toMatchObject({ outcome: "refused", error: expect.stringContaining("no connected Discord bot can see channel 123456789") });
        await blind.dispose();
    });

    test("a rule denying the bot's messages now refuses it, though the post was approved before", async () => {
        const world = discord({ visible: ["123456789"] });
        const extension = await withCards(["visible"], world);
        expect(await extension.publish({ ...POST, actionRules: { "discord.*": "deny" } })).toMatchObject({ outcome: "refused" });
        expect(world.sent).toEqual([]);
        await extension.dispose();
    });

    test("Discord refusing it is a refusal; Discord failing after it was sent may have posted, and says so", async () => {
        const refusing = await withCards(["visible"], discord({ visible: ["123456789"] }, () => Response.json({ message: "Cannot send messages in a voice channel" }, { status: 400 })));
        expect(await refusing.publish(POST)).toEqual({ outcome: "refused", error: "Discord refused the post (400: Cannot send messages in a voice channel)" });
        await refusing.dispose();
        const failing = await withCards(["visible"], discord({ visible: ["123456789"] }, () => new Response("bad gateway", { status: 502 })));
        expect(await failing.publish(POST)).toEqual({ outcome: "uncertain", error: "Discord answered 502 while taking the post" });
        await failing.dispose();
    });

    test("a rate limit is waited out once and the post goes", async () => {
        let calls = 0;
        const world = discord({ visible: ["123456789"] }, () => {
            calls += 1;
            return calls === 1 ? Response.json({ message: "rate limited" }, { status: 429, headers: { "retry-after": "0.5" } }) : Response.json({ id: "m2", channel_id: "123456789" });
        });
        const extension = await withCards(["visible"], world);
        expect(await extension.publish(POST)).toEqual({ outcome: "done", result: "https://discord.com/channels/g1/123456789/m2" });
        expect(calls).toBe(2);
        await extension.dispose();
    });
});
