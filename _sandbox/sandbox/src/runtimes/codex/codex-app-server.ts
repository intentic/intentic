import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { spawnAs } from "../../workload/workload-class.js";
import { whenAborted } from "@intentic/base/async";
import { namespaceTargetOf, nsenterArgv, type NamespaceEntryReference } from "../../workload/namespace-entry.js";
import { CODEX_BINARY_MISSING, codexBinary } from "./codex-path.js";
import { type CodexSubagentThreads, codexSubagentThreads } from "./codex-subagents.js";
import { opt } from "../../opt.js";
import { jsonLines, outputTail } from "../stdio/child-output.js";
import { z } from "zod";

// Codex client surface: the request fields Intentic sends and the item fields it renders, not the full generated
// protocol. Unknown notifications/item kinds pass through untouched; malformed fields on a known kind fail at the
// boundary. Event names are Intentic's own vocabulary, independent of JSON-RPC.

export type CodexSandboxMode = "read-only" | "danger-full-access";
export type CodexReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";

export interface CodexThreadOptions {
    readonly workingDirectory: string;
    readonly sandboxMode: CodexSandboxMode;
    // never is the standing posture (container is the isolation boundary); untrusted is asked only when the owner's
    // rules could refuse something.
    readonly approvalPolicy: "never" | "untrusted";
    readonly model?: string;
    readonly modelReasoningEffort?: CodexReasoningEffort;
}

export type JsonValue = string | number | boolean | null | readonly JsonValue[] | { readonly [key: string]: JsonValue };

// Where the app-server process is born: the pid holding the turn's mount namespace, and the workspace root as it sees
// it. Present only for an isolated turn; absent means spawned plainly, cwd'd into workingDirectory.
export interface CodexNamespace {
    readonly pid: number;
    readonly cwd: string;
    // Daemon-local capability, never sent to app-server; optional only for legacy root-mode descriptors.
    readonly namespace?: NamespaceEntryReference;
}

export interface CodexTurn {
    readonly prompt: string;
    readonly images?: readonly string[];
    readonly sessionId?: string;
    readonly env: Record<string, string>;
    readonly modelProvider?: string;
    readonly config?: Readonly<Record<string, JsonValue>>;
    readonly options: CodexThreadOptions;
    // Each message here delivers to the running turn as turn/steer; per-turn, not shared, since plan emulation runs two
    // app-servers in sequence.
    readonly steering?: AsyncIterable<string>;
    // Stops admission at a phase boundary, before terminal frames suspend the consumer.
    readonly closeSteering?: () => void;
    readonly namespace?: CodexNamespace;
    // How deep the turn's conversation sits under the spawns above it: the app-server's OOM rank (workload-class.ts).
    readonly spawnDepth?: number;
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
    | { readonly id: string; readonly type: "context_compaction" }
    | {
          readonly id: string;
          // One of Codex's multi-agent tools: spawnAgent, wait, sendInput, resumeAgent, closeAgent, or a later one.
          readonly type: "collab_agent_tool_call";
          readonly tool: string;
          readonly status: "in_progress" | "completed" | "failed";
          readonly prompt?: string;
          readonly model?: string;
          // The threads the call acted on: the one it spawned, the ones it waited on or wrote to.
          readonly receivers: readonly string[];
          // How each of those stood as the call ended, in Codex's words, with what it said last.
          readonly states: Readonly<Record<string, { readonly status: string; readonly message?: string }>>;
      };

interface CodexUsage {
    readonly input_tokens: number;
    readonly cached_input_tokens: number;
    readonly cache_write_input_tokens: number;
    readonly output_tokens: number;
    readonly reasoning_output_tokens: number;
}

// One skill the thread's cwd publishes (skills/list), Codex's answer to a slash command. path travels too: invoking a
// skill needs both name and directory.
export interface CodexSkill {
    readonly name: string;
    readonly description: string;
    readonly path: string;
}

// One question from the experimental item/tool/requestUserInput request. options is empty for an open-ended question;
// secret marks an answer withheld from the transcript.
export interface CodexQuestion {
    readonly id: string;
    readonly header: string;
    readonly question: string;
    readonly options: readonly { readonly label: string; readonly description: string }[];
    readonly secret: boolean;
}

export type CodexEvent =
    | { readonly type: "thread.started"; readonly thread_id: string }
    | { readonly type: "turn.started" }
    // `parent` is the spawn call whose subagent's thread the item came from; absent, it is the turn's own.
    | { readonly type: "item.started" | "item.updated" | "item.completed"; readonly item: CodexItem; readonly parent?: string }
    // A subagent's own turn ended, in its thread; `parent` is the spawn call that started it.
    | { readonly type: "subagent.ended"; readonly parent: string; readonly status: "completed" | "failed" | "killed"; readonly error?: string }
    // What a subagent has spent so far over its whole thread.
    | {
          readonly type: "subagent.usage";
          readonly parent: string;
          readonly input: number;
          readonly output: number;
          readonly cacheRead?: number;
          readonly cacheCreation?: number;
      }
    | { readonly type: "commands"; readonly skills: readonly CodexSkill[] }
    // The one server-initiated request answered as an event, so the consumer raises a card, waits, and calls respond
    // while the loop stays parked (app-server is blocked too). respond takes one entry per question id; others are
    // ignored.
    | {
          readonly type: "user_input.requested";
          readonly questions: readonly CodexQuestion[];
          readonly respond: (answers: Readonly<Record<string, readonly string[]>>) => void;
      }
    // A command Codex wants a verdict on (item/commandExecution/requestApproval). command is the classifier's text;
    // reason is Codex's own words, shown on the card. respond blocks the turn, the same as a Bash hook's hold.
    | {
          readonly type: "command_approval.requested";
          readonly command: string;
          readonly reason?: string;
          // Where Codex will run it, when the request says; the gate places an install by it.
          readonly cwd?: string;
          readonly respond: (allow: boolean) => void;
      }
    | { readonly type: "turn.completed"; readonly usage?: CodexUsage }
    | { readonly type: "turn.failed"; readonly error: { readonly message: string } }
    | { readonly type: "error"; readonly message: string }
    // Codex's separate advisory channel: the turn carries on regardless, so this is never a failure. Kept apart from
    // `error` because the two read alike but mean opposite things.
    | { readonly type: "warning"; readonly message: string }
    // Rate limits pushed by app-server (account/rateLimits/updated), the same windows ChatGPT's usage endpoint answers
    // with. Passed through raw; usage/translator-usage.ts is the one place that parses the snapshot shape.
    | { readonly type: "rate_limits"; readonly snapshot: unknown };

export type CodexRunner = (turn: CodexTurn) => AsyncIterable<CodexEvent>;

type JsonObject = Record<string, unknown>;

const object = (value: unknown, what: string): JsonObject => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error(`Codex app-server sent invalid ${what}`);
    }
    return value as JsonObject;
};

// The tolerant twin of `object`, for a payload whose shape must not throw the turn.
const maybeObject = (value: unknown): JsonObject | undefined =>
    typeof value === "object" && value !== null && !Array.isArray(value) ? (value as JsonObject) : undefined;

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
        // Return type is explicit: the guard below narrows a string, but an untyped literal would widen it back.
        const changes = rawChanges.map((entry, index): { readonly path: string; readonly kind: "add" | "delete" | "update" } => {
            const change = object(entry, `fileChange.changes[${index}]`);
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

// Notifications and requests share one queue: splitting them could render a question card after the next tool call.
// Unhandled requests are refused on arrival (HANDLED_REQUESTS), since app-server can block before turn/start returns.
export type AppServerMessage =
    | ({ readonly kind: "notification" } & AppServerNotification)
    | ({ readonly kind: "request"; readonly respond: (result: JsonValue) => void } & AppServerNotification);

export interface CodexAppServerConnection {
    readonly request: (method: string, params: unknown) => Promise<unknown>;
    readonly notify: (method: string, params: unknown) => void;
    readonly messages: AsyncIterable<AppServerMessage>;
    readonly close: () => void;
}

// Server-initiated requests Intentic answers; anything else gets a JSON-RPC method-not-found.
const COMMAND_APPROVAL_REQUEST = "item/commandExecution/requestApproval";
const FILE_CHANGE_APPROVAL_REQUEST = "item/fileChange/requestApproval";
const PERMISSIONS_APPROVAL_REQUEST = "item/permissions/requestApproval";
const ELICITATION_REQUEST = "mcpServer/elicitation/request";
const HANDLED_REQUESTS = new Set([
    "item/tool/requestUserInput",
    COMMAND_APPROVAL_REQUEST,
    FILE_CHANGE_APPROVAL_REQUEST,
    PERMISSIONS_APPROVAL_REQUEST,
    ELICITATION_REQUEST,
]);

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

type CodexSpawn = (binary: string, args: readonly string[], env: Record<string, string>, spawnDepth: number) => ChildProcessWithoutNullStreams;

const spawnCodex: CodexSpawn = (binary, args, env, spawnDepth) =>
    spawnAs({ class: "agentRuntime", spawnDepth }, binary, args, { env, stdio: ["pipe", "pipe", "pipe"] });

export const stdioConnector =
    (binaryPath: () => Promise<string | undefined> = codexBinary, spawnProcess: CodexSpawn = spawnCodex): CodexAppServerConnector =>
    async (turn) => {
        const binary = await binaryPath();
        if (binary === undefined) {
            throw new Error(CODEX_BINARY_MISSING);
        }
        // nsenter execs app-server into the turn's anchor, staying a direct child; its cwd wins over workingDirectory.
        const argv =
            turn.namespace === undefined
                ? { command: binary, args: ["app-server", "--stdio"] }
                : nsenterArgv(namespaceTargetOf(turn.namespace), turn.namespace.cwd, binary, ["app-server", "--stdio"]);
        const child = spawnProcess(argv.command, argv.args, turn.env, turn.spawnDepth ?? 0);
        const messages = new AsyncQueue<AppServerMessage>();
        const pending = new Map<number, { readonly resolve: (value: unknown) => void; readonly reject: (error: unknown) => void }>();
        let requestId = 0;
        let closing = false;
        // What the server said on the way down, folded into the error that ends the turn.
        const stderr = outputTail(4_096);
        let ownThreadId: string | undefined;
        let active: { threadId: string; turnId: string } | undefined;
        let interrupted: string | undefined;
        let abortTimer: ReturnType<typeof setTimeout> | undefined;
        const kill = (): void => {
            if (!child.killed) {
                child.kill();
            }
        };
        const request: CodexAppServerConnection["request"] = (method, params) => {
            if (method === "turn/start" || method === "turn/steer") {
                ownThreadId = string(object(params, `${method} params`), "threadId", `${method} params`);
            }
            requestId += 1;
            const id = requestId;
            return new Promise<unknown>((resolve, reject) => {
                pending.set(id, { resolve, reject });
                write({ method, id, params });
            });
        };
        const interrupt = (): void => {
            if (active !== undefined && interrupted !== active.turnId) {
                interrupted = active.turnId;
                // The bounded kill remains the escape hatch for a refusal or an unresponsive server.
                void request("turn/interrupt", active).catch(() => undefined);
            }
        };

        const observeTurn = (method: string, params: z.infer<typeof TurnScopeSchema>): void => {
            if (params.threadId !== ownThreadId) {
                return;
            }
            const turnId = params.turn.id;
            if (method === "turn/started") {
                active = { threadId: params.threadId, turnId };
                if (turn.signal.aborted) {
                    interrupt();
                }
                return;
            }
            if (active?.turnId === turnId) {
                active = undefined;
                if (abortTimer !== undefined) {
                    clearTimeout(abortTimer);
                }
            }
        };

        const fail = (error: unknown): void => {
            messages.fail(error);
            for (const waiter of pending.values()) {
                waiter.reject(error);
            }
            pending.clear();
        };
        stderr.follow(child.stderr);
        child.stdin.on("error", fail);
        child.once("error", fail);
        child.once("exit", (code, signal) => {
            if (closing) {
                messages.end();
                return;
            }
            const detail = stderr.text().trim();
            fail(new Error(`Codex app-server exited (${signal ?? code ?? "unknown"})${detail === "" ? "" : `: ${detail}`}`));
        });

        const write = (message: unknown): void => {
            child.stdin.write(`${JSON.stringify(message)}\n`);
        };

        const answerPending = (id: number, message: JsonObject): void => {
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
            return;
        };

        void (async () => {
            try {
                for await (const line of jsonLines(child.stdout)) {
                    const message = object(JSON.parse(line) as unknown, "JSON-RPC message");
                    const id = message["id"];
                    const method = message["method"];
                    if (typeof id === "number" && typeof method === "string") {
                        if (!HANDLED_REQUESTS.has(method)) {
                            write({ id, error: { code: -32601, message: `Intentic does not handle app-server request ${method}` } });
                            continue;
                        }
                        messages.push({
                            kind: "request",
                            method,
                            params: message["params"],
                            respond: (result) => write({ id, result }),
                        });
                        continue;
                    }
                    if (typeof id === "number") {
                        answerPending(id, message);
                        continue;
                    }
                    if (typeof method === "string") {
                        if (method === "turn/started" || method === "turn/completed") {
                            observeTurn(method, TurnScopeSchema.parse(message["params"]));
                        }
                        messages.push({ kind: "notification", method, params: message["params"] });
                    }
                }
                if (!closing) {
                    const detail = stderr.text().trim();
                    fail(new Error(`Codex app-server closed its output${detail === "" ? "" : `: ${detail}`}`));
                }
            } catch (error) {
                fail(error);
            }
        })();

        const abort = (): void => {
            interrupt();
            abortTimer = setTimeout(kill, 3_000);
        };
        // binaryPath() is async; an already-stopped turn still gets a bounded shutdown.
        const unwatchAbort = whenAborted(turn.signal, abort);

        return {
            request,
            notify: (method, params) => write({ method, params }),
            messages,
            close: () => {
                closing = true;
                unwatchAbort();
                if (abortTimer !== undefined) {
                    clearTimeout(abortTimer);
                }
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

const sandboxPolicy = (mode: CodexSandboxMode): JsonValue =>
    mode === "read-only" ? { type: "readOnly", networkAccess: false } : { type: "dangerFullAccess" };

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

// What this client reads of Codex's multi-agent calls and of its subagents' threads, parsed at the stream, tolerantly past
// what identifies them: a subagent's bookkeeping in another shape is left out rather than failing the turn.
const CollabItemSchema = z.object({
    type: z.literal("collabAgentToolCall"),
    id: z.string(),
    tool: z.string(),
    status: z.string(),
    prompt: z.string().nullish().catch(undefined),
    model: z.string().nullish().catch(undefined),
    receiverThreadIds: z.array(z.string()).catch([]),
    agentsStates: z.record(z.string(), z.object({ status: z.string(), message: z.string().nullish().catch(undefined) })).catch({}),
});
const CollabParamsSchema = z.object({ item: CollabItemSchema });
const TurnScopeSchema = z.object({ threadId: z.string(), turn: z.object({ id: z.string() }) });
const ThreadParamsSchema = z.object({ threadId: z.string() });
const RequestScopeSchema = z.object({ turnId: z.string().optional().catch(undefined), threadId: z.string().optional().catch(undefined) });
const UsageParamsSchema = z.object({
    tokenUsage: z.object({
        total: z.object({
            inputTokens: z.number(),
            outputTokens: z.number(),
            cachedInputTokens: z.number().default(0),
            cacheWriteInputTokens: z.number().default(0),
        }),
    }),
});
const EndingParamsSchema = z.object({ turn: z.object({ status: z.string(), error: z.object({ message: z.string() }).nullish().catch(undefined) }) });

// A multi-agent call's standing; an interrupted one ended without doing what it was asked, which reads as failed.
const collabStatus = (standing: string): "in_progress" | "completed" | "failed" => {
    if (standing === "inProgress") {
        return "in_progress";
    }
    return standing === "completed" ? "completed" : "failed";
};

// The multi-agent call an item notification carries, or undefined for any other item.
const collabItemOf = (params: AppServerNotification["params"]): CodexItem | undefined => {
    const parsed = CollabParamsSchema.safeParse(params);
    if (!parsed.success) {
        return undefined;
    }
    const item = parsed.data.item;
    return {
        id: item.id,
        type: "collab_agent_tool_call",
        tool: item.tool,
        status: collabStatus(item.status),
        ...opt("prompt", item.prompt ?? undefined),
        ...opt("model", item.model ?? undefined),
        receivers: item.receiverThreadIds,
        states: Object.fromEntries(Object.entries(item.agentsStates).map(([thread, state]) => [thread, { status: state.status, ...opt("message", state.message ?? undefined) }])),
    };
};

// Any item this client reads off a notification: a multi-agent call, or one of the kinds normalizeItem knows.
const threadItem = (params: JsonObject): CodexItem | undefined => collabItemOf(params) ?? normalizeItem(params["item"]);

const itemEvent = (method: "item/started" | "item/completed", value: unknown, turnIds: ReadonlySet<string>): CodexEvent | undefined => {
    const params = object(value, `${method} params`);
    if (!turnIds.has(string(params, "turnId", `${method} params`))) {
        return undefined;
    }
    const item = threadItem(params);
    return item === undefined ? undefined : { type: method === "item/started" ? "item.started" : "item.completed", item };
};

const todoEvent = (value: unknown, turnId: string, turnIds: ReadonlySet<string>): CodexEvent | undefined => {
    const params = object(value, "turn/plan/updated params");
    if (!turnIds.has(string(params, "turnId", "turn/plan/updated params"))) {
        return undefined;
    }
    const plan = params["plan"];
    if (!Array.isArray(plan)) {
        throw new Error("Codex app-server sent invalid turn/plan/updated params.plan");
    }
    const items = plan.map((entry, index) => {
        const step = object(entry, `turn/plan/updated params.plan[${index}]`);
        return { text: string(step, "step", `turn/plan/updated params.plan[${index}]`), completed: step["status"] === "completed" };
    });
    return { type: "item.updated", item: { id: `plan-${turnId}`, type: "todo_list", items } };
};

// Codex's slash commands: skills/list, per cwd. Disabled entries are dropped; duplicate names keep the first. The
// one-line blurb wins over description, a whole SKILL.md paragraph meant for a model.
const skillsFrom = (result: unknown): readonly CodexSkill[] => {
    const data = object(result, "skills/list result")["data"];
    if (!Array.isArray(data)) {
        throw new Error("Codex app-server sent invalid skills/list result.data");
    }
    const found = new Map<string, CodexSkill>();
    for (const [index, listed] of data.entries()) {
        const entry = object(listed, `skills/list result.data[${index}]`);
        const skills = entry["skills"];
        if (!Array.isArray(skills)) {
            throw new Error(`Codex app-server sent invalid skills/list result.data[${index}].skills`);
        }
        for (const [position, published] of skills.entries()) {
            const what = `skills/list result.data[${index}].skills[${position}]`;
            const skill = object(published, what);
            if (skill["enabled"] !== true) {
                continue;
            }
            const name = string(skill, "name", what);
            if (found.has(name)) {
                continue;
            }
            const short =
                skill["interface"] === undefined || skill["interface"] === null
                    ? undefined
                    : optionalString(object(skill["interface"], `${what}.interface`), "shortDescription", `${what}.interface`);
            found.set(name, {
                name,
                description: short ?? optionalString(skill, "shortDescription", what) ?? string(skill, "description", what),
                path: string(skill, "path", what),
            });
        }
    }
    return [...found.values()];
};

// Resolves a /command prompt against the thread's published skills, so app-server loads the skill instead of the model
// guessing. Undefined for a slash-prefixed path or a plan turn, whose preamble pushes the name out of lead position.
const skillInput = (prompt: string, skills: readonly CodexSkill[]): { readonly skill: CodexSkill; readonly text: string } | undefined => {
    const named = /^\/([^\s/]+)[ \t]*/.exec(prompt);
    if (named === null) {
        return undefined;
    }
    const skill = skills.find((candidate) => candidate.name === named[1]);
    return skill === undefined ? undefined : { skill, text: prompt.slice(named[0].length) };
};

// Whether a request is this turn's to answer: raised in one of its own turns, or in a thread one of its subagents runs
// in, which on this turn's own connection is every thread but the turn's own. A subagent's command answers to the same
// rules its parent's does.
const ownRequest =
    (turnIds: ReadonlySet<string>, own: string) =>
    (params: JsonObject): boolean => {
        const scope = RequestScopeSchema.safeParse(params);
        const { turnId, threadId } = scope.success ? scope.data : {};
        return (turnId !== undefined && turnIds.has(turnId)) || (threadId !== undefined && threadId !== own);
    };

// Questions on an item/tool/requestUserInput request; undefined for another turn's, answered empty.
// Command on an item/commandExecution/requestApproval, or undefined for a request not this turn's or one with no
// command text. Tolerant of anything else in the payload, since a shape surprise here must not throw the turn.
const textField = (params: JsonObject, key: string): string | undefined => {
    const value = params[key];
    return typeof value === "string" && value.trim() !== "" ? value : undefined;
};

const commandApprovalFrom = (
    raw: unknown,
    ours: (params: JsonObject) => boolean,
): { readonly command: string; readonly reason?: string; readonly cwd?: string } | undefined => {
    const params = maybeObject(raw);
    if (params === undefined || !ours(params)) {
        return undefined;
    }
    const command = textField(params, "command");
    if (command === undefined) {
        return undefined;
    }
    return { command, ...opt("reason", textField(params, "reason")), ...opt("cwd", textField(params, "cwd")) };
};

// Answers one command approval request: a card when there's a command to judge, else the standing yes. The reply rides
// the frame, so the turn stays parked until a person picks.
async function* commandApprovalFrames(
    notification: Extract<AppServerMessage, { kind: "request" }>,
    ours: (params: JsonObject) => boolean,
): AsyncGenerator<CodexEvent> {
    const approval = commandApprovalFrom(notification.params, ours);
    if (approval === undefined) {
        notification.respond({ decision: "accept" });
        return;
    }
    yield {
        type: "command_approval.requested",
        command: approval.command,
        ...opt("reason", approval.reason),
        ...opt("cwd", approval.cwd),
        respond: (allow) => notification.respond({ decision: allow ? "accept" : "decline" }),
    };
}

// Codex asks for an MCP tool call's approval as a form elicitation carrying this kind; `persist` advertises which
// remembered answers the client may return, and `session` is the only one that doesn't amend the owner's config.
const MCP_TOOL_CALL_APPROVAL = "mcp_tool_call";
const PERSIST_SESSION = "session";
// All three keys ride every reply: the schema's `content` and `_meta` are nullable, not optional.
const DECLINED = { action: "decline", content: null, _meta: null } as const;

// Answers one elicitation. An MCP tool call's approval is granted — the container is the isolation boundary and the
// command gate already judges the turn, so refusing here only disables every browser tool that writes. Anything else
// is a server asking the owner something Intentic has no surface for, which the protocol wants declined, not errored;
// a shape surprise takes the same path, since answering an unread question yes is worse than declining it.
const elicitationAnswer = (raw: unknown): JsonValue => {
    const meta = maybeObject(maybeObject(raw)?.["_meta"]);
    if (meta?.["codex_approval_kind"] !== MCP_TOOL_CALL_APPROVAL) {
        return DECLINED;
    }
    // Remembering it for the thread spares a round trip per call; `always` is withheld, since it would write the
    // owner's config from inside a turn.
    const persist = meta["persist"];
    const session = persist === PERSIST_SESSION || (Array.isArray(persist) && persist.includes(PERSIST_SESSION));
    return { action: "accept", content: null, _meta: session ? { persist: PERSIST_SESSION } : null };
};

const questionsFrom = (raw: unknown, turnIds: ReadonlySet<string>): readonly CodexQuestion[] | undefined => {
    const params = object(raw, "item/tool/requestUserInput params");
    if (!turnIds.has(string(params, "turnId", "item/tool/requestUserInput params"))) {
        return undefined;
    }
    const questions = params["questions"];
    if (!Array.isArray(questions)) {
        throw new Error("Codex app-server sent invalid item/tool/requestUserInput params.questions");
    }
    return questions.map((asked, index) => {
        const what = `item/tool/requestUserInput params.questions[${index}]`;
        const question = object(asked, what);
        const rawOptions = question["options"];
        if (rawOptions !== undefined && rawOptions !== null && !Array.isArray(rawOptions)) {
            throw new Error(`Codex app-server sent invalid ${what}.options`);
        }
        return {
            id: string(question, "id", what),
            header: string(question, "header", what),
            question: string(question, "question", what),
            options: (rawOptions ?? []).map((offered: unknown, position: number) => {
                const option = object(offered, `${what}.options[${position}]`);
                return {
                    label: string(option, "label", `${what}.options[${position}]`),
                    description: string(option, "description", `${what}.options[${position}]`),
                };
            }),
            secret: question["isSecret"] === true,
        };
    });
};

// The thread a notification names, when it names one.
const threadOf = (notification: AppServerMessage): string | undefined => {
    const named = ThreadParamsSchema.safeParse(notification.params);
    return named.success ? named.data.threadId : undefined;
};

// How a subagent's own turn ended, as its record says it.
const subagentEnding = (standing: string): "completed" | "failed" | "killed" => {
    if (standing === "completed") {
        return "completed";
    }
    return standing === "interrupted" ? "killed" : "failed";
};

// A subagent's items, as the spawn call that started it sees them.
const subagentItems = (notification: AppServerNotification, spawn: string): CodexEvent[] => {
    const item = threadItem(object(notification.params, `${notification.method} params`));
    return item === undefined ? [] : [{ type: notification.method === "item/started" ? "item.started" : "item.completed", item, parent: spawn }];
};

// What a subagent has spent, and how its turn ended.
const subagentSpend = (notification: AppServerNotification, spawn: string): CodexEvent[] => {
    const usage = UsageParamsSchema.safeParse(notification.params);
    if (!usage.success) {
        return [];
    }
    const total = usage.data.tokenUsage.total;
    return [
        {
            type: "subagent.usage",
            parent: spawn,
            input: Math.max(0, total.inputTokens - total.cachedInputTokens - total.cacheWriteInputTokens),
            output: total.outputTokens,
            cacheRead: total.cachedInputTokens,
            cacheCreation: total.cacheWriteInputTokens,
        },
    ];
};
const subagentEnded = (notification: AppServerNotification, spawn: string): CodexEvent[] => {
    const ended = EndingParamsSchema.safeParse(notification.params);
    return ended.success
        ? [{ type: "subagent.ended", parent: spawn, status: subagentEnding(ended.data.turn.status), ...opt("error", ended.data.turn.error?.message) }]
        : [];
};

// A subagent's notification as events of the spawn call that started it: its items, its spend, its turn's ending. Its
// turn's start, plans and warnings say nothing the card of that call needs.
const subagentEvents = (notification: AppServerNotification, spawn: string): CodexEvent[] => {
    if (notification.method === "item/started" || notification.method === "item/completed") {
        return subagentItems(notification, spawn);
    }
    if (notification.method === "thread/tokenUsage/updated") {
        return subagentSpend(notification, spawn);
    }
    return notification.method === "turn/completed" ? subagentEnded(notification, spawn) : [];
};

// Events on their way out, naming the threads any spawn among them started; what a thread sent before it was named is
// read as its subagent's from there.
function* namingSpawns(events: readonly CodexEvent[], threads: CodexSubagentThreads<AppServerNotification>): Generator<CodexEvent> {
    for (const event of events) {
        yield event;
        if (event.type !== "item.completed" || event.item.type !== "collab_agent_tool_call" || event.item.tool !== "spawnAgent") {
            continue;
        }
        for (const replay of threads.named(event.item.id, event.item.receivers)) {
            yield* namingSpawns(subagentEvents(replay.notification, replay.spawn), threads);
        }
    }
}

// A notification from one of this turn's subagents' threads, as events of the spawn call that started it (none while
// the thread is still unnamed); undefined for one of the turn's own, handled as it always was.
const fromSubagent = (threads: CodexSubagentThreads<AppServerNotification>, own: string, notification: AppServerMessage): readonly CodexEvent[] | undefined => {
    const thread = notification.kind === "notification" ? threadOf(notification) : undefined;
    if (thread === undefined || thread === own) {
        return undefined;
    }
    const routed = threads.route(thread, notification);
    return routed.kind === "subagent" ? [...namingSpawns(subagentEvents(notification, routed.spawn), threads)] : [];
};

// How the turn itself ended, or undefined for the completion of a turn it is no longer (a steer opened a newer one).
const ownEnding = (notification: AppServerNotification, turnId: string, usage: CodexUsage | undefined): CodexEvent | undefined => {
    const params = object(notification.params, "turn/completed params");
    const completed = object(params["turn"], "turn/completed params.turn");
    if (string(completed, "id", "turn/completed params.turn") !== turnId) {
        return undefined;
    }
    const completedStatus = string(completed, "status", "turn/completed params.turn");
    if (completedStatus === "failed") {
        const error = object(completed["error"], "turn/completed params.turn.error");
        return { type: "turn.failed", error: { message: string(error, "message", "turn/completed params.turn.error") } };
    }
    if (completedStatus === "completed") {
        return { type: "turn.completed", ...opt("usage", usage) };
    }
    if (completedStatus === "interrupted") {
        return { type: "turn.failed", error: { message: "Codex turn was interrupted" } };
    }
    throw new Error("Codex app-server sent invalid turn/completed params.turn.status");
};

// Turn a turn/steer landed on, normally the one already running. Read rather than assumed, since a steer that opened a
// new turn would otherwise send later frames to a dead id.
const steeredTurnId = (value: unknown): string => string(object(value, "turn/steer result"), "turnId", "turn/steer result");

// Server requests render independently of the turn's steering and completion state.
async function* requestEvents(
    notification: Extract<AppServerMessage, { kind: "request" }>,
    ours: ReturnType<typeof ownRequest>,
    turnIds: Set<string>,
): AsyncGenerator<CodexEvent> {
    // accept/decline are the schema's words; decline lets the turn carry on, unlike cancel, which
    // interrupts it.
    if (notification.method === COMMAND_APPROVAL_REQUEST) {
        yield* commandApprovalFrames(notification, ours);
        return;
    }
    if (notification.method === FILE_CHANGE_APPROVAL_REQUEST) {
        notification.respond({ decision: "accept" });
        return;
    }
    if (notification.method === ELICITATION_REQUEST) {
        notification.respond(elicitationAnswer(notification.params));
        return;
    }
    if (notification.method === PERMISSIONS_APPROVAL_REQUEST) {
        // Grants the profile Codex asked for; the container is the isolation boundary, so narrowing
        // here protects nothing.
        const params = object(notification.params, `${PERMISSIONS_APPROVAL_REQUEST} params`);
        notification.respond({ permissions: (params["permissions"] ?? {}) as JsonValue });
        return;
    }
    // The question request. A question for another turn is answered empty rather than shown.
    const questions = questionsFrom(notification.params, turnIds);
    if (questions === undefined) {
        notification.respond({ answers: {} });
        return;
    }
    yield {
        type: "user_input.requested",
        questions,
        respond: (answers) =>
            notification.respond({
                answers: Object.fromEntries(Object.entries(answers).map(([id, picks]) => [id, { answers: [...picks] }])),
            }),
    };
    return;
}

interface CodexNotificationScope {
    readonly threads: CodexSubagentThreads<AppServerNotification>;
    readonly turnIds: Set<string>;
    readonly threadId: string;
    readonly startedTurnId: string;
}

function* notificationEvents(notification: AppServerNotification, scope: CodexNotificationScope): Generator<CodexEvent> {
    const { threads, turnIds, threadId, startedTurnId } = scope;
    if (notification.method === "item/started" || notification.method === "item/completed") {
        const event = itemEvent(notification.method, notification.params, turnIds);
        if (event !== undefined) {
            yield* namingSpawns([event], threads);
        }
        return;
    }
    if (notification.method === "turn/plan/updated") {
        // Keyed by the started turn, not the current one, so a steer that opens a new turn keeps the same
        // checklist.
        const event = todoEvent(notification.params, startedTurnId, turnIds);
        if (event !== undefined) {
            yield event;
        }
        return;
    }
    if (notification.method === "account/rateLimits/updated") {
        // Account-wide, not per turn, so there's no turn id to check here.
        yield { type: "rate_limits", snapshot: object(notification.params, "account/rateLimits/updated params")["rateLimits"] };
        return;
    }
    if (notification.method === "error") {
        const params = object(notification.params, "error params");
        if (turnIds.has(string(params, "turnId", "error params"))) {
            yield { type: "error", message: string(object(params["error"], "error params.error"), "message", "error params.error") };
        }
        return;
    }
    if (notification.method === "warning") {
        const params = object(notification.params, "warning params");
        if (params["threadId"] === undefined || params["threadId"] === null || params["threadId"] === threadId) {
            yield { type: "warning", message: string(params, "message", "warning params") };
        }
        return;
    }
}

interface StartedCodexTurn {
    readonly threadId: string;
    readonly startedTurnId: string;
    readonly startParams: {
        readonly threadId: string;
        readonly cwd: string;
        readonly approvalPolicy: CodexThreadOptions["approvalPolicy"];
        readonly sandboxPolicy: JsonValue;
        readonly model?: string;
        readonly effort?: CodexReasoningEffort;
    };
}

async function* startCodexTurn(connection: CodexAppServerConnection, turn: CodexTurn): AsyncGenerator<CodexEvent, StartedCodexTurn> {
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

    // Read before the turn starts, since the prompt may name a skill; an empty popover is the cost of failure
    // here.
    const skills = await connection
        .request("skills/list", { cwds: [turn.options.workingDirectory], forceReload: false })
        .then(skillsFrom)
        .catch(() => []);
    if (skills.length > 0) {
        yield { type: "commands", skills };
    }

    const command = skillInput(turn.prompt, skills);
    const input = [
        ...(command === undefined ? [] : [{ type: "skill", name: command.skill.name, path: command.skill.path }]),
        { type: "text", text: command?.text ?? turn.prompt, text_elements: [] },
        ...(turn.images ?? []).map((path) => ({ type: "localImage", path })),
    ];
    const startParams = {
        threadId,
        cwd: turn.options.workingDirectory,
        approvalPolicy: turn.options.approvalPolicy,
        sandboxPolicy: sandboxPolicy(turn.options.sandboxMode),
        ...(turn.options.model !== undefined ? { model: turn.options.model } : {}),
        ...(turn.options.modelReasoningEffort !== undefined ? { effort: turn.options.modelReasoningEffort } : {}),
    };
    const startedTurnId = turnIdFrom(await connection.request("turn/start", { ...startParams, input }));
    return { threadId, startedTurnId, startParams };
}

export const createCodexAppServerRunner = (connect: CodexAppServerConnector = stdioConnector()): CodexRunner =>
    async function* runAppServerTurn(turn) {
        const connection = await connect(turn);
        let stopSteering: (() => void) | undefined;
        try {
            const { threadId, startedTurnId, startParams } = yield* startCodexTurn(connection, turn);
            // Observe every turn id so a steer cannot let an old turn win.
            const turnIds = new Set([startedTurnId]);
            let turnId = startedTurnId;
            const ours = ownRequest(turnIds, threadId);
            // The threads this turn's own subagents run in, each read as the spawn call that started it.
            const threads = codexSubagentThreads<AppServerNotification>(threadId);

            // A single consumer orders steering against notifications. Input can arrive before acknowledgement;
            // refusals stay pending until completion, then become a follow-up on this same thread.
            const messages = new AsyncQueue<AppServerMessage | { readonly kind: "steering" }>();
            const waiting: string[] = [];
            let active = false;
            let refused = false;
            let finished = false;
            const inputPump = (async () => {
                for await (const text of turn.steering ?? []) {
                    if (finished) {
                        return;
                    }
                    waiting.push(text);
                    messages.push({ kind: "steering" });
                }
            })();
            void inputPump.catch((error) => messages.fail(error));
            void (async () => {
                try {
                    for await (const message of connection.messages) {
                        messages.push(message);
                    }
                    messages.end();
                } catch (error) {
                    messages.fail(error);
                }
            })();
            const steerWaiting = async (): Promise<void> => {
                if (!active || refused) {
                    return;
                }
                while (waiting.length > 0) {
                    if (turn.signal.aborted) {
                        return;
                    }
                    const text = waiting[0]!;
                    try {
                        const steered = steeredTurnId(
                            await connection.request("turn/steer", {
                                threadId,
                                expectedTurnId: turnId,
                                input: [{ type: "text", text, text_elements: [] }],
                            }),
                        );
                        waiting.shift();
                        turnIds.add(steered);
                        turnId = steered;
                    } catch {
                        refused = true;
                        return;
                    }
                }
            };

            stopSteering = () => {
                finished = true;
                turn.closeSteering?.();
            };
            let usage: CodexUsage | undefined;
            for await (const notification of messages) {
                if (notification.kind === "steering") {
                    await steerWaiting();
                    continue;
                }
                const delegated = fromSubagent(threads, threadId, notification);
                if (delegated !== undefined) {
                    yield* delegated;
                    continue;
                }
                if (notification.kind === "request") {
                    yield* requestEvents(notification, ours, turnIds);
                    continue;
                }
                if (notification.method === "turn/started") {
                    const params = object(notification.params, "turn/started params");
                    const startedTurn = object(params["turn"], "turn/started params.turn");
                    if (string(startedTurn, "id", "turn/started params.turn") === turnId) {
                        active = true;
                        refused = false;
                        await steerWaiting();
                        yield { type: "turn.started" };
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
                if (notification.method === "turn/completed") {
                    const ending = ownEnding(notification, turnId, usage);
                    if (ending === undefined) {
                        continue;
                    }
                    active = false;
                    turn.closeSteering?.();
                    if (turn.closeSteering !== undefined) {
                        await inputPump;
                    }
                    yield ending;
                    if (waiting.length > 0 && !turn.signal.aborted) {
                        const followupInput = waiting.splice(0).map((text) => ({ type: "text", text, text_elements: [] }));
                        turnId = turnIdFrom(await connection.request("turn/start", { ...startParams, input: followupInput }));
                        turnIds.add(turnId);
                        usage = undefined;
                        continue;
                    }
                    return;
                }
                yield* notificationEvents(notification, { threads, turnIds, threadId, startedTurnId });
            }
            throw new Error("Codex app-server ended before turn/completed");
        } finally {
            stopSteering?.();
            connection.close();
        }
    };
