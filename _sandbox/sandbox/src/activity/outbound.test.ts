import type { ActivityEvent, AgentEvent } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import type { Services } from "../composition.js";
import { unstubbed } from "@intentic/testing";
import { createOutboundSniffer } from "./outbound.js";

// The sniffer only touches activity/logger; `unstubbed` keeps the fake that small. The fake append pushes
// synchronously, so assertions can follow observe() directly.
const capture = (): { appended: Partial<ActivityEvent>[]; services: Services } => {
    const appended: Partial<ActivityEvent>[] = [];
    const services = unstubbed<Services>("services", {
        activity: { append: async (event) => void appended.push(event), list: async () => [] },
        logger: unstubbed<Services["logger"]>("logger", { warn: () => {} }),
    });
    return { appended, services };
};

// The turn that owns the sniffer — stamped on every call it records, so the audit feed can fold a turn's sends
// into that turn's own row.
const TURN = "turn-1";

const tool = (command: string, id = "t1"): AgentEvent => ({
    kind: "tool_call",
    id,
    name: "Bash",
    category: "execute",
    status: "in_progress",
    target: command,
});
const result = (output: string, id = "t1", isError?: boolean): AgentEvent => ({
    kind: "tool_call_update",
    id,
    status: isError === true ? "failed" : "completed",
    content: [{ type: "text", text: output }],
});

// The exact command shapes DISCORD_SKILL teaches (capabilities/cli/providers.ts) — what real turns produce.
const SEND = `curl -s -X POST -H "Authorization: Bot $DISCORD_BOT_TOKEN" -H "Content-Type: application/json" -d '{"content":"hello"}' https://discord.com/api/v10/channels/123/messages`;
const REACT = `curl -s -X PUT -H "Authorization: Bot $DISCORD_BOT_TOKEN" "https://discord.com/api/v10/channels/123/messages/456/reactions/%F0%9F%91%8D/@me"`;
const READ = `curl -s -H "Authorization: Bot $DISCORD_BOT_TOKEN" "https://discord.com/api/v10/channels/123/messages?limit=20" | jq '.[] | {id, content}'`;
const GUILDS = `curl -s -H "Authorization: Bot $DISCORD_BOT_TOKEN" https://discord.com/api/v10/users/@me/guilds | jq '.[] | {id, name}'`;

test("the skill's send command records message.send with channel, content, turn, session, and ok outcome", () => {
    const { appended, services } = capture();
    const sniffer = createOutboundSniffer(services, TURN);
    sniffer.observe({ kind: "session", sessionId: "s1" });
    sniffer.observe(tool(SEND));
    sniffer.observe(result(`{"id":"999","content":"hello"}`));
    expect(appended).toEqual([
        {
            provider: "discord",
            direction: "out",
            type: "message.send",
            method: "POST",
            endpoint: "/channels/123/messages",
            channelId: "123",
            content: "hello",
            turnId: TURN,
            sessionId: "s1",
            outcome: "ok",
        },
    ]);
});

test("react and read classify as reaction.add and messages.read; guild listing falls through to api.call", () => {
    const { appended, services } = capture();
    const sniffer = createOutboundSniffer(services, TURN);
    sniffer.observe(tool(REACT, "t1"));
    sniffer.observe(result("", "t1"));
    sniffer.observe(tool(READ, "t2"));
    sniffer.observe(result("[]", "t2"));
    sniffer.observe(tool(GUILDS, "t3"));
    sniffer.observe(result("[]", "t3"));
    expect(appended.map(({ type, method, endpoint, channelId }) => ({ type, method, endpoint, channelId }))).toEqual([
        { type: "reaction.add", method: "PUT", endpoint: "/channels/123/messages/456/reactions/%F0%9F%91%8D/@me", channelId: "123" },
        { type: "messages.read", method: "GET", endpoint: "/channels/123/messages", channelId: "123" },
        { type: "api.call", method: "GET", endpoint: "/users/@me/guilds", channelId: undefined },
    ]);
});

test("non-discord commands and non-Bash tools record nothing", () => {
    const { appended, services } = capture();
    const sniffer = createOutboundSniffer(services, TURN);
    sniffer.observe(tool(`curl -s https://api.github.com/user | jq .login`));
    sniffer.observe({
        kind: "tool_call",
        id: "t9",
        name: "Read",
        category: "read",
        status: "in_progress",
        target: "https://discord.com/api/v10/users/@me",
    });
    sniffer.observe(result("{}", "t9"));
    sniffer.flush();
    expect(appended.filter((event) => event.direction === "out")).toEqual([]);
});

test("a Discord error envelope and an isError result both record outcome error", () => {
    const { appended, services } = capture();
    const sniffer = createOutboundSniffer(services, TURN);
    sniffer.observe(tool(SEND, "t1"));
    sniffer.observe(result(`{"message": "Missing Access", "code": 50001}`, "t1"));
    sniffer.observe(tool(SEND, "t2"));
    sniffer.observe(result("curl: (6) Could not resolve host", "t2", true));
    expect(appended.map(({ outcome, error }) => ({ outcome, error }))).toEqual([
        { outcome: "error", error: "Missing Access" },
        { outcome: "error", error: "curl: (6) Could not resolve host" },
    ]);
});

test("flush records calls whose results never arrived, without an outcome", () => {
    const { appended, services } = capture();
    const sniffer = createOutboundSniffer(services, TURN);
    sniffer.observe(tool(SEND));
    expect(appended).toEqual([]);
    sniffer.flush();
    expect(appended).toEqual([expect.objectContaining({ type: "message.send" })]);
    expect(appended[0]?.outcome).toBeUndefined();
});

test("an interim update (live output snapshot, no status) keeps the call pending", () => {
    const { appended, services } = capture();
    const sniffer = createOutboundSniffer(services, TURN);
    sniffer.observe(tool(SEND));
    sniffer.observe({ kind: "tool_call_update", id: "t1", content: [{ type: "text", text: "partial" }] });
    expect(appended).toEqual([]);
    sniffer.observe(result(`{"id":"999","content":"hello"}`));
    expect(appended).toEqual([expect.objectContaining({ type: "message.send", outcome: "ok" })]);
});
