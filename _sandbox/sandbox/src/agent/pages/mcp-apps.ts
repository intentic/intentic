import type { HookCallbackMatcher, HookEvent } from "@anthropic-ai/claude-agent-sdk";
import { type AgentEvent, intoHead, mcpAppDataScript, type Page } from "@intentic/sandbox-contract";
import type { AgentTool } from "../tools/agent-tools.js";
import { McpClient, type McpTool } from "./mcp-client.js";
import { carryPage } from "./page-assets.js";
import { publishPage } from "./page-store.js";

// Hosting an MCP server's own app (the MCP Apps extension, io.modelcontextprotocol/ui): when the agent calls a tool of a
// connected MCP server, and that tool names a `ui://` resource, the resource's HTML is shown in the chat as a page,
// handed the call's arguments and result over the same bridge the agent's own pages speak. What the app later asks of
// its server (`tools/call`) is carried by the daemon (pages.routes.ts), since the app's frame reaches no network.

// The `ui://` resource a tool shows its result with, in the extension's spelling or either older one.
export const uiResourceOf = (tool: McpTool): string | undefined => {
    const meta = tool["_meta"] ?? {};
    const ui = meta["ui"] as { readonly resourceUri?: unknown } | undefined;
    const uri = ui?.resourceUri ?? meta["ui/resourceUri"] ?? meta["openai/outputTemplate"];
    return typeof uri === "string" && uri.startsWith("ui://") ? uri : undefined;
};

// Whether the app may call this tool itself: visible to the app unless the server limits it to the model.
export const appMayCall = (tool: McpTool): boolean => {
    const visibility = (tool["_meta"]?.["ui"] as { readonly visibility?: unknown } | undefined)?.visibility;
    return !Array.isArray(visibility) || visibility.includes("app");
};

// How the CLI spells a server's or a tool's name inside `mcp__<server>__<tool>`.
const spelled = (name: string): string => name.replace(/[^a-zA-Z0-9_-]/g, "_");

interface AppResource {
    readonly html: string;
    // Origins the app says it loads static files from, which the sandbox fetches for it like a library CDN.
    readonly resourceDomains: readonly string[];
}

const domainsIn = (value: unknown): string[] => (Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : []);

// The app's HTML, from a `resources/read` answer: text, or a blob of it.
export const appResourceOf = (answer: unknown): AppResource | undefined => {
    const contents = (answer as { readonly contents?: readonly Record<string, unknown>[] } | undefined)?.contents ?? [];
    const content = contents.find((entry) => typeof entry["text"] === "string" || typeof entry["blob"] === "string");
    if (content === undefined) {
        return undefined;
    }
    const html = typeof content["text"] === "string" ? content["text"] : Buffer.from(content["blob"] as string, "base64").toString("utf8");
    const meta = (content["_meta"] ?? {}) as Record<string, unknown>;
    const csp = ((meta["ui"] as Record<string, unknown> | undefined)?.["csp"] ?? {}) as Record<string, unknown>;
    const legacy = (meta["openai/widgetCSP"] ?? {}) as Record<string, unknown>;
    return { html, resourceDomains: [...domainsIn(csp["resourceDomains"]), ...domainsIn(legacy["resource_domains"])] };
};

// A tool call's result as an MCP call result, whatever shape the runtime handed its hook.
export const callResultOf = (response: unknown): Record<string, unknown> => {
    if (Array.isArray(response)) {
        return { content: response };
    }
    if (typeof response === "string") {
        return { content: [{ type: "text", text: response }] };
    }
    if (typeof response === "object" && response !== null && ("content" in response || "structuredContent" in response)) {
        return response as Record<string, unknown>;
    }
    return { content: [{ type: "text", text: JSON.stringify(response ?? null) }] };
};

export interface McpAppHostDeps {
    // The owner's connected MCP servers (mcp-kind capabilities), the only ones whose apps are drawn.
    readonly servers: readonly AgentTool[];
    readonly workspaceRoot: string;
    readonly conversationId?: string | undefined;
    readonly push: (event: AgentEvent) => void;
    readonly fetch?: typeof fetch;
    readonly onError?: (error: unknown) => void;
}

// One turn's host: each server's tool list read once, each app's HTML once, however often the agent calls its tools.
export class McpAppHost {
    private readonly clients = new Map<string, McpClient>();
    private readonly tools = new Map<string, Promise<ReadonlyMap<string, McpTool>>>();
    private readonly resources = new Map<string, Promise<AppResource | undefined>>();

    constructor(private readonly deps: McpAppHostDeps) {}

    private client(server: AgentTool): McpClient {
        let client = this.clients.get(server.name);
        if (client === undefined) {
            client = new McpClient(server, this.deps.fetch);
            this.clients.set(server.name, client);
        }
        return client;
    }

    // The server and tool a call names, among the connected servers; undefined for anything else's tool.
    serverOf(callName: string): { readonly server: AgentTool; readonly tool: string } | undefined {
        for (const server of this.deps.servers) {
            const prefix = `mcp__${spelled(server.name)}__`;
            if (callName.startsWith(prefix)) {
                return { server, tool: callName.slice(prefix.length) };
            }
        }
        return undefined;
    }

    private toolsOf(server: AgentTool): Promise<ReadonlyMap<string, McpTool>> {
        let listing = this.tools.get(server.name);
        if (listing === undefined) {
            listing = this.client(server)
                .tools()
                .then((tools) => new Map(tools.map((tool) => [spelled(tool.name), tool])));
            // A listing that failed is asked again next time rather than remembered as empty.
            listing.catch(() => this.tools.delete(server.name));
            this.tools.set(server.name, listing);
        }
        return listing;
    }

    private resourceOf(server: AgentTool, uri: string): Promise<AppResource | undefined> {
        const key = `${server.name} ${uri}`;
        let reading = this.resources.get(key);
        if (reading === undefined) {
            reading = this.client(server)
                .request("resources/read", { uri })
                .then(appResourceOf);
            reading.catch(() => this.resources.delete(key));
            this.resources.set(key, reading);
        }
        return reading;
    }

    // Draws the app for one finished call, when the tool has one; resolves with the page drawn, or undefined.
    async show(callName: string, input: unknown, response: unknown): Promise<Page | undefined> {
        const named = this.serverOf(callName);
        if (named === undefined) {
            return undefined;
        }
        const tool = (await this.toolsOf(named.server)).get(named.tool);
        const uri = tool === undefined ? undefined : uiResourceOf(tool);
        if (tool === undefined || uri === undefined) {
            return undefined;
        }
        const resource = await this.resourceOf(named.server, uri);
        if (resource === undefined) {
            return undefined;
        }
        const extraHosts = new Set(resource.resourceDomains.flatMap((domain) => URL.parse(domain.includes("://") ? domain : `https://${domain}`)?.hostname ?? []));
        // Nothing on disk is the app's: only what it names on the internet is carried in, from a CDN or a host it declared.
        const carried = await carryPage(resource.html, { baseDir: "/nonexistent", roots: [], extraHosts, ...(this.deps.fetch === undefined ? {} : { fetch: this.deps.fetch }) });
        const html = intoHead(carried.html, mcpAppDataScript({ server: named.server.name, tool: tool.name, input, result: callResultOf(response) }));
        const published = await publishPage({
            workspaceRoot: this.deps.workspaceRoot,
            conversationId: this.deps.conversationId,
            title: tool.title ?? tool.annotations?.title ?? `${named.server.name} · ${tool.name}`,
            html,
        });
        const page: Page = { ...published, app: { server: named.server.name, tool: tool.name } };
        this.deps.push({ kind: "page", page });
        return page;
    }

    // After every MCP call: drawn alongside the turn, never holding it, and any failure only logged; an app that cannot be
    // drawn leaves the call's own result standing, which is what a host without apps shows too.
    hooks(): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
        return {
            PostToolUse: [
                {
                    matcher: "^mcp__",
                    hooks: [
                        async (input) => {
                            if (input.hook_event_name === "PostToolUse" && this.serverOf(input.tool_name) !== undefined) {
                                void this.show(input.tool_name, input.tool_input, input.tool_response).catch((error: unknown) => this.deps.onError?.(error));
                            }
                            return {};
                        },
                    ],
                },
            ],
        };
    }
}

// What the route asks on a reader's behalf: one tool of the server the page names, only one the app may call.
// Without the reader's own press, only what the server says changes nothing.
export const callForApp = async (
    server: AgentTool,
    call: { readonly name: string; readonly arguments?: Record<string, unknown> | undefined; readonly pressed: boolean },
    doFetch?: typeof fetch,
): Promise<{ readonly refused: string } | { readonly result: unknown }> => {
    const { name } = call;
    const client = new McpClient(server, doFetch);
    const tool = (await client.tools()).find((candidate) => candidate.name === name);
    if (tool === undefined) {
        return { refused: `${server.name} has no tool "${name}".` };
    }
    if (!appMayCall(tool)) {
        return { refused: `${server.name} keeps "${name}" for the agent alone; its app may not call it.` };
    }
    if (!call.pressed && tool.annotations?.readOnlyHint !== true) {
        return { refused: `"${name}" can change things, so the app may call it only from the reader's own press.` };
    }
    const args = call.arguments;
    return { result: await client.request("tools/call", { name, arguments: args ?? {} }) };
};
