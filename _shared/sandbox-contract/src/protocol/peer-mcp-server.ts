import { z } from "zod";
import { MCP_PROTOCOL_VERSION } from "./host-protocol.js";

// The MCP server a peer (device, browser) runs; the daemon forwards JSON-RPC verbatim, so the tool table here is the
// whole surface. A failed tool returns isError, never a JSON-RPC error. Each tool's zod schema is both what tools/list
// advertises and what a call is checked against.

export interface McpTool<Ctx> {
    readonly name: string;
    readonly description: string;
    // JSON Schema for `tools/list`, derived from the zod schema once at module load, not per request.
    readonly inputSchema: Record<string, unknown>;
    readonly call: (args: unknown, ctx: Ctx) => Promise<Record<string, unknown>>;
}

export const textResult = (text: string, isError = false): Record<string, unknown> => ({ content: [{ type: "text", text }], isError });

// Builds one tool from a single zod schema; the generic carries its type to the handler, and `McpTool` erases it again
// since the dispatch table holds every tool. `$schema` is dropped from the JSON Schema output as redundant.
export const tool = <Schema extends z.ZodType, Ctx>(spec: {
    readonly name: string;
    readonly description: string;
    readonly input: Schema;
    readonly run: (args: z.output<Schema>, ctx: Ctx) => Promise<Record<string, unknown>>;
}): McpTool<Ctx> => {
    const { $schema: _dialect, ...inputSchema } = z.toJSONSchema(spec.input, { io: "input" });
    return {
        name: spec.name,
        description: spec.description,
        inputSchema,
        call: async (args, ctx) => {
            const parsed = spec.input.safeParse(args);
            // Readable enough for a model to fix its own call: which field, and what was expected.
            return parsed.success ? await spec.run(parsed.data, ctx) : textResult(z.prettifyError(parsed.error), true);
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
    const listing = spec.tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
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
