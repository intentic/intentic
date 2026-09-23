// Named imports rather than the `z` namespace: this module is bundled into the browser extension, where the
// namespace keeps zod's 60 locales (~250 kB) that esbuild can otherwise drop. _devices/webext/scripts/size-budget.mjs holds the ceiling.
import { prettifyError, toJSONSchema } from "zod";
import type * as z from "zod";

// The MCP version every peer announces, here rather than in host-protocol.ts because a browser extension bundles this
// module and would otherwise carry the machine handshake's schemas to a store. Also read by the daemon's peer bridge,
// which answers `initialize` itself while a peer is asleep.
export const MCP_PROTOCOL_VERSION = "2025-06-18";

// The MCP server a peer (device, browser) runs; the daemon forwards JSON-RPC verbatim, so the tool table here is the
// whole surface. A failed tool returns isError, never a JSON-RPC error. Each tool's zod schema is both what tools/list
// advertises and what a call is checked against.

// What one call can do to the world: `read` changes nothing, so a runtime may run several at once and allow it where
// writes are held; `write` changes something recoverable; `destructive` may lose something.
export type ToolEffect = "read" | "write" | "destructive";

// MCP tool annotations for an effect. Both hints are always spelled out: an absent destructiveHint reads as true.
export const toolAnnotations = (effect: ToolEffect): { readonly readOnlyHint: boolean; readonly destructiveHint: boolean } => ({
    readOnlyHint: effect === "read",
    destructiveHint: effect === "destructive",
});

export interface McpTool<Ctx> {
    readonly name: string;
    readonly description: string;
    // JSON Schema for `tools/list`, derived from the zod schema once at module load, not per request.
    readonly inputSchema: Record<string, unknown>;
    readonly annotations: ReturnType<typeof toolAnnotations>;
    readonly call: (args: unknown, ctx: Ctx) => Promise<Record<string, unknown>>;
}

export const textResult = (text: string, isError = false): Record<string, unknown> => ({ content: [{ type: "text", text }], isError });

// Every tool schema has to survive llama.cpp's grammar converter, which is how a local model is held to a tool's shape:
// it reads `items` before `prefixItems` and refuses a boolean schema, so zod's closed-tuple form (`items: false`) fails
// the conversion of the WHOLE tool set, not just its own tool. Length is what closes a tuple, and `maxItems` still says
// it, so no other reader sees a different shape. Applied again by the daemon's bridge, whose peers are separately
// installed software that can be any age.
export const converterReadable = (value: unknown): unknown => {
    if (Array.isArray(value)) {
        return value.map(converterReadable);
    }
    if (typeof value !== "object" || value === null) {
        return value;
    }
    const node = value as Record<string, unknown>;
    const prefix = node["prefixItems"];
    const tupleLength = node["items"] === false && Array.isArray(prefix) ? prefix.length : undefined;
    const walked = Object.fromEntries(
        Object.entries(node).flatMap(([key, child]) => (tupleLength !== undefined && key === "items" ? [] : [[key, converterReadable(child)] as const])),
    );
    return tupleLength === undefined ? walked : { ...walked, maxItems: tupleLength };
};

// Builds one tool from a single zod schema; the generic carries its type to the handler, and `McpTool` erases it again
// since the dispatch table holds every tool. `$schema` is dropped from the JSON Schema output as redundant.
export const tool = <Schema extends z.ZodType, Ctx>(spec: {
    readonly name: string;
    readonly description: string;
    readonly effect: ToolEffect;
    readonly input: Schema;
    readonly run: (args: z.output<Schema>, ctx: Ctx) => Promise<Record<string, unknown>>;
}): McpTool<Ctx> => {
    const { $schema: _dialect, ...inputSchema } = toJSONSchema(spec.input, { io: "input" });
    return {
        name: spec.name,
        description: spec.description,
        inputSchema: converterReadable(inputSchema) as Record<string, unknown>,
        annotations: toolAnnotations(spec.effect),
        call: async (args, ctx) => {
            const parsed = spec.input.safeParse(args);
            // Readable enough for a model to fix its own call: which field, and what was expected.
            return parsed.success ? await spec.run(parsed.data, ctx) : textResult(prettifyError(parsed.error), true);
        },
    };
};

// What the peer's audit log is told about one call: arguments verbatim (redaction is the peer's job) and how it ended.
// isError is `ok: false` with no message; a throw carries its message and whether it was a refusal.
export interface McpAuditEntry {
    readonly tool: string;
    readonly args: Record<string, unknown>;
    readonly ok: boolean;
    readonly failure?: { readonly refused: boolean; readonly message: string };
}

export interface McpServerSpec<Ctx> {
    readonly serverInfo: () => { readonly name: string; readonly version: string };
    readonly tools: readonly McpTool<Ctx>[];
    // Message for an unknown tool, phrased in the peer's own vocabulary.
    readonly noSuchTool: (name: string) => string;
    // Whether a thrown error is the peer's own refusal (a disabled switch, an ungranted site) rather than a tool
    // failure.
    readonly refused: (error: unknown) => boolean;
    readonly errorMessage: (error: unknown) => string;
    // Called with every outcome; best-effort, a logging failure here must never fail the answer.
    readonly audit: (entry: McpAuditEntry) => Promise<void> | void;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

// Handles one JSON-RPC message; returns undefined for a notification. `ctx` is read per call, so a grant pushed
// mid-session takes effect on the next call.
export const createMcpServer = <Ctx>(spec: McpServerSpec<Ctx>): ((message: unknown, ctx: Ctx) => Promise<Record<string, unknown> | undefined>) => {
    const byName = new Map(spec.tools.map((entry) => [entry.name, entry]));
    const listing = spec.tools.map(({ name, description, inputSchema, annotations }) => ({ name, description, inputSchema, annotations }));
    const audited = async (entry: McpAuditEntry): Promise<void> => {
        try {
            await spec.audit(entry);
        } catch {
            // Silent: this log is for a human, never a control.
        }
    };

    const callTool = async (name: string, args: Record<string, unknown>, ctx: Ctx): Promise<Record<string, unknown>> => {
        const found = byName.get(name);
        if (found === undefined) {
            return textResult(spec.noSuchTool(name), true);
        }
        try {
            const result = await found.call(args, ctx);
            await audited({ tool: name, args, ok: result["isError"] !== true });
            return result;
        } catch (error) {
            const message = spec.errorMessage(error);
            await audited({ tool: name, args, ok: false, failure: { refused: spec.refused(error), message } });
            return textResult(message, true);
        }
    };

    return async (message, ctx) => {
        if (!isRecord(message)) {
            return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "invalid request" } };
        }
        const id = message["id"];
        if (id === undefined) {
            return undefined;
        }
        const method = message["method"];
        const reply = (result: Record<string, unknown>): Record<string, unknown> => ({ jsonrpc: "2.0", id, result });
        if (method === "initialize") {
            return reply({ protocolVersion: MCP_PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: spec.serverInfo() });
        }
        if (method === "ping") {
            return reply({});
        }
        if (method === "tools/list") {
            return reply({ tools: listing });
        }
        if (method === "tools/call") {
            const params = isRecord(message["params"]) ? message["params"] : {};
            const name = typeof params["name"] === "string" ? params["name"] : "";
            const args = isRecord(params["arguments"]) ? params["arguments"] : {};
            return reply(await callTool(name, args, ctx));
        }
        return { jsonrpc: "2.0", id, error: { code: -32601, message: `method "${String(method)}" is not supported` } };
    };
};
