import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";

// One Claude Code turn against a scripted model that asks for one Bash call, with an SDK PreToolUse callback refusing
// it the way the daemon's guards do and the mod at argv[2] loaded as a user's plugin. Prints whether the refusing hook
// ran and whether the command ran anyway. Run by claude-policy.integration.test.ts inside a mount namespace whose
// /etc carries the image's managed settings.

const [modDir] = process.argv.slice(2);
if (modDir === undefined) {
    throw new Error("usage: mod-guard-probe <user-mod-plugin-dir>");
}

const scratch = mkdtempSync(join(tmpdir(), "mod-guard-probe-"));
const witness = join(scratch, "ran");
const command = `touch ${witness} # REFUSED-BY-THE-SANDBOX`;

type Frame = readonly [string, unknown];
const sse = (response: ServerResponse, frames: readonly Frame[]): void => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const [event, data] of frames) {
        response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    }
    response.end();
};
const start: Frame = [
    "message_start",
    {
        type: "message_start",
        message: { id: "msg_probe", type: "message", role: "assistant", model: "probe", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } },
    },
];
const end = (reason: string): readonly Frame[] => [
    ["message_delta", { type: "message_delta", delta: { stop_reason: reason, stop_sequence: null }, usage: { output_tokens: 1 } }],
    ["message_stop", { type: "message_stop" }],
];
const bashCall: readonly Frame[] = [
    start,
    ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_probe", name: "Bash", input: {} } }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify({ command, description: "probe" }) } }],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    ...end("tool_use"),
];
const done: readonly Frame[] = [
    start,
    ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "done" } }],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    ...end("end_turn"),
];

// The main loop's first request carries the tools and no result yet; every other request (a title, a retry) gets prose.
const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => (body += chunk.toString()));
    request.on("end", () => {
        const parsed = JSON.parse(body === "" ? "{}" : body) as { tools?: readonly { name?: string }[]; messages?: unknown };
        const asksForBash = (parsed.tools ?? []).some((tool) => tool.name === "Bash") && !JSON.stringify(parsed.messages ?? []).includes("tool_result");
        sse(response, asksForBash ? bashCall : done);
    });
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address() as AddressInfo;

const env: Record<string, string | undefined> = {
    ...process.env,
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
    ANTHROPIC_API_KEY: "probe",
    CLAUDE_CONFIG_DIR: join(scratch, "config"),
    // The daemon's own switch for running bypassPermissions as root.
    IS_SANDBOX: "1",
};
delete env["CLAUDE_CODE_OAUTH_TOKEN"];
delete env["ANTHROPIC_AUTH_TOKEN"];

let hookRan = false;
try {
    for await (const message of query({
        prompt: "run it",
        options: {
            cwd: scratch,
            env,
            settingSources: [],
            permissionMode: "bypassPermissions",
            allowDangerouslySkipPermissions: true,
            model: "claude-sonnet-4-5",
            plugins: [{ type: "local", path: modDir }],
            hooks: {
                PreToolUse: [
                    {
                        matcher: "Bash",
                        hooks: [
                            async () => {
                                hookRan = true;
                                return {
                                    hookSpecificOutput: { hookEventName: "PreToolUse" as const, permissionDecision: "deny" as const, permissionDecisionReason: "refused by the sandbox" },
                                };
                            },
                        ],
                    },
                ],
            },
        },
    })) {
        void message;
    }
    process.stdout.write(`${JSON.stringify({ hookRan, commandRan: existsSync(witness) })}\n`);
} finally {
    server.close();
    rmSync(scratch, { recursive: true, force: true });
}
