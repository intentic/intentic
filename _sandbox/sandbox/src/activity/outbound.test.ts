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

// The exact shapes the telegram SKILL teaches. The method rides in the path BEHIND the bot token, which is why
// these assert on the endpoint as much as on the classification.
const TG_SEND = `curl -s -X POST -H "Content-Type: application/json" -d '{"chat_id":-100123,"text":"on it"}' "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/sendMessage"`;
const TG_FILE = `curl -s "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/getFile?file_id=abc"`;
const TG_DOWNLOAD = `curl -s -o /work/incoming "https://api.telegram.org/file/bot$TELEGRAM_BOT_TOKEN/voice/file_1.oga"`;
const TG_UPLOAD = `curl -s -F chat_id=-100123 -F document=@/work/report.pdf "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/sendDocument"`;

test("a telegram send records the method as the endpoint, with the chat and text off the JSON body", () => {
    const { appended, services } = capture();
    const sniffer = createOutboundSniffer(services, TURN);
    sniffer.observe(tool(TG_SEND));
    sniffer.observe(result(`{"ok":true,"result":{"message_id":9}}`));
    expect(appended).toEqual([
        {
            provider: "telegram",
            direction: "out",
            type: "message.send",
            method: "POST",
            endpoint: "/sendMessage",
            channelId: "-100123",
            content: "on it",
            turnId: TURN,
            outcome: "ok",
        },
    ]);
});

/* A BOT TOKEN MUST NEVER REACH THE ACTIVITY FEED. Telegram puts it in the URL path, the feed is read by people
 * and pasted into support threads, and the skills teach `$TELEGRAM_BOT_TOKEN` precisely so it does not expand —
 * but a hand-typed one has to be dropped on the floor too, which is what recording only the method does. */
test("a literally-pasted bot token does not survive into the recorded call", () => {
    const { appended, services } = capture();
    const sniffer = createOutboundSniffer(services, TURN);
    const token = "8123456789:AAH-Fake-Token-Value";
    sniffer.observe(tool(`curl -s -X POST -d '{"chat_id":42,"text":"hi"}' "https://api.telegram.org/bot${token}/sendMessage"`));
    sniffer.observe(result(`{"ok":true}`));
    expect(appended[0]).toMatchObject({ provider: "telegram", endpoint: "/sendMessage", channelId: "42" });
    expect(JSON.stringify(appended)).not.toContain(token);
});

test("file reads, uploads and downloads each classify without a token in the endpoint", () => {
    const { appended, services } = capture();
    const sniffer = createOutboundSniffer(services, TURN);
    sniffer.observe(tool(TG_FILE, "t1"));
    sniffer.observe(result(`{"ok":true,"result":{"file_path":"voice/file_1.oga"}}`, "t1"));
    sniffer.observe(tool(TG_DOWNLOAD, "t2"));
    sniffer.observe(result("", "t2"));
    sniffer.observe(tool(TG_UPLOAD, "t3"));
    sniffer.observe(result(`{"ok":true}`, "t3"));
    expect(appended.map(({ type, method, endpoint, channelId }) => ({ type, method, endpoint, channelId }))).toEqual([
        { type: "file.read", method: "GET", endpoint: "/getFile", channelId: undefined },
        { type: "api.call", method: "GET", endpoint: "/file", channelId: undefined },
        // A multipart upload carries the chat as a form field rather than in JSON — same fact, different syntax.
        { type: "message.send", method: "POST", endpoint: "/sendDocument", channelId: "-100123" },
    ]);
});

test("telegram reports a refusal in `description` where slack uses `error` — both read as a failed call", () => {
    const { appended, services } = capture();
    const sniffer = createOutboundSniffer(services, TURN);
    sniffer.observe(tool(TG_SEND));
    sniffer.observe(result(`{"ok":false,"error_code":400,"description":"Bad Request: chat not found"}`));
    expect(appended.map(({ outcome, error }) => ({ outcome, error }))).toEqual([{ outcome: "error", error: "Bad Request: chat not found" }]);
});

/* WhatsApp's skill teaches a BIN, not curl — the paired socket lives in the gateway and the agent drives it
 * with `whatsapp send …`. The matcher parses that command shape, so sends land in the activity feed and the
 * `whatsapp.message.send` action rule has something to bite on. */
test("a whatsapp CLI send records message.send with the chat and text, whatever the quoting", () => {
    const { appended, services } = capture();
    const sniffer = createOutboundSniffer(services, TURN);
    sniffer.observe(tool(`whatsapp send 4915112345678@s.whatsapp.net deploy is out, all green`, "t1"));
    sniffer.observe(result("Sent to 4915112345678@s.whatsapp.net.", "t1"));
    sniffer.observe(tool(`whatsapp send-file "1203630000000000@g.us" /work/report.pdf`, "t2"));
    sniffer.observe(result("Sent /work/report.pdf to 1203630000000000@g.us.", "t2"));
    expect(appended.map(({ provider, type, endpoint, channelId, content }) => ({ provider, type, endpoint, channelId, content }))).toEqual([
        {
            provider: "whatsapp",
            type: "message.send",
            endpoint: "/send",
            channelId: "4915112345678@s.whatsapp.net",
            content: "deploy is out, all green",
        },
        { provider: "whatsapp", type: "message.send", endpoint: "/send-file", channelId: "1203630000000000@g.us", content: "/work/report.pdf" },
    ]);
});

test("whatsapp reads record nothing, and the word whatsapp in ordinary text is not a send", () => {
    const { appended, services } = capture();
    const sniffer = createOutboundSniffer(services, TURN);
    sniffer.observe(tool(`whatsapp chats`, "t1"));
    sniffer.observe(result("...", "t1"));
    sniffer.observe(tool(`whatsapp download ABC123`, "t2"));
    sniffer.observe(result("/work/.intentic/runtime/extensions/whatsapp/media/ABC123-voice.ogg", "t2"));
    sniffer.observe(tool(`grep -r "whatsapp send" _extensions/`, "t3"));
    sniffer.observe(result("", "t3"));
    sniffer.flush();
    expect(appended.filter((event) => event.direction === "out")).toEqual([]);
});

test("a failed whatsapp CLI call records the gateway's sentence as the error", () => {
    const { appended, services } = capture();
    const sniffer = createOutboundSniffer(services, TURN);
    sniffer.observe(tool(`whatsapp send 4915112345678 hello there`, "t1"));
    sniffer.observe(result("WhatsApp is not connected — pair the device from the capability card first.", "t1", true));
    expect(appended.map(({ outcome, error }) => ({ outcome, error }))).toEqual([
        { outcome: "error", error: "WhatsApp is not connected — pair the device from the capability card first." },
    ]);
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
