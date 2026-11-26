import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "@intentic/constants/node";
import { type Broker, ExtensionManifestSchema } from "@intentic/extension-manifest";
import type { AdmissionRule } from "@intentic/sandbox-contract/schemas/command-admission";
import { z } from "zod";
import { commandWords } from "../../safety/shell-words.js";
import type { GatewayOutbound } from "./broker-actions.js";
import { createGateway, type GatewayCard, type GatewayDeps } from "./broker-gateway.js";
import { brokerRoutes, GATEWAY_PLACEHOLDER } from "./broker-routes.js";
import { brokerSessionsFrom } from "./broker-session.js";

// A request through the credential gateway for an action its card declares (`broker.actions`) is classified there, on
// the request itself, held to the owner's action rules (allow, hold, deny) and recorded in Activity. The cards are the
// chat extensions' own manifests and the commands their skills' own, so these say what a real turn gets.

const sessions = brokerSessionsFrom(async () => Buffer.alloc(32, 7));
// What the gateway answers a refused request with.
const RefusalSchema = z.object({ message: z.string(), gateway: z.literal("intentic") });
const root = repoRoot(import.meta.url);
const GATEWAY = "http://127.0.0.1:8790";

// The one cli card an in-repo extension contributes, as its manifest declares it.
const cardOf = (extension: string, config: Record<string, string>): GatewayCard => {
    const manifest = ExtensionManifestSchema.parse(JSON.parse(readFileSync(join(root, "_extensions", extension, "intentic-extension.json"), "utf8")));
    const card = manifest.contributes?.capabilities?.find((each) => each.kind === "cli");
    if (card?.kind !== "cli" || card.broker === undefined) {
        throw new Error(`${extension} contributes no brokered cli card`);
    }
    return { name: card.catalog.name, provider: card.id, config, broker: card.broker };
};

// The gateway address a turn's environment holds for one route of a card, by the route's variable.
const addressOf = async (card: GatewayCard, env: string, conversationId = "c1"): Promise<string> => {
    const route = brokerRoutes(card.broker, card.config).find((each) => each.env === env);
    if (route === undefined) {
        throw new Error(`no route carries ${env}`);
    }
    return `${GATEWAY}/${await sessions.sign({ capability: card.provider, route: route.index, upstream: route.upstream.href, conversationId })}`;
};

// One curl command as the request it sends, its variables filled in the way the agent's shell fills them.
const curlRequest = (command: string, vars: Readonly<Record<string, string>>): Request => {
    const [words = []] = commandWords(command.replace(/\$(\w+)/gu, (whole, name: string) => vars[name] ?? whole));
    let method: string | undefined;
    let body: string | undefined;
    let url: string | undefined;
    const headers = new Headers();
    for (let index = 1; index < words.length; index += 1) {
        const word = words[index] ?? "";
        const next = words[index + 1] ?? "";
        if (word === "-X") {
            method = next;
            index += 1;
        } else if (word === "-H") {
            const colon = next.indexOf(":");
            headers.set(next.slice(0, colon), next.slice(colon + 1).trim());
            index += 1;
        } else if (word === "-d") {
            body = next;
            index += 1;
        } else if (word.startsWith("http")) {
            url = word;
        }
    }
    if (url === undefined) {
        throw new Error(`no address in ${command}`);
    }
    return new Request(url, { method: method ?? (body === undefined ? "GET" : "POST"), headers, body: body ?? null });
};

// The curl command a skill teaches for one call, found by what it calls.
const skillCommand = (extension: string, calls: string): string => {
    const skill = readFileSync(join(root, "_extensions", extension, "skills", extension, "SKILL.md"), "utf8");
    const command = skill
        .split("\n")
        .map((line) => /`(curl [^`]+)`/u.exec(line)?.[1])
        .find((each) => each?.includes(calls) === true);
    if (command === undefined) {
        throw new Error(`the ${extension} skill teaches no curl for ${calls}`);
    }
    return command;
};

interface Sent {
    readonly url: string;
    readonly method: string;
    readonly authorization: string | null;
    readonly body: string;
}

interface Harness {
    readonly gateway: (request: Request) => Promise<Response>;
    readonly sent: Sent[];
    // The next Activity row the gateway writes; rows are written once the answer is read, off the request's path.
    readonly row: () => Promise<GatewayOutbound>;
    // Every row written so far.
    readonly rows: GatewayOutbound[];
}

const harness = (card: GatewayCard, rules: Readonly<Record<string, AdmissionRule>> = {}, answer: { status: number; body: string } = { status: 200, body: `{"ok":true}` }): Harness => {
    const sent: Sent[] = [];
    const rows: GatewayOutbound[] = [];
    const unread: GatewayOutbound[] = [];
    const waiting: ((row: GatewayOutbound) => void)[] = [];
    const deps: GatewayDeps = {
        sessions,
        card: async () => card,
        ownerRules: async () => undefined,
        hostGuards: async () => [],
        credentialGate: { check: async () => ({ allow: true }) },
        prompts: { canPark: () => true, passed: () => false, ask: async () => ({ allow: false, reason: "declined on the card" }) },
        used: () => undefined,
        actionRules: async () => rules,
        outbound: (row) => {
            rows.push(row);
            const waiter = waiting.shift();
            if (waiter === undefined) {
                unread.push(row);
            } else {
                waiter(row);
            }
        },
        // SAFETY: the gateway calls fetch(url, init) and nothing else of it, so the members a runtime adds are never read.
        fetch: (async (input: URL, init: RequestInit) => {
            const headers = new Headers(init.headers);
            sent.push({ url: String(input), method: init.method ?? "GET", authorization: headers.get("authorization"), body: init.body == null ? "" : await new Response(init.body).text() });
            return new Response(answer.body, { status: answer.status, headers: { "content-type": "application/json; charset=utf-8" } });
        }) as typeof fetch,
    };
    const gateway = createGateway(deps);
    return {
        sent,
        rows,
        // The answer's body is read first, as a client does: the row waits on the copy of it the gateway reads.
        gateway: async (request) => {
            const response = await gateway(request);
            await response.clone().text();
            return response;
        },
        row: () => {
            const ready = unread.shift();
            return ready === undefined ? new Promise((resolve) => waiting.push(resolve)) : Promise.resolve(ready);
        },
    };
};

const SLACK_TOKEN = "xoxb-real-token";
const slack = (): GatewayCard => cardOf("slack", { botToken: SLACK_TOKEN });
const slackVars = async (card: GatewayCard) => ({ SLACK_API_URL: await addressOf(card, "SLACK_API_URL"), SLACK_BOT_TOKEN: GATEWAY_PLACEHOLDER });

describe("a brokered send", () => {
    test("the Slack skill's own send command, through the gateway, is recorded as message.send with its channel and text", async () => {
        const card = slack();
        const { gateway, sent, row } = harness(card);
        const response = await gateway(curlRequest(skillCommand("slack", "chat.postMessage"), await slackVars(card)));
        expect(response.status).toBe(200);
        expect(sent).toEqual([
            {
                url: "https://slack.com/api/chat.postMessage",
                method: "POST",
                authorization: `Bearer ${SLACK_TOKEN}`,
                body: `{"channel":"<CHANNEL_ID>","thread_ts":"<THREAD_TS>","text":"hello"}`,
            },
        ]);
        expect(await row()).toEqual({
            call: { provider: "slack", type: "message.send", method: "POST", endpoint: "/chat.postMessage", channelId: "<CHANNEL_ID>", content: "hello" },
            conversationId: "c1",
            outcome: "ok",
        });
    });

    test("a deny rule refuses it with the rule's reason before the credential is attached, and records the refusal", async () => {
        const card = slack();
        const { gateway, sent, row } = harness(card, { "slack.message.send": "deny" });
        const response = await gateway(curlRequest(skillCommand("slack", "chat.postMessage"), await slackVars(card)));
        expect(response.status).toBe(403);
        expect(RefusalSchema.parse(await response.json()).message).toBe("Slack: slack message.send is refused by the action rules");
        expect(sent).toEqual([]);
        expect(await row()).toMatchObject({
            call: { type: "message.send", channelId: "<CHANNEL_ID>", content: "hello" },
            outcome: "error",
            error: "Slack: slack message.send is refused by the action rules",
        });
    });

    test("a hold rule refuses it toward the approvals queue, the held form of a send", async () => {
        const card = slack();
        const { gateway, sent } = harness(card, { "slack.message.send": "hold" });
        const response = await gateway(curlRequest(skillCommand("slack", "chat.postMessage"), await slackVars(card)));
        expect(response.status).toBe(403);
        const { message } = RefusalSchema.parse(await response.json());
        expect(message).toStartWith("Slack: slack message.send requires owner approval. Instead of sending directly");
        expect(message).toContain(".intentic/config/approvals/");
        expect(sent).toEqual([]);
    });

    test("an allow rule, or a rule for another action, lets it through", async () => {
        const card = slack();
        for (const rules of [{ "slack.message.send": "allow" }, { "slack.reaction.add": "deny", "discord.message.send": "deny" }] as const) {
            const { gateway, sent } = harness(card, rules);
            expect((await gateway(curlRequest(skillCommand("slack", "chat.postMessage"), await slackVars(card)))).status).toBe(200);
            expect(sent).toHaveLength(1);
        }
    });

    test("a request no action covers is recorded as api.call, held to the service's wildcard rule and to nothing narrower", async () => {
        const card = slack();
        const command = skillCommand("slack", "auth.test");
        const allowed = harness(card, { "slack.message.send": "deny" });
        expect((await allowed.gateway(curlRequest(command, await slackVars(card)))).status).toBe(200);
        expect((await allowed.row()).call).toEqual({ provider: "slack", type: "api.call", method: "GET", endpoint: "/auth.test" });
        const held = harness(card, { "slack.*": "hold" });
        expect((await held.gateway(curlRequest(command, await slackVars(card)))).status).toBe(403);
        expect(held.sent).toEqual([]);
    });

    test("a read is recorded under its own action, and a service's refusal inside a 200 reads as a failed call", async () => {
        const card = slack();
        const { gateway, row } = harness(card, {}, { status: 200, body: `{"ok":false,"error":"channel_not_found"}` });
        await gateway(curlRequest(skillCommand("slack", "conversations.history"), await slackVars(card)));
        expect(await row()).toMatchObject({
            call: { type: "messages.read", method: "GET", endpoint: "/conversations.history", channelId: "<CHANNEL_ID>" },
            outcome: "error",
            error: "channel_not_found",
        });
    });
});

describe("the chat extensions' declarations", () => {
    test("Discord's send, reaction and read, through the gateway, classify by method and path, the channel read off the path", async () => {
        const card = cardOf("discord", { botToken: "real-bot-token" });
        const vars = { DISCORD_API_URL: await addressOf(card, "DISCORD_API_URL"), DISCORD_BOT_TOKEN: GATEWAY_PLACEHOLDER };
        const { gateway, row, sent } = harness(card);
        const calls = [
            skillCommand("discord", "/messages\"").replace("<CHANNEL_ID>", "123"),
            skillCommand("discord", "/reactions/").replace("<CHANNEL_ID>", "123").replace("<MESSAGE_ID>", "456"),
            skillCommand("discord", "messages?limit=20").replace("<CHANNEL_ID>", "123"),
            skillCommand("discord", "users/@me/guilds"),
        ];
        const recorded: GatewayOutbound["call"][] = [];
        for (const command of calls) {
            await gateway(curlRequest(command, vars));
            recorded.push((await row()).call);
        }
        expect(sent.every((each) => each.authorization === "Bot real-bot-token")).toBe(true);
        expect(recorded).toEqual([
            { provider: "discord", type: "message.send", method: "POST", endpoint: "/v10/channels/123/messages", channelId: "123", content: "hello" },
            { provider: "discord", type: "reaction.add", method: "PUT", endpoint: "/v10/channels/123/messages/456/reactions/%F0%9F%91%8D/@me", channelId: "123" },
            { provider: "discord", type: "messages.read", method: "GET", endpoint: "/v10/channels/123/messages", channelId: "123" },
            { provider: "discord", type: "api.call", method: "GET", endpoint: "/v10/users/@me/guilds" },
        ]);
    });

    test("a Discord error answer records its own message", async () => {
        const card = cardOf("discord", { botToken: "real-bot-token" });
        const { gateway, row } = harness(card, {}, { status: 403, body: `{"message": "Missing Access", "code": 50001}` });
        const command = skillCommand("discord", "/messages\"").replace("<CHANNEL_ID>", "123");
        await gateway(curlRequest(command, { DISCORD_API_URL: await addressOf(card, "DISCORD_API_URL"), DISCORD_BOT_TOKEN: GATEWAY_PLACEHOLDER }));
        expect(await row()).toMatchObject({ outcome: "error", error: "Missing Access" });
    });

    test("Telegram's token rides the path the gateway adds, and never reaches the row; the chat is read off JSON or a multipart form", async () => {
        const token = "123456:real-telegram-token";
        const card = cardOf("telegram", { botToken: token });
        const api = await addressOf(card, "TELEGRAM_API_URL");
        const { gateway, row, sent } = harness(card);
        await gateway(curlRequest(skillCommand("telegram", "sendMessage\"").replace("<CHAT_ID>", "-100123"), { TELEGRAM_API_URL: api }));
        const form = new FormData();
        form.set("chat_id", "-100123");
        form.set("document", new Blob(["%PDF report"]), "report.pdf");
        await gateway(new Request(`${api}/sendDocument`, { method: "POST", body: form }));
        await gateway(new Request(`${api}/getFile?file_id=abc`));
        const recorded = [(await row()).call, (await row()).call, (await row()).call];
        expect(sent.map((each) => each.url)).toEqual([
            `https://api.telegram.org/bot${token}/sendMessage`,
            `https://api.telegram.org/bot${token}/sendDocument`,
            `https://api.telegram.org/bot${token}/getFile?file_id=abc`,
        ]);
        expect(recorded).toEqual([
            { provider: "telegram", type: "message.send", method: "POST", endpoint: "/sendMessage", channelId: "-100123", content: "hello" },
            { provider: "telegram", type: "message.send", method: "POST", endpoint: "/sendDocument", channelId: "-100123" },
            { provider: "telegram", type: "file.read", method: "GET", endpoint: "/getFile" },
        ]);
        expect(JSON.stringify(recorded)).not.toContain(token);
        // The upload reached the service whole, though the gateway read its fields on the way.
        expect(sent[1]?.body).toContain("%PDF report");
    });

    test("a card that declares no actions is neither recorded nor held to the action rules", async () => {
        const card: GatewayCard = {
            name: "Forge",
            provider: "forge",
            config: { token: "t" },
            broker: { routes: [{ upstream: "https://forge.example.com", env: "FORGE_URL", headers: { authorization: "Bearer ${token}" } }] } satisfies Broker,
        };
        const { gateway, sent, rows } = harness(card, { "forge.*": "deny" });
        expect((await gateway(new Request(`${await addressOf(card, "FORGE_URL")}/repos`, { method: "POST", body: "{}" }))).status).toBe(200);
        expect(sent).toHaveLength(1);
        expect(rows).toEqual([]);
    });
});
