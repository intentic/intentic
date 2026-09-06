import { z } from "zod";
import { MCP_PROTOCOL_VERSION } from "./host-protocol.js";

/* THE MCP SERVER A PEER RUNS, on the peer, not in the sandbox.
 *
 * The sandbox's daemon forwards JSON-RPC verbatim and interprets none of it, so the tool table handed to this is
 * the entire tool surface: what a device or a browser can do is decided by the build installed on it, and a
 * peer that upgrades learns new tools without anything changing in the sandbox. That is the reason for the
 * split; the alternative (schemas in the daemon, execution on the peer) makes every new tool a coordinated
 * release of two products.
 *
 * The protocol implemented is the subset a Streamable HTTP client actually uses against a stateless server:
 * initialize, tools/list, tools/call, ping, and notifications (which get no reply). Anything else answers
 * "method not found", which is the correct JSON-RPC response and not an error worth logging.
 *
 * A FAILED TOOL IS NOT A FAILED CALL. Every error, a refused scope, a missing file, a command that exited 1, an
 * argument that does not typecheck, comes back as a normal result with isError, because that is what a model can
 * read and act on; a JSON-RPC error surfaces as a transport fault and invites a retry loop against a peer that
 * will refuse it exactly the same way the second time.
 *
 * EACH TOOL'S ARGUMENTS ARE DESCRIBED ONCE. The zod schema a tool is built with is what the model is shown
 * (`tools/list` publishes it as JSON Schema) AND what an arriving call is checked against, so the advertised
 * shape and the accepted one cannot drift, the failure mode of writing both by hand, where a renamed field
 * keeps validating and the model keeps being told about the old name. A handler receives its arguments typed. */

export interface McpTool<Ctx> {
    readonly name: string;
    readonly description: string;
    // JSON Schema for `tools/list`, derived from the zod schema once at module load rather than per request.
    readonly inputSchema: Record<string, unknown>;
    readonly call: (args: unknown, ctx: Ctx) => Promise<Record<string, unknown>>;
}

export const textResult = (text: string, isError = false): Record<string, unknown> => ({ content: [{ type: "text", text }], isError });

/* One tool, from the only description of its arguments there is. The generic is what carries the schema's type
 * through to the handler's parameter; `McpTool` erases it again, because the dispatch table holds them all and
 * the parse is what re-establishes the type at the boundary. `Ctx` is what the peer hands every call beside
 * its arguments: a device's live grant, nothing for a browser.
 *
 * `$schema` is dropped: the enclosing tool entry already says what this document is, and MCP clients read the
 * keywords rather than the dialect declaration. */
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
            // Readable enough for a model to fix its own call: which field, and what was expected there.
            return parsed.success ? await spec.run(parsed.data, ctx) : textResult(z.prettifyError(parsed.error), true);
        },
    };
};

// What the peer's audit log is told about one call: the arguments verbatim (redaction is the peer's, it knows
// which of its tools carry typed secrets), and how it ended. A tool that answered with isError is `ok: false`
// with no message; one that threw carries what it said, and whether it was the peer's own refusal.
export interface McpAuditEntry {
    readonly tool: string;
    readonly args: Record<string, unknown>;
    readonly ok: boolean;
    readonly failure?: { readonly refused: boolean; readonly message: string };
}

export interface McpServerSpec<Ctx> {
    readonly serverInfo: () => { readonly name: string; readonly version: string };
    readonly tools: readonly McpTool<Ctx>[];
    // The sentence for a tool this peer does not have, in the peer's own noun.
    readonly noSuchTool: (name: string) => string;
    // Whether a thrown error is this peer's own refusal (a switch that is off, a site that is not granted) as
    // opposed to a tool that failed: the audit line says which.
    readonly refused: (error: unknown) => boolean;
    readonly errorMessage: (error: unknown) => string;
    // Every call, accepted or refused, once it has an outcome. Best-effort: a log that cannot be written must
    // never fail the answer, so a rejection here is swallowed.
    readonly audit: (entry: McpAuditEntry) => Promise<void> | void;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

// Handle one JSON-RPC message. Returns the response, or undefined for a notification (nothing to answer). `ctx`
// is read per call by the tool that runs, so a grant pushed mid-session takes effect on the very next call.
export const createMcpServer = <Ctx>(spec: McpServerSpec<Ctx>): ((message: unknown, ctx: Ctx) => Promise<Record<string, unknown> | undefined>) => {
    const byName = new Map(spec.tools.map((entry) => [entry.name, entry]));
    const listing = spec.tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
    const audited = async (entry: McpAuditEntry): Promise<void> => {
        try {
            await spec.audit(entry);
        } catch {
            // Deliberately silent: a record for a human, never a control.
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
