import type { sandboxContract } from "@intentic/sandbox-contract";
import type { ContractRouterClient } from "@orpc/contract";

// Backend counterpart to `IntenticApi` (api.ts); a manifest `server` bundle's `activateServer` runs in a node process
// shared by every enabled extension, separate from the daemon. Mediates only the extension's route namespace (mount)
// and its reach into daemon routes (`daemon.*`, gated by `permissions.daemon`).

// The card a tool server was mounted for (`contributes.tools.perCard`): its id, which names the server the agent sees,
// and its settings as the daemon holds them now, secrets included, every value a string. Handed with every call, so a
// switch flipped on the card applies to the next call without anything to invalidate.
export interface ToolCard {
    readonly id: string;
    readonly config: Readonly<Record<string, string>>;
}

// One piece of what a tool answers, as MCP carries it.
export type ToolContent =
    | { readonly type: "text"; readonly text: string }
    | { readonly type: "image"; readonly data: string; readonly mimeType: string };

// A tool's whole answer. `isError` marks a refusal or a failure the model should read rather than a transport error.
export interface ToolResult {
    readonly content: readonly ToolContent[];
    readonly isError?: boolean;
}

// What one call is handed beside its arguments.
export interface ToolCallContext {
    // Aborted when the agent's client gives up on the call, or the host's deadline for it passes.
    readonly signal: AbortSignal;
    // The conversation the calling turn belongs to, when it has one.
    readonly conversationId?: string;
}

export interface ToolDefinition {
    // The name the model calls it by, under the server's own `mcp__<server>__` prefix.
    readonly name: string;
    readonly description: string;
    // A JSON Schema object for the arguments (`z.toJSONSchema(schema)` produces one).
    readonly inputSchema: Readonly<Record<string, unknown>>;
    // A string answers as text, a ToolResult as itself, anything else as its JSON; a throw answers as a tool error.
    readonly call: (args: Readonly<Record<string, unknown>>, context: ToolCallContext) => Promise<ToolResult | string | unknown> | ToolResult | string | unknown;
}

// One request into this extension's `/x/<id>` namespace, prefix already stripped. Return `undefined` for "not mine":
// the host answers 404.
export type BackendRouteHandler = (request: Request) => Promise<Response | undefined>;

export interface ExtensionServerApi {
    // The host's @intentic/extension-api version, checked against `engines.intentic`.
    readonly apiVersion: string;
    // Absolute workspace root; the backend reads and writes it directly via node's `fs`, no file service in between.
    readonly workspaceRoot: string;
    // This extension's own checkout (absolute), where its bundled assets sit.
    readonly extensionDir: string;
    // A line in the daemon's log, attributed to this extension.
    readonly log: (message: string) => void;
    readonly routes: {
        // Serves this extension's route namespace; the daemon proxies /x/<id>/* here through its ordinary auth. A
        // second mount replaces the first.
        mount(handler: BackendRouteHandler): void;
    };
    // The agent's tools (`contributes.tools`). The host owns the MCP transport, its deadlines and the card lookup: it
    // answers the handshake, lists what `tools` returns for the card a server was mounted for (undefined for an
    // extension-level server), and runs a call with its arguments. `tools` runs per request, so what it returns may
    // follow the card's switches. A second serve replaces the first.
    readonly tools: {
        serve(tools: (card: ToolCard | undefined) => readonly ToolDefinition[] | Promise<readonly ToolDefinition[]>): void;
    };
    // Authenticated transport to the daemon's own routes; every call is checked against the manifest's
    // `permissions.daemon` allowlist.
    readonly daemon: {
        // The daemon's contract, typed: a call names a procedure and its answer arrives parsed by the procedure's output
        // schema. Refused before anything is sent unless `permissions.daemon` covers the method and path it resolves to.
        readonly rpc: ContractRouterClient<typeof sandboxContract>;
        // For what the contract does not carry: bytes (`/workspace/raw`) and the daemon's hand-written routes.
        request(path: string, init?: RequestInit): Promise<Response>;
        json<T>(path: string, init?: RequestInit): Promise<T>;
    };
}

export interface ExtensionServerContext {
    // This extension's routing id, its /x/<id> namespace segment.
    readonly extensionId: string;
}

// Shape of the manifest `server` bundle's default (or named) export; `activateServer` runs once per backend-host start.
// No deactivate: retirement is the host process ending.
export interface ExtensionServerModule {
    activateServer(api: ExtensionServerApi, context: ExtensionServerContext): void | Promise<void>;
}
