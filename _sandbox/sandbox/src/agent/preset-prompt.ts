import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { BuiltinPromptText } from "@intentic/sandbox-contract";

/* CLAUDE CODE'S OWN SYSTEM PROMPT, READ OUT OF THE CLI THAT IS INSTALLED, not transcribed into this repo.
 *
 * The settings page lets the owner REPLACE the system prompt, and a replace-only editor is a trap unless they
 * can see what they are replacing and get back to it. Neither the SDK nor the CLI exposes the preset text
 * (`systemPrompt: {preset: 'claude_code'}` is a flag the CLI expands on its way to the API, and the `init`
 * message carries tool names and versions but no prompt), so the only source that cannot go stale is the
 * request the CLI actually builds.
 *
 * So: stand up a loopback endpoint, point the CLI's ANTHROPIC_BASE_URL at it, and run one throwaway turn. The
 * first /v1/messages carries the fully expanded system prompt; we keep it and answer with a canned stream so
 * the CLI finishes instead of retrying. Nothing reaches Anthropic, no credential is used (the token is a
 * placeholder), no tokens are billed, and the answer is fabricated locally, which also means the owner can
 * read the default before connecting any account at all.
 *
 * The alternative was shipping a copy of the prompt in this repo. That copy would be wrong the first time the
 * image bumped the CLI, and wrong silently: the page would show a prompt the agent hadn't run in months. */

// One capture per daemon process. The prompt only changes when the CLI does, and the CLI changes when the
// image is rebuilt, which restarts the daemon. So there is no invalidation to get wrong.
let cached: BuiltinPromptText | undefined;

// The CLI opens the system array with a billing/telemetry line rather than prompt text. It is not part of what
// the owner is replacing, so it is dropped from the text (its cc_version is a fallback for the CLI version,
// which the init message normally supplies first).
const BILLING_PREFIX = "x-anthropic-billing-header:";

// A minimal Anthropic streaming answer. The CLI needs a well-formed message to consider the turn finished; the
// content is irrelevant because nothing reads it, the capture already happened on the request.
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

// The Anthropic `system` param is either a plain string or an array of text blocks; join the blocks the way the
// model reads them and drop the billing line.
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

// A capture that never sees a request would otherwise hang the settings page on a CLI that failed to start.
const CAPTURE_TIMEOUT_MS = 60_000;

export const presetSystemPrompt = async (cwd: string): Promise<BuiltinPromptText> => {
    if (cached !== undefined) {
        return cached;
    }
    let text: string | undefined;
    let version = "";
    const server = createServer((request, response) => {
        const chunks: Buffer[] = [];
        request.on("data", (chunk: Buffer) => chunks.push(chunk));
        request.on("end", () => {
            if (text === undefined) {
                // A malformed body is not worth failing on, the capture simply hasn't happened yet, and the
                // timeout below is what reports a probe that never produces one.
                try {
                    text = promptTextOf((JSON.parse(Buffer.concat(chunks).toString()) as { system?: unknown }).system);
                } catch {
                    /* not the messages call */
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
    const session = query({
        prompt: "hi",
        options: {
            cwd,
            abortController: abort,
            // The probe must describe a BARE Claude Code turn, so the text is the preset itself and not this
            // workspace's memory files, skills or tools leaking into what we present as "Claude's default".
            settingSources: [],
            allowedTools: [],
            maxTurns: 1,
            thinking: { type: "disabled" },
            // excludeDynamicSections keeps the cwd, git status and memory paths OUT: they are this sandbox's
            // state, not Claude's prompt, and a user editing a copy of the default should not inherit a frozen
            // snapshot of what their repo looked like the day they clicked the button.
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
    cached = { text, version };
    return cached;
};
