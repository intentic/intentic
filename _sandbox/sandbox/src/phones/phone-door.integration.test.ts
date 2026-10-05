import { once } from "node:events";
import { mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAdaptorServer, type WebSocketServerLike } from "@hono/node-server";
import { type Capability, type PhoneFacts, phoneConnectUrl, phoneEnrollUrl, PhoneScopesSchema } from "@intentic/sandbox-contract";
import { unstubbed } from "@intentic/testing";
import { Hono } from "hono";
import { WebSocket, WebSocketServer } from "ws";
import { createTurnMounts } from "../agent/tools/turn-mounts.js";
import { createTurnMountRoute, type MountEndpoints } from "../agent/tools/turn-mounts.routes.js";
import type { Services } from "../composition.js";
import { createPeerHub } from "../peers/peer-hub.js";
import { filePeerStore } from "../peers/peer-store.js";
import { PHONE_PEER, type PhoneAnnounced, type PhoneClient, phonePeerRoutes } from "./phone-peer.js";
import { filePhoneWake } from "./phone-wake.js";

/* The whole phone door over a real socket: a phone that redeems its pairing, dials in, says hello and answers JSON-RPC,
   reached by a turn through the daemon's one MCP door, the way the Android app and a running turn meet in production. */

const facts: PhoneFacts = {
    device: "Google Pixel 8",
    android: "16",
    sdk: 36,
    build: "direct",
    paused: false,
    access: { accessibility: true, notifications: true, screenCapture: "accessibility" },
    folders: [],
    apps: [{ package: "com.google.android.apps.messaging", label: "Messages", mode: "act" }],
    wake: { fcm: "fcm-token" },
};

// The phone, as the app behaves: one JSON-RPC answer per request, and everything it was asked, in order.
const dialPhone = async (sandboxUrl: string, token: string) => {
    const asked: { method: string; params?: unknown }[] = [];
    const socket = new WebSocket(phoneConnectUrl(sandboxUrl));
    await once(socket, "open");
    socket.on("message", (data) => {
        const request = JSON.parse(String(data)) as {
            id: number;
            method: string;
            params?: { method?: string; id?: unknown; params?: { name?: string } };
        };
        asked.push({ method: request.method, ...(request.params === undefined ? {} : { params: request.params }) });
        const result =
            request.method === "describe"
                ? facts
                : request.method === "mcp"
                  ? request.params?.method === "tools/list"
                      ? { jsonrpc: "2.0", id: request.params.id, result: { tools: [{ name: "ui_act", inputSchema: { type: "object" } }] } }
                      : {
                            jsonrpc: "2.0",
                            id: request.params?.id,
                            result: { content: [{ type: "text", text: `did ${request.params?.params?.name ?? ""}` }] },
                        }
                  : { ok: true };
        socket.send(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }));
    });
    socket.send(JSON.stringify({ type: "hello", token, version: "1.0.0" }));
    return { socket, asked };
};

const stand = async () => {
    const root = mkdtempSync(join(tmpdir(), "phone-door-"));
    const logger = { warn: () => {}, info: () => {}, error: () => {} };
    const card = {
        id: "pixel",
        kind: "phone",
        config: { ...PhoneScopesSchema.parse({ control: "on" }), platform: "android" },
    } as unknown as Capability;
    let woken = 0;
    let onWake: () => void = () => {};
    const services = {
        logger,
        capabilities: { list: async () => [card] },
        phones: filePeerStore(root, PHONE_PEER.store),
        phoneHub: createPeerHub<PhoneClient, PhoneAnnounced, PhoneFacts, ReturnType<typeof PhoneScopesSchema.parse>>(PHONE_PEER.hub, logger),
        phoneWake: filePhoneWake(root, logger, async () => {
            woken += 1;
            onWake();
            return { delivered: true };
        }),
    } as unknown as Services;
    const routes = phonePeerRoutes(services);
    const mounts = createTurnMounts({ baseUrl: () => "http://127.0.0.1:1/mcp" });
    const { token: bearer } = mounts.lease("conv-1").open({ name: "pixel", target: { kind: "phone", id: "pixel" } });
    const app = new Hono()
        .post("/system/phones/enroll", routes.enroll)
        .get("/system/phones/connect", routes.connect)
        .all("/mcp/:mount", createTurnMountRoute(mounts, unstubbed<MountEndpoints>("endpoints", { phone: routes.mcp })));
    const sockets = new WebSocketServer({ noServer: true }) as unknown as WebSocketServerLike;
    const server = createAdaptorServer({ fetch: app.fetch, websocket: { server: sockets } });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const enroll = async (): Promise<string> => {
        const pairing = services.phones.mintPairing("pixel");
        const response = await fetch(phoneEnrollUrl(url), { method: "POST", headers: { "x-intentic-pair": pairing.token } });
        return ((await response.json()) as { token: string }).token;
    };
    const callTool = async (name: string, args: Record<string, unknown>) =>
        (await (
            await fetch(`${url}/mcp/pixel`, {
                method: "POST",
                headers: { authorization: `Bearer ${bearer ?? ""}`, "content-type": "application/json" },
                body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
            })
        ).json()) as { result?: { content?: { text?: string }[]; isError?: boolean }; error?: { message: string } };
    return {
        url,
        services,
        enroll,
        callTool,
        woken: () => woken,
        whenWoken: (react: () => void) => {
            onWake = react;
        },
        close: () => {
            server.close();
            (sockets as unknown as WebSocketServer).close();
        },
    };
};

test("a phone that pairs and dials in gets its grant before it is asked what it is, then answers a turn's call, sealed", async () => {
    const door = await stand();
    try {
        const token = await door.enroll();
        expect(token.startsWith("iph_")).toBe(true);
        const phone = await dialPhone(door.url, token);
        expect(await door.services.phoneHub.whenOnline("pixel", 5_000)).toBe(true);
        // The hub asks for the tool table the moment the phone attaches; the app lists its tools whatever its grant,
        // so only the grant-then-describe order matters, and that nothing reaches a tool before the grant does.
        const greeting = phone.asked.filter((request) => request.method !== "mcp");
        expect(greeting.slice(0, 2).map((request) => request.method)).toEqual(["setScopes", "describe"]);
        expect(greeting[0]?.params).toMatchObject({ control: "on", platform: "android" });
        expect(phone.asked.filter((request) => request.method === "mcp").map((request) => (request.params as { method?: string }).method)).toEqual([
            "tools/list",
        ]);
        expect(door.services.phoneHub.state("pixel").facts?.device).toBe("Google Pixel 8");

        const answered = await door.callTool("ui_act", { ref: "e4", action: "tap" });
        expect(answered.result?.content?.[0]?.text).toContain("did ui_act");
        expect(answered.result?.content?.[0]?.text).not.toBe("did ui_act");
        phone.socket.close();
    } finally {
        door.close();
    }
});

test("destructive text is refused before it reaches the phone while the card's switch is off", async () => {
    const door = await stand();
    try {
        const phone = await dialPhone(door.url, await door.enroll());
        await door.services.phoneHub.whenOnline("pixel", 5_000);
        const before = phone.asked.length;
        const answered = await door.callTool("ui_act", { ref: "e3", action: "type", text: "rm -rf ~/" });
        expect(answered.result?.isError).toBe(true);
        expect(answered.result?.content?.[0]?.text).toContain("Destructive actions");
        expect(phone.asked.length).toBe(before);
        phone.socket.close();
    } finally {
        door.close();
    }
});

test("a call to a phone that is asleep wakes it, waits for it to dial in, and is answered by it", async () => {
    const door = await stand();
    try {
        const token = await door.enroll();
        await door.services.phoneWake.register("pixel", {
            token: "fcm-token",
            channel: { kind: "relay", url: "https://relay.example/send", deviceId: "d", secret: "s" },
        });
        let phone: Awaited<ReturnType<typeof dialPhone>> | undefined;
        door.whenWoken(() => {
            void dialPhone(door.url, token).then((dialled) => {
                phone = dialled;
            });
        });
        const answered = await door.callTool("ui_act", { ref: "e4", action: "tap" });
        expect(door.woken()).toBe(1);
        expect(answered.result?.content?.[0]?.text).toContain("did ui_act");
        phone?.socket.close();
    } finally {
        door.close();
    }
});

test("a pairing redeemed once is spent: a replay is refused with the door's own sentence", async () => {
    const door = await stand();
    try {
        const pairing = door.services.phones.mintPairing("pixel");
        const first = await fetch(phoneEnrollUrl(door.url), { method: "POST", headers: { "x-intentic-pair": pairing.token } });
        expect(first.status).toBe(200);
        const replay = await fetch(phoneEnrollUrl(door.url), { method: "POST", headers: { "x-intentic-pair": pairing.token } });
        expect(replay.status).toBe(401);
        expect(((await replay.json()) as { error: string }).error).toBe(PHONE_PEER.expired);
    } finally {
        door.close();
    }
});
