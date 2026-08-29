import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { whenAborted } from "../abort.js";
import { nsenterArgv } from "../agents/isolation.js";
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
    /* `never` is the standing posture, and what every turn ran under before the command rulebook reached this
     * runtime: Codex asks nothing and the container is the isolation boundary.
     *
     * `untrusted` is asked for ONLY when the owner's rules could refuse something (codex-agent.ts
     * threadOptions), because it is the value that makes Codex raise
     * `item/commandExecution/requestApproval` for commands rather than only on sandbox escalation, which
     * `dangerFullAccess` never needs. It costs one in-process round-trip per command Codex asks about. */
    readonly approvalPolicy: "never" | "untrusted";
    readonly model?: string;
    readonly modelReasoningEffort?: CodexReasoningEffort;
}

export type JsonValue = string | number | boolean | null | readonly JsonValue[] | { readonly [key: string]: JsonValue };

// Where the app-server process is born: the pid holding the turn's mount namespace open, and the workspace root
// as that namespace sees it. Present only on an isolated turn whose container could build one, everything the
// app-server then forks (its shell, its browser servers) inherits the namespace, so /work IS the worktree for
// all of it. Absent ⇒ spawned plainly here, cwd'd into whatever `options.workingDirectory` says.
export interface CodexNamespace {
    readonly pid: number;
    readonly cwd: string;
}

export interface CodexTurn {
    readonly prompt: string;
    readonly images?: readonly string[];
    readonly sessionId?: string;
    readonly env: Record<string, string>;
    readonly modelProvider?: string;
    readonly config?: Readonly<Record<string, JsonValue>>;
    readonly options: CodexThreadOptions;
    /* Mid-turn steering: each message pulled from here is delivered to the RUNNING turn as `turn/steer`. A plain
     * per-turn iterable rather than the daemon's shared queue, codex's plan emulation runs two app-servers with
     * a person's approval in between, and the phase that has closed must not be holding the queue open (see
     * codex-agent.ts, which owns the one consumer and hands each phase a channel of its own). */
    readonly steering?: AsyncIterable<string>;
    readonly namespace?: CodexNamespace;
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

// One skill the thread's cwd publishes (`skills/list`). Codex's answer to a slash command. `path` travels
// because invoking one takes both halves: app-server's skill input is keyed by name AND directory.
export interface CodexSkill {
    readonly name: string;
    readonly description: string;
    readonly path: string;
}

// One question from the experimental `item/tool/requestUserInput` server request. `options` is empty when Codex
// asks something open-ended; `secret` marks an answer it wants withheld from the transcript.
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
    | { readonly type: "item.started" | "item.updated" | "item.completed"; readonly item: CodexItem }
    | { readonly type: "commands"; readonly skills: readonly CodexSkill[] }
    /* THE ONE SERVER-INITIATED REQUEST THIS CLIENT ANSWERS, handed over as an event so the answer travels the
     * stream rather than a side channel: the consumer raises its card, waits for a person, and calls `respond`.
     * The runner's loop is parked on that yield meanwhile, which is exactly right, app-server is blocked on the
     * answer too, so nothing can arrive out of order while the card is open.
     *
     * `respond` takes one entry per question id; ids Codex did not ask about are ignored by it. */
    | {
          readonly type: "user_input.requested";
          readonly questions: readonly CodexQuestion[];
          readonly respond: (answers: Readonly<Record<string, readonly string[]>>) => void;
      }
    /* One command Codex is about to run and wants an answer on, from
     * `item/commandExecution/requestApproval`. `command` is the text the classifier reads; `reason` is Codex's
     * own words for why it asked, carried so a card can show them. `respond` takes the verdict, and the turn is
     * blocked on it, which is what lets a hold park here the same way it parks a Bash hook. */
    | {
          readonly type: "command_approval.requested";
          readonly command: string;
          readonly reason?: string;
          readonly respond: (allow: boolean) => void;
      }
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
        // literal with no contextual type widens it straight back, the element type has to come from here.
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

/* WHAT ARRIVES FROM APP-SERVER, and why the two kinds share one queue: they are one ordered stream on the wire,
 * and splitting them would let a question card render after the tool call that comes next.
 *
 * Only the requests this client actually answers reach here. Everything else is refused the instant it arrives
 * (see HANDLED_REQUESTS) rather than queued for the loop: app-server can block on an answer BEFORE `turn/start`
 * returns, and a refusal that waits for the loop to start would deadlock the turn against itself. */
export type AppServerMessage =
    | ({ readonly kind: "notification" } & AppServerNotification)
    | ({ readonly kind: "request"; readonly respond: (result: JsonValue) => void } & AppServerNotification);

export interface CodexAppServerConnection {
    readonly request: (method: string, params: unknown) => Promise<unknown>;
    readonly notify: (method: string, params: unknown) => void;
    readonly messages: AsyncIterable<AppServerMessage>;
    readonly close: () => void;
}

/* The server-initiated requests Intentic answers. Anything else is refused on arrival with a JSON-RPC
 * "method not found", which is why this set and the loop below have to agree: a request Codex sends and nothing
 * answers is a wedged turn.
 *
 * The three approval requests are here because the owner's command rulebook needs a seam before a command runs,
 * and this is the only one Codex publishes (`item/commandExecution/requestApproval`, whose params carry the
 * command text). They arrive only when the turn asked for them: `approvalPolicy` is still `"never"` unless the
 * owner wrote rules, so an unconfigured workspace sees exactly what it always did (codex-agent.ts threadOptions).
 *
 * The other two ride along because turning approvals on turns on ALL of them: a file change or a permission
 * profile Codex asks about is accepted, which is the posture those calls already had under `never`. Only the
 * command class is judged. Shapes read off codex-cli 0.147's own generated schema
 * (`codex app-server generate-json-schema`), not guessed. */
const COMMAND_APPROVAL_REQUEST = "item/commandExecution/requestApproval";
const FILE_CHANGE_APPROVAL_REQUEST = "item/fileChange/requestApproval";
const PERMISSIONS_APPROVAL_REQUEST = "item/permissions/requestApproval";
const HANDLED_REQUESTS = new Set([
    "item/tool/requestUserInput",
    COMMAND_APPROVAL_REQUEST,
    FILE_CHANGE_APPROVAL_REQUEST,
    PERMISSIONS_APPROVAL_REQUEST,
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

type CodexSpawn = (binary: string, args: readonly string[], env: Record<string, string>) => ChildProcessWithoutNullStreams;

const spawnCodex: CodexSpawn = (binary, args, env) => spawn(binary, args, { env, stdio: ["pipe", "pipe", "pipe"] });

const stdioConnector =
    (binaryPath: () => Promise<string | undefined> = codexBinary, spawnProcess: CodexSpawn = spawnCodex): CodexAppServerConnector =>
    async (turn) => {
        const binary = await binaryPath();
        if (binary === undefined) {
            throw new Error(CODEX_BINARY_MISSING);
        }
        /* THE NAMESPACE IS ENTERED BY EXEC, not by supervision: nsenter execs app-server into the turn's anchor,
         * so this stays a direct child, its pipes, its exit code and the kill on abort all reach the real
         * process. Same seam and same reasoning as the Claude Code loop's spawn wrapper (agent.ts).
         *
         * The anchor's cwd wins over the turn's own working directory: it is the workspace root as the namespace
         * sees it, which INSIDE is the conversation's worktree. A failure here fails the turn rather than falling
         * back to the shared checkout, an agent quietly editing the main tree is what the namespace exists to
         * prevent. */
        const argv =
            turn.namespace === undefined
                ? { command: binary, args: ["app-server", "--stdio"] }
                : nsenterArgv(turn.namespace.pid, turn.namespace.cwd, binary, ["app-server", "--stdio"]);
        const child = spawnProcess(argv.command, argv.args, turn.env);
        const messages = new AsyncQueue<AppServerMessage>();
        const pending = new Map<number, { readonly resolve: (value: unknown) => void; readonly reject: (error: unknown) => void }>();
        let requestId = 0;
        let closing = false;
        let stderr = "";

        const fail = (error: unknown): void => {
            messages.fail(error);
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
                messages.end();
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
                        messages.push({ kind: "notification", method, params: message["params"] });
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
        // `await binaryPath()` above is a filesystem lookup, so a turn stopped during it reaches here already
        // aborted; a bare listener would never fire and this app-server would outlive the Stop that killed it.
        const unwatchAbort = whenAborted(turn.signal, abort);

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
            messages,
            close: () => {
                closing = true;
                unwatchAbort();
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

const itemEvent = (method: "item/started" | "item/completed", value: unknown, turnIds: ReadonlySet<string>): CodexEvent | undefined => {
    const params = object(value, `${method} params`);
    if (!turnIds.has(string(params, "turnId", `${method} params`))) {
        return undefined;
    }
    const item = normalizeItem(params["item"]);
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

/* THE SLASH COMMANDS CODEX ACTUALLY HAS: its skills, per working directory, as `skills/list` reports them.
 *
 * Disabled entries are dropped rather than shown greyed, the popover has no third state, and offering a name
 * that refuses to load is worse than not offering it. Deduplicated by name because the answer is per-cwd and
 * scoped (user, repo, system, admin), so one name can arrive several times; first wins, which is the same
 * precedence app-server itself applies when the model asks for it by name.
 *
 * The one-line blurb wins over the body when there is one: `description` is the whole SKILL.md front matter,
 * which is a paragraph written for a model, and the popover has a row. */
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

/* A `/command` prompt, resolved against the skills this thread published. The structured skill input is what
 * makes the popover real: app-server LOADS the skill, instead of the model reading a stray slash word and
 * guessing. Whatever follows the name rides on as the text of the message.
 *
 * Undefined for prose that merely starts with a slash (a path, `/etc/hosts`, this product's own vocabulary),
 * unmatched text is sent verbatim, because Codex parses no slash commands of its own and so cannot swallow it.
 * That is also what a plan turn gets: its prompt opens with the planning preamble, so the name is no longer
 * leading and reaches the model as the words the user typed rather than as a loaded skill. */
const skillInput = (prompt: string, skills: readonly CodexSkill[]): { readonly skill: CodexSkill; readonly text: string } | undefined => {
    const named = /^\/([^\s/]+)[ \t]*/.exec(prompt);
    if (named === null) {
        return undefined;
    }
    const skill = skills.find((candidate) => candidate.name === named[1]);
    return skill === undefined ? undefined : { skill, text: prompt.slice(named[0].length) };
};

// The questions on one `item/tool/requestUserInput` request. Undefined when it belongs to another turn on this
// thread, nothing in this run can answer that, and its caller says so on the wire instead of asking a person.
/* The one command on an `item/commandExecution/requestApproval`, or undefined when this request is not this
 * run's to answer (another turn's) or carries no command text to judge.
 *
 * `command` is optional in the schema, so a request without one is undefined here and the caller accepts it:
 * the alternative is refusing work over a field Codex chose not to send, and the gate is friction for
 * well-behaved commands rather than a boundary (sandbox-contract's command-classes.ts). Deliberately TOLERANT of everything
 * else in the payload: this runs on the turn path and a shape surprise must not throw the stream. */
const commandApprovalFrom = (raw: unknown, turnIds: ReadonlySet<string>): { readonly command: string; readonly reason?: string } | undefined => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        return undefined;
    }
    const params = raw as JsonObject;
    const turnId = params["turnId"];
    if (typeof turnId !== "string" || !turnIds.has(turnId)) {
        return undefined;
    }
    const command = params["command"];
    if (typeof command !== "string" || command.trim() === "") {
        return undefined;
    }
    const reason = params["reason"];
    return { command, ...(typeof reason === "string" && reason.trim() !== "" ? { reason } : {}) };
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

// The turn a `turn/steer` landed on. Normally the turn that was already running. Codex interrupts the model
// and resubmits with the steer folded in, but it answers with an id rather than nothing, so the id is read
// rather than assumed: a steer that DID open a new turn would otherwise send every later frame to a dead id.
const steeredTurnId = (value: unknown): string => string(object(value, "turn/steer result"), "turnId", "turn/steer result");

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

            /* The thread's own slash commands, read before the turn starts because the prompt may name one.
             * Best-effort: a workspace with no skills answers with an empty list, and a build that does not
             * publish them at all must not cost the turn, an empty popover is the cost of a failure here. */
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
            const startedTurnId = turnIdFrom(
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
            /* WHICH TURN THIS RUN IS WATCHING. One id in the ordinary case; a steer answers with the id its
             * message landed on, and both are kept because a superseded turn can still be completing while the
             * one carrying the steer runs. The frames of every id in here belong to this run; only the LATEST
             * one ends it, so a `turn/completed` for a turn a steer replaced cannot cut the stream short. */
            const turnIds = new Set([startedTurnId]);
            let turnId = startedTurnId;

            /* MID-TURN STEERING. Best-effort by construction, the same posture as Pi's steer queue: the message
             * is already in the user's transcript by the time it reaches here, and every way `turn/steer` can
             * refuse is a race the user cannot see and cannot act on, the turn finished between the click and
             * this call (`no_active_turn`), or a compaction owns the model for the moment (`non_steerable_*`).
             * Failing the turn over one would replace a lost sentence with a lost turn. */
            const steering = turn.steering;
            if (steering !== undefined) {
                void (async () => {
                    for await (const text of steering) {
                        const steered = await connection
                            .request("turn/steer", {
                                threadId,
                                expectedTurnId: turnId,
                                input: [{ type: "text", text, text_elements: [] }],
                            })
                            .then(steeredTurnId)
                            .catch(() => undefined);
                        if (steered !== undefined) {
                            turnIds.add(steered);
                            turnId = steered;
                        }
                    }
                })();
            }

            let usage: CodexUsage | undefined;
            for await (const notification of connection.messages) {
                if (notification.kind === "request") {
                    /* THE APPROVALS FIRST. `accept`/`decline` are the schema's own decision words; declining
                     * lets the turn carry on (`cancel` would interrupt it, which is not what a refused command
                     * means, the agent should hear no and choose something else).
                     *
                     * A request naming a turn this run is not watching is accepted rather than shown to anyone:
                     * the same rule the question card follows, for the same reason (a superseded turn can still
                     * be completing while the steered one runs). */
                    if (notification.method === COMMAND_APPROVAL_REQUEST) {
                        const approval = commandApprovalFrom(notification.params, turnIds);
                        if (approval === undefined) {
                            notification.respond({ decision: "accept" });
                            continue;
                        }
                        yield {
                            type: "command_approval.requested",
                            command: approval.command,
                            ...(approval.reason !== undefined ? { reason: approval.reason } : {}),
                            respond: (allow) => notification.respond({ decision: allow ? "accept" : "decline" }),
                        };
                        continue;
                    }
                    if (notification.method === FILE_CHANGE_APPROVAL_REQUEST) {
                        notification.respond({ decision: "accept" });
                        continue;
                    }
                    if (notification.method === PERMISSIONS_APPROVAL_REQUEST) {
                        // The profile Codex asked for, granted as asked: the container is the isolation boundary,
                        // so narrowing it here would refuse work without protecting anything.
                        const params = object(notification.params, `${PERMISSIONS_APPROVAL_REQUEST} params`);
                        notification.respond({ permissions: (params["permissions"] ?? {}) as JsonValue });
                        continue;
                    }
                    // The question request. A question for another turn is answered empty rather than shown.
                    const questions = questionsFrom(notification.params, turnIds);
                    if (questions === undefined) {
                        notification.respond({ answers: {} });
                        continue;
                    }
                    yield {
                        type: "user_input.requested",
                        questions,
                        respond: (answers) =>
                            notification.respond({
                                answers: Object.fromEntries(Object.entries(answers).map(([id, picks]) => [id, { answers: [...picks] }])),
                            }),
                    };
                    continue;
                }
                if (notification.method === "turn/started") {
                    const params = object(notification.params, "turn/started params");
                    const startedTurn = object(params["turn"], "turn/started params.turn");
                    if (turnIds.has(string(startedTurn, "id", "turn/started params.turn"))) {
                        yield { type: "turn.started" };
                    }
                    continue;
                }
                if (notification.method === "item/started" || notification.method === "item/completed") {
                    const event = itemEvent(notification.method, notification.params, turnIds);
                    if (event !== undefined) {
                        yield event;
                    }
                    continue;
                }
                if (notification.method === "turn/plan/updated") {
                    // Keyed by the turn this run STARTED, not the current one: a steer that opens a new turn must
                    // keep updating the same checklist card rather than raising a second one beside it.
                    const event = todoEvent(notification.params, startedTurnId, turnIds);
                    if (event !== undefined) {
                        yield event;
                    }
                    continue;
                }
                if (notification.method === "thread/tokenUsage/updated") {
                    const params = object(notification.params, "thread/tokenUsage/updated params");
                    if (turnIds.has(string(params, "turnId", "thread/tokenUsage/updated params"))) {
                        usage = usageFrom(params);
                    }
                    continue;
                }
                if (notification.method === "error") {
                    const params = object(notification.params, "error params");
                    if (turnIds.has(string(params, "turnId", "error params"))) {
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
