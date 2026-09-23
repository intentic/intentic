import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { type ClaudeSdk, claudeCliPath, sdk } from "../../engines/claude-sdk.js";
import { opt } from "../../opt.js";
import type { BuiltinPromptText } from "@intentic/sandbox-contract";

// Claude Code's system prompt, captured from a real CLI request rather than transcribed here, since neither the SDK nor
// the CLI exposes the preset text directly. A loopback endpoint intercepts one throwaway turn's first request and
// answers with a canned stream; nothing reaches Anthropic and no credential is used.

// One capture per loaded SDK copy and model, shared by concurrent readers: Claude Code renders a different preset per
// model, and neither changes until the CLI does. Keyed "" for no model, the CLI's own default.
let cached: { readonly copy: ClaudeSdk; readonly byModel: Map<string, Promise<BuiltinPromptText>> } | undefined;

// A billing/telemetry line, not prompt text; dropped since the owner isn't replacing it.
const BILLING_PREFIX = "x-anthropic-billing-header:";

// Minimal well-formed reply so the CLI considers the turn finished; content is irrelevant, nothing reads it.
const CANNED_STREAM = [
    [
        "message_start",
        {
            type: "message_start",
            message: {
                id: "probe",
                type: "message",
                role: "assistant",
                model: "probe",
                content: [],
                stop_reason: null,
                usage: { input_tokens: 1, output_tokens: 1 },
            },
        },
    ],
    ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } }],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }],
    ["message_stop", { type: "message_stop" }],
]
    .map(([event, data]) => `event: ${event as string}\ndata: ${JSON.stringify(data)}\n\n`)
    .join("");

// Anthropic `system` is a string or an array of text blocks; joins them as the model reads them, minus the billing
// line.
const promptTextOf = (system: unknown): string | undefined => {
    if (typeof system === "string") {
        return system;
    }
    if (!Array.isArray(system)) {
        return undefined;
    }
    const text = system
        .map((block: unknown) => (typeof block === "object" && block !== null && "text" in block ? String((block as { text: unknown }).text) : ""))
        .filter((block) => block !== "" && !block.startsWith(BILLING_PREFIX))
        .join("\n\n");
    return text === "" ? undefined : text;
};

// Bounds the capture so a CLI that never sends a request does not hang the settings page.
const CAPTURE_TIMEOUT_MS = 60_000;

const capture = async (copy: ClaudeSdk, cwd: string, model: string | undefined): Promise<BuiltinPromptText> => {
    let text: string | undefined;
    let version = "";
    const server = createServer((request, response) => {
        const chunks: Buffer[] = [];
        request.on("data", (chunk: Buffer) => chunks.push(chunk));
        request.on("end", () => {
            if (text === undefined) {
                // A malformed body is not worth failing on; the timeout below reports a probe that never captures one.
                try {
                    text = promptTextOf((JSON.parse(Buffer.concat(chunks).toString()) as { system?: unknown }).system);
                } catch {
                    // Not the messages call; ignored.
                }
            }
            response.writeHead(200, { "content-type": "text/event-stream" });
            response.end(CANNED_STREAM);
        });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), CAPTURE_TIMEOUT_MS);
    const session = copy.query({
        prompt: "hi",
        options: {
            cwd,
            // The binary this copy's turns spawn, so the text captured is the text those turns get.
            ...opt("pathToClaudeCodeExecutable", claudeCliPath()),
            ...opt("model", model),
            abortController: abort,
            // Bare Claude Code only: no memory files, skills, or tools leaking into Claude's default.
            settingSources: [],
            allowedTools: [],
            maxTurns: 1,
            thinking: { type: "disabled" },
            // Excludes cwd, git status, memory: sandbox state, not the prompt, so a copy won't go stale.
            systemPrompt: { type: "preset", preset: "claude_code", excludeDynamicSections: true },
            env: { ...process.env, IS_SANDBOX: "1", ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`, ANTHROPIC_AUTH_TOKEN: "preset-probe" },
        },
    });
    try {
        for await (const message of session) {
            if (message.type === "system" && message.subtype === "init") {
                version = message.claude_code_version;
            }
            if (text !== undefined) {
                break;
            }
        }
    } finally {
        clearTimeout(timeout);
        abort.abort();
        await session.return(undefined).catch(() => {});
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    if (text === undefined) {
        throw new Error("Could not read Claude Code's system prompt: the CLI produced no request to capture it from.");
    }
    return { text, version };
};

export const presetSystemPrompt = (cwd: string, model?: string): Promise<BuiltinPromptText> => {
    const copy = sdk();
    if (cached?.copy !== copy) {
        cached = { copy, byModel: new Map() };
    }
    const { byModel } = cached;
    const key = model ?? "";
    const known = byModel.get(key);
    if (known !== undefined) {
        return known;
    }
    const prompt = capture(copy, cwd, model);
    byModel.set(key, prompt);
    // A failed capture is not kept, so the next reader probes again.
    prompt.catch(() => {
        if (byModel.get(key) === prompt) {
            byModel.delete(key);
        }
    });
    return prompt;
};
