import { readFileSync } from "node:fs";
import { join } from "node:path";
import { STATE_DIR, WORKSPACE_ROOT } from "@intentic/constants";
import { repoRoot } from "@intentic/constants/node";
import { ExtensionManifestSchema } from "@intentic/extension-manifest";
import type { ActivityEvent } from "@intentic/sandbox-contract/schemas/activity";
import type { AgentEvent } from "@intentic/sandbox-contract/events/agent-events";
import type { Services } from "../composition.js";
import { unstubbed } from "@intentic/testing";
import { classifyCommand, createOutboundSniffer, type DeclaredCommand } from "./outbound.js";

// An extension's own command-line tool that acts outward (`whatsapp send`) is recognised by what its manifest declares
// (`commandActions`), never by a pattern of the daemon's; a request through the credential gateway is recorded there
// instead (capabilities/broker/broker-actions.test.ts).

// The commands an in-repo extension's cli card declares, under its card id, as the daemon reads them.
const declaredBy = (extension: string): DeclaredCommand[] => {
    const manifest = ExtensionManifestSchema.parse(
        JSON.parse(readFileSync(join(repoRoot(import.meta.url), "_extensions", extension, "intentic-extension.json"), "utf8")),
    );
    return (manifest.contributes?.capabilities ?? []).flatMap((card) =>
        card.kind === "cli" ? (card.commandActions ?? []).map((action) => ({ ...action, provider: card.id })) : [],
    );
};
const WHATSAPP = declaredBy("whatsapp");

// Only stubs activity/logger, which is all the sniffer touches; append pushes synchronously so assertions can follow
// observe() directly.
const capture = (): { appended: Partial<ActivityEvent>[]; services: Services } => {
    const appended: Partial<ActivityEvent>[] = [];
    const services = unstubbed<Services>("services", {
        activity: { append: async (event) => void appended.push(event), list: async () => [] },
        logger: unstubbed<Services["logger"]>("logger", { warn: () => {} }),
    });
    return { appended, services };
};

// Turn id stamped on every call the sniffer records, so the audit feed can fold sends into their turn's row.
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

const SEND = `whatsapp send 4915112345678@s.whatsapp.net deploy is out, all checks pass`;

test("a declared send records its action, chat, text, turn, session and ok outcome", () => {
    const { appended, services } = capture();
    const sniffer = createOutboundSniffer(services, TURN, WHATSAPP);
    sniffer.observe({ kind: "session", sessionId: "s1" });
    sniffer.observe(tool(SEND));
    sniffer.observe(result("Sent to 4915112345678@s.whatsapp.net."));
    expect(appended).toEqual([
        {
            provider: "whatsapp",
            direction: "out",
            type: "message.send",
            method: "POST",
            endpoint: "/send",
            channelId: "4915112345678@s.whatsapp.net",
            content: "deploy is out, all checks pass",
            turnId: TURN,
            sessionId: "s1",
            outcome: "ok",
        },
    ]);
});

test("each declared command reads its chat and content off the arguments it names, whatever the quoting", () => {
    const { appended, services } = capture();
    const sniffer = createOutboundSniffer(services, TURN, WHATSAPP);
    const commands = [
        `whatsapp send-file "1203630000000000@g.us" ${WORKSPACE_ROOT}/report.pdf`,
        `whatsapp reply 'Vicheta Samnang' 3EB0ABC on it`,
        `cd /tmp && whatsapp react 4915112345678 3EB0ABC 👍`,
    ];
    for (const [index, command] of commands.entries()) {
        sniffer.observe(tool(command, `t${String(index)}`));
        sniffer.observe(result("Sent.", `t${String(index)}`));
    }
    expect(appended.map(({ provider, type, endpoint, channelId, content }) => ({ provider, type, endpoint, channelId, content }))).toEqual([
        { provider: "whatsapp", type: "message.send", endpoint: "/send-file", channelId: "1203630000000000@g.us", content: `${WORKSPACE_ROOT}/report.pdf` },
        { provider: "whatsapp", type: "message.send", endpoint: "/reply", channelId: "Vicheta Samnang", content: "on it" },
        { provider: "whatsapp", type: "reaction.add", endpoint: "/react", channelId: "4915112345678", content: "👍" },
    ]);
});

test("an undeclared command, a read, the words in ordinary text and a non-Bash tool record nothing", () => {
    const { appended, services } = capture();
    const sniffer = createOutboundSniffer(services, TURN, WHATSAPP);
    sniffer.observe(tool(`whatsapp chats`, "t1"));
    sniffer.observe(result("...", "t1"));
    sniffer.observe(tool(`whatsapp download ABC123`, "t2"));
    sniffer.observe(result(`${WORKSPACE_ROOT}/${STATE_DIR}/local/runtime/extensions/whatsapp/media/ABC123-voice.ogg`, "t2"));
    sniffer.observe(tool(`grep -r "whatsapp send" _extensions/`, "t3"));
    sniffer.observe(result("", "t3"));
    sniffer.observe(tool(`curl -s https://api.github.com/user | jq .login`, "t4"));
    sniffer.observe(result("{}", "t4"));
    sniffer.observe({ kind: "tool_call", id: "t9", name: "Read", category: "read", status: "in_progress", target: "whatsapp send 1 hi" });
    sniffer.observe(result("{}", "t9"));
    sniffer.flush();
    expect(appended).toEqual([]);
});

test("nothing is recognised when no enabled extension declares the command", () => {
    expect(classifyCommand([], SEND)).toBeUndefined();
});

test("a command whose tool gates itself is neither recognised nor recorded", () => {
    const m365 = declaredBy("microsoft-365");
    expect(m365.length).toBeGreaterThan(0);
    expect(classifyCommand(m365, `m365 mail send --file /work/message.json`)).toBeUndefined();
    expect(classifyCommand(declaredBy("imap"), `imap send /work/draft.json`)).toBeUndefined();
});

test("a failed call records its own words as the error, and a JSON refusal in a success reads as one too", () => {
    const { appended, services } = capture();
    const sniffer = createOutboundSniffer(services, TURN, WHATSAPP);
    sniffer.observe(tool(`whatsapp send 4915112345678 hello there`, "t1"));
    sniffer.observe(result("WhatsApp is not connected, pair the device from the capability card first.", "t1", true));
    sniffer.observe(tool(`whatsapp send 4915112345678 hello there`, "t2"));
    sniffer.observe(result(`{"ok":false,"description":"Bad Request: chat not found"}`, "t2"));
    expect(appended.map(({ outcome, error }) => ({ outcome, error }))).toEqual([
        { outcome: "error", error: "WhatsApp is not connected, pair the device from the capability card first." },
        { outcome: "error", error: "Bad Request: chat not found" },
    ]);
});

test("flush records calls whose results never arrived, without an outcome", () => {
    const { appended, services } = capture();
    const sniffer = createOutboundSniffer(services, TURN, WHATSAPP);
    sniffer.observe(tool(SEND));
    expect(appended).toEqual([]);
    sniffer.flush();
    expect(appended).toEqual([expect.objectContaining({ type: "message.send" })]);
    expect(appended[0]?.outcome).toBeUndefined();
});

test("an interim update (live output snapshot, no status) keeps the call pending", () => {
    const { appended, services } = capture();
    const sniffer = createOutboundSniffer(services, TURN, WHATSAPP);
    sniffer.observe(tool(SEND));
    sniffer.observe({ kind: "tool_call_update", id: "t1", content: [{ type: "text", text: "partial" }] });
    expect(appended).toEqual([]);
    sniffer.observe(result("Sent."));
    expect(appended).toEqual([expect.objectContaining({ type: "message.send", outcome: "ok" })]);
});
