import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { CODEX_BINARY_MISSING, codexBinary } from "./codex-path.js";

/* THE CODEX CLIENT SURFACE INTENTIC ACTUALLY NEEDS.
 *
 * `codex app-server` publishes a generated protocol for rich clients, but vendoring its hundreds of generated
 * bindings would turn every Codex release into a repository-wide diff. This is the deliberately narrow boundary
 * the adapter consumes: the request fields Intentic sends and the item fields it renders. Unknown notifications
 * and item kinds pass by untouched, while malformed fields on a known kind fail at the process boundary instead
 * of becoming half-valid AgentEvents.
 *
 * The normalized event names are Intentic's provider-private vocabulary. Keeping them independent of JSON-RPC
 * makes the app-server process/client the one replaceable seam. */

export type CodexSandboxMode = "read-only" | "danger-full-access";
export type CodexReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh";

export interface CodexThreadOptions {
    readonly workingDirectory: string;
    readonly sandboxMode: CodexSandboxMode;
    readonly approvalPolicy: "never";
    readonly model?: string;
    readonly modelReasoningEffort?: CodexReasoningEffort;
}

type JsonValue = string | number | boolean | null | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export interface CodexTurn {
    readonly prompt: string;
    readonly images?: readonly string[];
    readonly sessionId?: string;
    readonly env: Record<string, string>;
    readonly modelProvider?: string;
    readonly config?: Readonly<Record<string, JsonValue>>;
    readonly options: CodexThreadOptions;
    readonly signal: AbortSignal;
}

interface CodexMcpContent {
    readonly type: string;
    readonly text?: string;
}

export type CodexItem =
    | { readonly id: string; readonly type: "agent_message"; readonly text: string }
    | { readonly id: string; readonly type: "reasoning"; readonly text: string }
    | {
          readonly id: string;
          readonly type: "command_execution";
          readonly command: string;
          readonly aggregated_output: string;
          readonly exit_code?: number;
          readonly status: "in_progress" | "completed" | "failed";
      }
    | {
          readonly id: string;
          readonly type: "file_change";
          readonly changes: readonly { readonly path: string; readonly kind: "add" | "delete" | "update" }[];
          readonly status: "in_progress" | "completed" | "failed";
      }
    | {
          readonly id: string;
          readonly type: "mcp_tool_call";
          readonly server: string;
          readonly tool: string;
          readonly status: "in_progress" | "completed" | "failed";
          readonly result?: { readonly content: readonly CodexMcpContent[] };
          readonly error?: { readonly message: string };
      }
    | { readonly id: string; readonly type: "web_search"; readonly query: string }
    | { readonly id: string; readonly type: "todo_list"; readonly items: readonly { readonly text: string; readonly completed: boolean }[] }
    | {
          readonly id: string;
          readonly type: "image_generation";
          readonly status: string;
          readonly revised_prompt?: string;
          readonly result: string;
          readonly saved_path?: string;
      }
    | { readonly id: string; readonly type: "context_compaction" };

interface CodexUsage {
    readonly input_tokens: number;
    readonly cached_input_tokens: number;
    readonly cache_write_input_tokens: number;
    readonly output_tokens: number;
    readonly reasoning_output_tokens: number;
}

export type CodexEvent =
    | { readonly type: "thread.started"; readonly thread_id: string }
    | { readonly type: "turn.started" }
    | { readonly type: "item.started" | "item.updated" | "item.completed"; readonly item: CodexItem }
    | { readonly type: "turn.completed"; readonly usage?: CodexUsage }
    | { readonly type: "turn.failed"; readonly error: { readonly message: string } }
    | { readonly type: "error"; readonly message: string };

export type CodexRunner = (turn: CodexTurn) => AsyncIterable<CodexEvent>;

type JsonObject = Record<string, unknown>;

const object = (value: unknown, what: string): JsonObject => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error(`Codex app-server sent invalid ${what}`);
    }
    return value as JsonObject;
};

const string = (record: JsonObject, key: string, what: string): string => {
    const value = record[key];
    if (typeof value !== "string") {
        throw new Error(`Codex app-server sent invalid ${what}.${key}`);
    }
    return value;
};

const number = (record: JsonObject, key: string, what: string): number => {
    const value = record[key];
    if (typeof value !== "number") {
        throw new Error(`Codex app-server sent invalid ${what}.${key}`);
    }
    return value;
};

const optionalString = (record: JsonObject, key: string, what: string): string | undefined => {
    const value = record[key];
    if (value === undefined || value === null) {
        return undefined;
    }
    if (typeof value !== "string") {
        throw new Error(`Codex app-server sent invalid ${what}.${key}`);
    }
    return value;
};

const status = (value: unknown, what: string): "in_progress" | "completed" | "failed" => {
    if (value === "inProgress") {
        return "in_progress";
    }
    if (value === "completed") {
        return "completed";
    }
    if (value === "failed" || value === "declined") {
        return "failed";
    }
    throw new Error(`Codex app-server sent invalid ${what}.status`);
};

const mcpContent = (value: unknown): CodexMcpContent | undefined => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return undefined;
    }
    const block = value as JsonObject;
    if (typeof block["type"] !== "string") {
        return undefined;
    }
    return { type: block["type"], ...(typeof block["text"] === "string" ? { text: block["text"] } : {}) };
};

const normalizeItem = (value: unknown): CodexItem | undefined => {
    const item = object(value, "thread item");
    const type = string(item, "type", "thread item");
    const id = string(item, "id", `${type} item`);
    if (type === "agentMessage") {
        return { id, type: "agent_message", text: string(item, "text", type) };
    }
    if (type === "reasoning") {
        const summary = item["summary"];
        if (!Array.isArray(summary) || !summary.every((part) => typeof part === "string")) {
            throw new Error("Codex app-server sent invalid reasoning.summary");
        }
        return { id, type: "reasoning", text: summary.join("\n") };
    }
    if (type === "commandExecution") {
        const exitCode = item["exitCode"];
        if (exitCode !== undefined && exitCode !== null && typeof exitCode !== "number") {
            throw new Error("Codex app-server sent invalid commandExecution.exitCode");
        }
        const aggregatedOutput = item["aggregatedOutput"];
        if (aggregatedOutput !== undefined && aggregatedOutput !== null && typeof aggregatedOutput !== "string") {
            throw new Error("Codex app-server sent invalid commandExecution.aggregatedOutput");
        }
        return {
            id,
            type: "command_execution",
            command: string(item, "command", type),
            aggregated_output: typeof aggregatedOutput === "string" ? aggregatedOutput : "",
            ...(typeof exitCode === "number" ? { exit_code: exitCode } : {}),
            status: status(item["status"], type),
        };
    }
    if (type === "fileChange") {
        const rawChanges = item["changes"];
        if (!Array.isArray(rawChanges)) {
            throw new Error("Codex app-server sent invalid fileChange.changes");
        }
        // Annotated because the `kind` guard below narrows a `string` to the three literals, and an object
        // literal with no contextual type widens it straight back — the element type has to come from here.
        const changes = rawChanges.map((value, index): { readonly path: string; readonly kind: "add" | "delete" | "update" } => {
            const change = object(value, `fileChange.changes[${index}]`);
            const kind = string(object(change["kind"], `fileChange.changes[${index}].kind`), "type", `fileChange.changes[${index}].kind`);
            if (kind !== "add" && kind !== "delete" && kind !== "update") {
                throw new Error(`Codex app-server sent invalid fileChange.changes[${index}].kind`);
            }
            return { path: string(change, "path", `fileChange.changes[${index}]`), kind };
        });
        return { id, type: "file_change", changes, status: status(item["status"], type) };
    }
    if (type === "mcpToolCall") {
        const rawResult = item["result"];
        const rawError = item["error"];
        let result: { readonly content: readonly CodexMcpContent[] } | undefined;
        if (rawResult !== undefined && rawResult !== null) {
            const resultRecord = object(rawResult, "mcpToolCall.result");
            const content = resultRecord["content"];
            if (!Array.isArray(content)) {
                throw new Error("Codex app-server sent invalid mcpToolCall.result.content");
            }
            result = { content: content.map(mcpContent).filter((block): block is CodexMcpContent => block !== undefined) };
        }
        let error: { readonly message: string } | undefined;
        if (rawError !== undefined && rawError !== null) {
            error = { message: string(object(rawError, "mcpToolCall.error"), "message", "mcpToolCall.error") };
        }
        return {
            id,
            type: "mcp_tool_call",
            server: string(item, "server", type),
            tool: string(item, "tool", type),
            status: status(item["status"], type),
            ...(result !== undefined ? { result } : {}),
            ...(error !== undefined ? { error } : {}),
        };
    }
    if (type === "webSearch") {
        return { id, type: "web_search", query: string(item, "query", type) };
    }
    if (type === "imageGeneration") {
        const revisedPrompt = optionalString(item, "revisedPrompt", type);
        const savedPath = optionalString(item, "savedPath", type);
        return {
            id,
            type: "image_generation",
            status: string(item, "status", type),
            ...(revisedPrompt !== undefined ? { revised_prompt: revisedPrompt } : {}),
            result: string(item, "result", type),
            ...(savedPath !== undefined ? { saved_path: savedPath } : {}),
        };
    }
    if (type === "contextCompaction") {
        return { id, type: "context_compaction" };
    }
    return undefined;
};

export interface AppServerNotification {
    readonly method: string;
    readonly params: unknown;
}

export interface CodexAppServerConnection {
    readonly request: (method: string, params: unknown) => Promise<unknown>;
    readonly notify: (method: string, params: unknown) => void;
    readonly notifications: AsyncIterable<AppServerNotification>;
    readonly close: () => void;
}

export type CodexAppServerConnector = (turn: CodexTurn) => Promise<CodexAppServerConnection>;

class AsyncQueue<T> implements AsyncIterable<T> {
    readonly #values: T[] = [];
    readonly #waiters: Array<{ readonly resolve: (result: IteratorResult<T>) => void; readonly reject: (error: unknown) => void }> = [];
    #ended = false;
    #error: unknown;

    push(value: T): void {
        if (this.#ended || this.#error !== undefined) {
            return;
        }
        const waiter = this.#waiters.shift();
        if (waiter !== undefined) {
            waiter.resolve({ done: false, value });
            return;
        }
        this.#values.push(value);
    }

    end(): void {
        if (this.#ended || this.#error !== undefined) {
            return;
        }
        this.#ended = true;
        for (const waiter of this.#waiters.splice(0)) {
            waiter.resolve({ done: true, value: undefined });
        }
    }

    fail(error: unknown): void {
        if (this.#ended || this.#error !== undefined) {
            return;
        }
        this.#error = error;
        for (const waiter of this.#waiters.splice(0)) {
            waiter.reject(error);
        }
    }

    [Symbol.asyncIterator](): AsyncIterator<T> {
        return {
            next: () => {
                const value = this.#values.shift();
                if (value !== undefined) {
                    return Promise.resolve({ done: false, value });
                }
                if (this.#error !== undefined) {
                    return Promise.reject(this.#error);
                }
                if (this.#ended) {
                    return Promise.resolve({ done: true, value: undefined });
                }
                return new Promise<IteratorResult<T>>((resolve, reject) => this.#waiters.push({ resolve, reject }));
            },
        };
    }
}

type CodexSpawn = (binary: string, args: readonly string[], env: Record<string, string>) => ChildProcessWithoutNullStreams;

const spawnCodex: CodexSpawn = (binary, args, env) => spawn(binary, args, { env, stdio: ["pipe", "pipe", "pipe"] });

const stdioConnector = (
    binaryPath: () => Promise<string | undefined> = codexBinary,
    spawnProcess: CodexSpawn = spawnCodex,
): CodexAppServerConnector =>
    async (turn) => {
        const binary = await binaryPath();
        if (binary === undefined) {
            throw new Error(CODEX_BINARY_MISSING);
        }
        const child = spawnProcess(binary, ["app-server", "--stdio"], turn.env);
        const notifications = new AsyncQueue<AppServerNotification>();
        const pending = new Map<number, { readonly resolve: (value: unknown) => void; readonly reject: (error: unknown) => void }>();
        let requestId = 0;
        let closing = false;
        let stderr = "";

        const fail = (error: unknown): void => {
            notifications.fail(error);
            for (const waiter of pending.values()) {
                waiter.reject(error);
            }
            pending.clear();
        };
        child.stderr.on("data", (chunk: Buffer | string) => {
            stderr = (stderr + chunk.toString()).slice(-4_096);
        });
        child.stdin.on("error", fail);
        child.once("error", fail);
        child.once("exit", (code, signal) => {
            if (closing) {
                notifications.end();
                return;
            }
            const detail = stderr.trim();
            fail(new Error(`Codex app-server exited (${signal ?? code ?? "unknown"})${detail === "" ? "" : `: ${detail}`}`));
        });

        const write = (message: unknown): void => {
            child.stdin.write(`${JSON.stringify(message)}\n`);
        };

        const lines = createInterface({ input: child.stdout });
        void (async () => {
            try {
                for await (const line of lines) {
                    if (line.trim() === "") {
                        continue;
                    }
                    const message = object(JSON.parse(line) as unknown, "JSON-RPC message");
                    const id = message["id"];
                    const method = message["method"];
                    if (typeof id === "number" && typeof method === "string") {
                        write({ id, error: { code: -32601, message: `Intentic does not handle app-server request ${method}` } });
                        continue;
                    }
                    if (typeof id === "number") {
                        const waiter = pending.get(id);
                        if (waiter === undefined) {
                            throw new Error(`Codex app-server answered unknown request ${id}`);
                        }
                        pending.delete(id);
                        if (message["error"] !== undefined) {
                            const error = object(message["error"], "JSON-RPC error");
                            waiter.reject(new Error(string(error, "message", "JSON-RPC error")));
                        } else {
                            waiter.resolve(message["result"]);
                        }
                        continue;
                    }
                    if (typeof method === "string") {
                        notifications.push({ method, params: message["params"] });
                    }
                }
                if (!closing) {
                    fail(new Error(`Codex app-server closed its output${stderr.trim() === "" ? "" : `: ${stderr.trim()}`}`));
                }
            } catch (error) {
                fail(error);
            }
        })();

        const abort = (): void => {
            if (!child.killed) {
                child.kill();
            }
        };
        turn.signal.addEventListener("abort", abort, { once: true });

        return {
            request: (method, params) => {
                requestId += 1;
                const id = requestId;
                return new Promise<unknown>((resolve, reject) => {
                    pending.set(id, { resolve, reject });
                    write({ method, id, params });
                });
            },
            notify: (method, params) => write({ method, params }),
            notifications,
            close: () => {
                closing = true;
                turn.signal.removeEventListener("abort", abort);
                child.stdin.end();
            },
        };
    };

const threadIdFrom = (value: unknown, method: string): string => {
    const result = object(value, `${method} result`);
    return string(object(result["thread"], `${method} result.thread`), "id", `${method} result.thread`);
};

const turnIdFrom = (value: unknown): string => {
    const result = object(value, "turn/start result");
    return string(object(result["turn"], "turn/start result.turn"), "id", "turn/start result.turn");
};

const sandboxPolicy = (mode: CodexSandboxMode): JsonValue => (mode === "read-only" ? { type: "readOnly", networkAccess: false } : { type: "dangerFullAccess" });

const usageFrom = (value: unknown): CodexUsage => {
    const params = object(value, "thread/tokenUsage/updated params");
    const tokenUsage = object(params["tokenUsage"], "thread/tokenUsage/updated params.tokenUsage");
    const last = object(tokenUsage["last"], "thread/tokenUsage/updated params.tokenUsage.last");
    return {
        input_tokens: number(last, "inputTokens", "token usage"),
        cached_input_tokens: number(last, "cachedInputTokens", "token usage"),
        cache_write_input_tokens: number(last, "cacheWriteInputTokens", "token usage"),
        output_tokens: number(last, "outputTokens", "token usage"),
        reasoning_output_tokens: number(last, "reasoningOutputTokens", "token usage"),
    };
};

const itemEvent = (method: "item/started" | "item/completed", value: unknown, turnId: string): CodexEvent | undefined => {
    const params = object(value, `${method} params`);
    if (string(params, "turnId", `${method} params`) !== turnId) {
        return undefined;
    }
    const item = normalizeItem(params["item"]);
    return item === undefined ? undefined : { type: method === "item/started" ? "item.started" : "item.completed", item };
};

const todoEvent = (value: unknown, turnId: string): CodexEvent | undefined => {
    const params = object(value, "turn/plan/updated params");
    if (string(params, "turnId", "turn/plan/updated params") !== turnId) {
        return undefined;
    }
    const plan = params["plan"];
    if (!Array.isArray(plan)) {
        throw new Error("Codex app-server sent invalid turn/plan/updated params.plan");
    }
    const items = plan.map((value, index) => {
        const step = object(value, `turn/plan/updated params.plan[${index}]`);
        return { text: string(step, "step", `turn/plan/updated params.plan[${index}]`), completed: step["status"] === "completed" };
    });
    return { type: "item.updated", item: { id: `plan-${turnId}`, type: "todo_list", items } };
};

export const createCodexAppServerRunner = (connect: CodexAppServerConnector = stdioConnector()): CodexRunner =>
    async function* runAppServerTurn(turn) {
        const connection = await connect(turn);
        try {
            await connection.request("initialize", {
                clientInfo: { name: "intentic", title: "Intentic", version: "1" },
                capabilities: { experimentalApi: true, requestAttestation: false },
            });
            connection.notify("initialized", {});

            const threadParams = {
                ...(turn.options.model !== undefined ? { model: turn.options.model } : {}),
                ...(turn.modelProvider !== undefined ? { modelProvider: turn.modelProvider } : {}),
                cwd: turn.options.workingDirectory,
                approvalPolicy: turn.options.approvalPolicy,
                sandbox: turn.options.sandboxMode,
                ...(turn.config !== undefined ? { config: turn.config } : {}),
            };
            const threadId =
                turn.sessionId === undefined
                    ? threadIdFrom(await connection.request("thread/start", threadParams), "thread/start")
                    : threadIdFrom(await connection.request("thread/resume", { threadId: turn.sessionId, ...threadParams }), "thread/resume");
            if (turn.sessionId === undefined) {
                yield { type: "thread.started", thread_id: threadId };
            }

            const input = [
                { type: "text", text: turn.prompt, text_elements: [] },
                ...(turn.images ?? []).map((path) => ({ type: "localImage", path })),
            ];
            const turnId = turnIdFrom(
                await connection.request("turn/start", {
                    threadId,
                    input,
                    cwd: turn.options.workingDirectory,
                    approvalPolicy: turn.options.approvalPolicy,
                    sandboxPolicy: sandboxPolicy(turn.options.sandboxMode),
                    ...(turn.options.model !== undefined ? { model: turn.options.model } : {}),
                    ...(turn.options.modelReasoningEffort !== undefined ? { effort: turn.options.modelReasoningEffort } : {}),
                }),
            );

            let usage: CodexUsage | undefined;
            for await (const notification of connection.notifications) {
                if (notification.method === "turn/started") {
                    const params = object(notification.params, "turn/started params");
                    const startedTurn = object(params["turn"], "turn/started params.turn");
                    if (string(startedTurn, "id", "turn/started params.turn") === turnId) {
                        yield { type: "turn.started" };
                    }
                    continue;
                }
                if (notification.method === "item/started" || notification.method === "item/completed") {
                    const event = itemEvent(notification.method, notification.params, turnId);
                    if (event !== undefined) {
                        yield event;
                    }
                    continue;
                }
                if (notification.method === "turn/plan/updated") {
                    const event = todoEvent(notification.params, turnId);
                    if (event !== undefined) {
                        yield event;
                    }
                    continue;
                }
                if (notification.method === "thread/tokenUsage/updated") {
                    const params = object(notification.params, "thread/tokenUsage/updated params");
                    if (string(params, "turnId", "thread/tokenUsage/updated params") === turnId) {
                        usage = usageFrom(params);
                    }
                    continue;
                }
                if (notification.method === "error") {
                    const params = object(notification.params, "error params");
                    if (string(params, "turnId", "error params") === turnId) {
                        yield { type: "error", message: string(object(params["error"], "error params.error"), "message", "error params.error") };
                    }
                    continue;
                }
                if (notification.method === "warning") {
                    const params = object(notification.params, "warning params");
                    if (params["threadId"] === undefined || params["threadId"] === null || params["threadId"] === threadId) {
                        yield { type: "error", message: string(params, "message", "warning params") };
                    }
                    continue;
                }
                if (notification.method === "turn/completed") {
                    const params = object(notification.params, "turn/completed params");
                    const completed = object(params["turn"], "turn/completed params.turn");
                    if (string(completed, "id", "turn/completed params.turn") !== turnId) {
                        continue;
                    }
                    const completedStatus = string(completed, "status", "turn/completed params.turn");
                    if (completedStatus === "failed") {
                        const error = object(completed["error"], "turn/completed params.turn.error");
                        yield { type: "turn.failed", error: { message: string(error, "message", "turn/completed params.turn.error") } };
                    } else if (completedStatus === "completed") {
                        yield { type: "turn.completed", ...(usage !== undefined ? { usage } : {}) };
                    } else if (completedStatus === "interrupted") {
                        yield { type: "turn.failed", error: { message: "Codex turn was interrupted" } };
                    } else {
                        throw new Error("Codex app-server sent invalid turn/completed params.turn.status");
                    }
                    return;
                }
            }
            throw new Error("Codex app-server ended before turn/completed");
        } finally {
            connection.close();
        }
    };
