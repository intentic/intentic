import { type HostScopes, MCP_PROTOCOL_VERSION } from "@intentic/sandbox-contract";
import { audit } from "./audit.js";
import { ScopeError } from "./policy.js";
import { describeText } from "./tools/describe.js";
import { listDirectory, readTextFile, trashFile, writeTextFile } from "./tools/files.js";
import { captureScreen } from "./tools/screen.js";
import { describeResult, runCommand } from "./tools/shell.js";
import { HOST_VERSION } from "./version.js";

/* The MCP server — running HERE, on the machine, not in the sandbox.
 *
 * The sandbox's daemon forwards JSON-RPC verbatim and interprets none of it, so this file is the entire tool
 * surface: what this computer can do is decided by the binary installed on it, and a machine that upgrades
 * learns new tools without anything changing in the sandbox. That is the reason for the split — the alternative
 * (schemas in the daemon, execution here) makes every new tool a coordinated release of two products.
 *
 * The protocol implemented is the subset that a Streamable HTTP client actually uses against a stateless server:
 * initialize, tools/list, tools/call, ping, and notifications (which get no reply). Anything else answers
 * "method not found", which is the correct JSON-RPC response and not an error worth logging.
 *
 * A FAILED TOOL IS NOT A FAILED CALL. Every error — a refused scope, a missing file, a command that exited 1 —
 * comes back as a normal result with isError, because that is what a model can read and act on; a JSON-RPC error
 * surfaces as a transport fault and invites a retry loop against a computer that will refuse it exactly the same
 * way the second time. */

interface ToolDefinition {
    readonly name: string;
    readonly description: string;
    readonly inputSchema: Record<string, unknown>;
}

// The tool list, written for a reader who has never seen this machine. Descriptions carry the judgement calls
// the schema cannot: that writes are off by default, that there is no delete, that one big command beats ten
// small ones over a link like this.
const TOOLS: readonly ToolDefinition[] = [
    {
        name: "describe",
        description:
            "What this computer is: OS and version, CPU architecture, the exact shell run_command uses, the home directory, the folders you may touch, and which permissions are on. Call this once before your first command here — it is the difference between writing for this machine and guessing.",
        inputSchema: { type: "object", properties: {} },
    },
    {
        name: "run_command",
        description:
            "Run a command on this computer and get back its exit code, stdout and stderr. The shell is PowerShell on Windows and the user's login shell elsewhere (see describe). There is no terminal for anyone to type into: a command that prompts will fail rather than wait. Prefer one script that does the whole job over many small calls — every call is a network round trip to somebody's laptop.",
        inputSchema: {
            type: "object",
            properties: {
                command: { type: "string", description: "The command line to run, in this machine's shell." },
                cwd: { type: "string", description: "Working directory. Must be inside the allowed folders. Defaults to the first allowed folder." },
                timeoutMs: { type: "number", description: "How long to wait before killing it. Default 120000, maximum 600000." },
            },
            required: ["command"],
        },
    },
    {
        name: "read_file",
        description: "Read a text file on this computer. Bounded by the folders this machine allows.",
        inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    },
    {
        name: "write_file",
        description:
            "Create a file or replace its contents. Requires the 'Create and change files' permission, which is OFF unless the user turned it on. Overwrites whole — read first if you mean to edit.",
        inputSchema: {
            type: "object",
            properties: { path: { type: "string" }, content: { type: "string" } },
            required: ["path", "content"],
        },
    },
    {
        name: "list_dir",
        description: "List a directory, with each entry's kind, size and modification time.",
        inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    },
    {
        name: "trash_file",
        description:
            "Move a file into this agent's trash folder, from which the user can restore it. There is deliberately no permanent-delete tool. Requires the 'Create and change files' permission.",
        inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    },
    {
        name: "screenshot",
        description:
            "Capture what is on this computer's screen right now, as an image. Use it to read a dialog, check on a window, or see what the user is describing. Requires the 'See the screen' permission.",
        inputSchema: { type: "object", properties: {} },
    },
];

const textResult = (text: string, isError = false): Record<string, unknown> => ({ content: [{ type: "text", text }], isError });

const asString = (value: unknown, name: string): string => {
    if (typeof value !== "string" || value === "") {
        throw new Error(`"${name}" must be a non-empty string.`);
    }
    return value;
};

const callTool = async (name: string, args: Record<string, unknown>, scopes: HostScopes): Promise<Record<string, unknown>> => {
    switch (name) {
        case "describe":
            return textResult(await describeText(scopes));
        case "run_command": {
            const timeoutMs = typeof args["timeoutMs"] === "number" ? args["timeoutMs"] : 120_000;
            const result = await runCommand(
                {
                    command: asString(args["command"], "command"),
                    ...(typeof args["cwd"] === "string" ? { cwd: args["cwd"] } : {}),
                    timeoutMs,
                },
                scopes,
            );
            // A non-zero exit is a real answer, not a tool failure — the model reads the code and the streams and
            // decides. Only a command that could not be RUN comes back as an error.
            return textResult(describeResult(result, timeoutMs));
        }
        case "read_file":
            return textResult(await readTextFile(asString(args["path"], "path"), scopes));
        case "write_file":
            return textResult(await writeTextFile(asString(args["path"], "path"), asString(args["content"], "content"), scopes));
        case "list_dir":
            return textResult(JSON.stringify(await listDirectory(asString(args["path"], "path"), scopes), undefined, 2));
        case "trash_file":
            return textResult(await trashFile(asString(args["path"], "path"), scopes));
        case "screenshot":
            return { content: [{ type: "image", data: await captureScreen(scopes), mimeType: "image/png" }], isError: false };
        default:
            return textResult(`This computer has no tool called "${name}".`, true);
    }
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

// Handle one JSON-RPC message. Returns the response, or undefined for a notification (nothing to answer).
// `scopes` is read per call from the live grant, so a scopes frame that arrives mid-session takes effect on the
// very next tool call rather than at the next reconnect.
export const handleMcpMessage = async (message: unknown, scopes: () => HostScopes): Promise<Record<string, unknown> | undefined> => {
    if (!isRecord(message)) {
        return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "invalid request" } };
    }
    const id = message["id"];
    const method = message["method"];
    if (id === undefined) {
        return undefined;
    }
    const reply = (result: Record<string, unknown>): Record<string, unknown> => ({ jsonrpc: "2.0", id, result });

    if (method === "initialize") {
        return reply({
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: { name: "intentic-host", version: HOST_VERSION },
        });
    }
    if (method === "ping") {
        return reply({});
    }
    if (method === "tools/list") {
        return reply({ tools: TOOLS });
    }
    if (method === "tools/call") {
        const params = isRecord(message["params"]) ? message["params"] : {};
        const name = typeof params["name"] === "string" ? params["name"] : "";
        const args = isRecord(params["arguments"]) ? params["arguments"] : {};
        try {
            const result = await callTool(name, args, scopes());
            void audit({ tool: name, ok: result["isError"] !== true, detail: JSON.stringify(args).slice(0, 500) });
            return reply(result);
        } catch (error) {
            const refused = error instanceof ScopeError;
            void audit({ tool: name, ok: false, detail: `${refused ? "refused" : "failed"}: ${error instanceof Error ? error.message : String(error)}` });
            return reply(textResult(error instanceof Error ? error.message : String(error), true));
        }
    }
    return { jsonrpc: "2.0", id, error: { code: -32601, message: `method "${String(method)}" is not supported` } };
};
