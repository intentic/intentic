import type { AgentTool } from "../tools/agent-tools.js";

// The few MCP calls the daemon makes itself to host an MCP server's app (mcp-apps.ts): list the tools to learn which
// one carries a UI, read that UI's resource, and call a tool the app asks for. Streamable HTTP, the transport every
// connected server speaks here: one POST per message, answered with JSON or a short event stream, the session id the
// server mints carried on every later call. Nothing here is the agent's own client; the CLI keeps that.

const PROTOCOL_VERSION = "2025-06-18";
const TIMEOUT_MS = 20_000;
// What answering a tool list, a resource or a call may weigh; an app's HTML is the biggest of them by far.
const MAX_ANSWER_BYTES = 8 * 1024 * 1024;

export class McpCallError extends Error {}

interface Rpc {
    readonly jsonrpc: "2.0";
    readonly id?: number;
    readonly result?: unknown;
    readonly error?: { readonly message?: string };
}

// The answer to request `id` in a response body: a JSON message (or batch), or an event stream whose `data:` lines hold
// messages, the server's notifications among them.
const answerIn = (body: string, contentType: string, id: number): Rpc | undefined => {
    const messages: unknown[] = [];
    if (contentType.includes("text/event-stream")) {
        for (const event of body.split(/\r?\n\r?\n/)) {
            const data = event
                .split(/\r?\n/)
                .filter((line) => line.startsWith("data:"))
                .map((line) => line.slice(5).trimStart())
                .join("\n");
            if (data !== "") {
                try {
                    messages.push(JSON.parse(data));
                } catch {
                    // allow(silent-catch): a keep-alive or a line that is not a message is not an answer.
                }
            }
        }
    } else if (body.trim() !== "") {
        const parsed: unknown = JSON.parse(body);
        messages.push(...(Array.isArray(parsed) ? parsed : [parsed]));
    }
    return messages.find((message): message is Rpc => typeof message === "object" && message !== null && (message as Rpc).id === id);
};

// One server, one session: initialized on first use, the server's session id kept for every call after.
export class McpClient {
    private session: string | undefined;
    private ready: Promise<void> | undefined;
    private next = 1;

    constructor(
        private readonly server: AgentTool,
        private readonly doFetch: typeof fetch = fetch,
    ) {}

    private async post(body: Record<string, unknown>): Promise<Response> {
        const response = await this.doFetch(this.server.url, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                accept: "application/json, text/event-stream",
                "mcp-protocol-version": PROTOCOL_VERSION,
                ...(this.server.token === undefined ? {} : { authorization: `Bearer ${this.server.token}` }),
                ...(this.session === undefined ? {} : { "mcp-session-id": this.session }),
            },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(this.server.timeoutMs ?? TIMEOUT_MS),
        });
        if (!response.ok) {
            throw new McpCallError(`${this.server.name} answered ${response.status}`);
        }
        return response;
    }

    private async call(method: string, params: Record<string, unknown>): Promise<unknown> {
        const id = this.next++;
        const response = await this.post({ jsonrpc: "2.0", id, method, params });
        this.session ??= response.headers.get("mcp-session-id") ?? undefined;
        const length = Number(response.headers.get("content-length") ?? "0");
        if (length > MAX_ANSWER_BYTES) {
            throw new McpCallError(`${this.server.name}'s answer to ${method} is too large`);
        }
        const text = await response.text();
        if (text.length > MAX_ANSWER_BYTES) {
            throw new McpCallError(`${this.server.name}'s answer to ${method} is too large`);
        }
        const answer = answerIn(text, response.headers.get("content-type") ?? "", id);
        if (answer === undefined) {
            throw new McpCallError(`${this.server.name} did not answer ${method}`);
        }
        if (answer.error !== undefined) {
            throw new McpCallError(answer.error.message ?? `${this.server.name} refused ${method}`);
        }
        return answer.result;
    }

    // The handshake, once: says this client draws MCP apps, so a server that only describes its UI to hosts that do
    // describes it here.
    private open(): Promise<void> {
        this.ready ??= (async () => {
            await this.call("initialize", {
                protocolVersion: PROTOCOL_VERSION,
                capabilities: { extensions: { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] } } },
                clientInfo: { name: "intentic", version: "1" },
            });
            // allow(silent-catch): a notification has no answer to wait for; a server that missed it fails the next request, which says why.
            await this.post({ jsonrpc: "2.0", method: "notifications/initialized" }).catch(() => undefined);
        })();
        // A failed handshake is tried again on the next call rather than remembered.
        this.ready.catch(() => {
            this.ready = undefined;
        });
        return this.ready;
    }

    async request(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
        await this.open();
        return this.call(method, params);
    }

    // Every tool, across pages of the list.
    async tools(): Promise<readonly McpTool[]> {
        const tools: McpTool[] = [];
        let cursor: string | undefined;
        for (let page = 0; page < 20; page += 1) {
            const answer = (await this.request("tools/list", cursor === undefined ? {} : { cursor })) as { tools?: McpTool[]; nextCursor?: string };
            tools.push(...(answer.tools ?? []));
            cursor = answer.nextCursor;
            if (cursor === undefined) {
                break;
            }
        }
        return tools;
    }
}

export interface McpTool {
    readonly name: string;
    readonly title?: string;
    readonly description?: string;
    readonly _meta?: Record<string, unknown>;
    readonly annotations?: { readonly title?: string; readonly readOnlyHint?: boolean };
}
