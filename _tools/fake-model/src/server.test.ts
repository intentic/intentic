import { expect, test } from "vitest";
import { baseInstructions, developerMessages, hasTool, type ResponsesRequest, systemInstructions, toolNames, toolOutputs, userMessages } from "./responses.js";
import { startFakeModel } from "./server.js";

/* This package is a seam, so it is held to the same bar as the code it stands in for: what a suite asserts
 * ABOUT a CLI is only worth what this server's own behaviour is worth.
 *
 * Nothing here runs a provider CLI. That is the job of the conformance tiers that consume this
 * (`_sandbox/sandbox/src/codex/codex-wire.e2e.test.ts`); these tests cover the script machine and the readers,
 * which are the parts a scenario builds on and the parts that would fail silently. */

const post = async (baseUrl: string, path: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; text: string }> => {
    const response = await fetch(`${baseUrl}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
    });
    return { status: response.status, text: await response.text() };
};

// A minimal Responses body, the shape the readers below are asked about.
const body = (input: readonly unknown[]): unknown => ({ model: "fake", input });

// The output items an SSE response carried, decoded. Reading the wire text directly would be reading JSON
// inside JSON, where a wrong number of backslashes passes for a right one.
const sentItems = (text: string): readonly Record<string, unknown>[] =>
    text
        .split("\n")
        .filter((line) => line.startsWith("data: "))
        .map((line) => JSON.parse(line.slice("data: ".length)) as Record<string, unknown>)
        .filter((frame) => frame["type"] === "response.output_item.done")
        .map((frame) => frame["item"] as Record<string, unknown>);

test("a scripted turn answers in Responses SSE and records the body it was sent", async () => {
    const model = await startFakeModel({ script: [{ text: "hello from the script" }] });
    try {
        const { status, text } = await post(model.baseUrl, "/v1/responses", body([{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }]));
        expect(status).toBe(200);
        expect(text).toContain("event: response.created");
        expect(text).toContain("event: response.completed");
        expect(text).toContain("hello from the script");
        expect(model.requests).toHaveLength(1);
        expect(userMessages(model.requests[0]!)).toEqual(["hi"]);
    } finally {
        await model.close();
    }
});

/* The last step repeating is what keeps a script a value rather than a state machine: a CLI that asks once more
 * than the test predicted (a retry, a follow-up after a tool result) must get the same ending, not a 500 the
 * suite then has to account for. */
test("steps are consumed in order and the last one repeats", async () => {
    const model = await startFakeModel({ script: [{ shell: "/bin/echo one" }, { text: "finished" }] });
    try {
        const first = await post(model.baseUrl, "/v1/responses", { model: "fake", tools: [{ type: "function", name: "exec_command" }], input: [] });
        expect(first.text).toContain("function_call");
        expect(first.text).toContain("/bin/echo one");
        for (const _ of [0, 1, 2]) {
            const later = await post(model.baseUrl, "/v1/responses", body([]));
            expect(later.text).toContain("finished");
        }
        expect(model.requests).toHaveLength(4);
    } finally {
        await model.close();
    }
});

/* THE TWO SHELL SURFACES, CHOSEN BY WHAT THE REQUEST OFFERED. The same CLI takes one form or the other
 * depending on the model family, and a step aimed at the wrong one comes back as a tool-router error rather
 * than a command, which a suite would read as the runtime refusing to execute. Deciding from the request is
 * what lets a scenario say "run this command" once and have it hold across the catalog. */
test("a shell step takes the flat exec_command form when the request offers it", async () => {
    const model = await startFakeModel({ script: [{ shell: "/bin/ls -la" }] });
    try {
        const request = { model: "fake", tools: [{ type: "function", name: "exec_command" }], input: [] };
        const { text } = await post(model.baseUrl, "/v1/responses", request);
        const item = sentItems(text).find((frame) => frame["type"] === "function_call");
        expect(item).toBeDefined();
        expect(item!["name"]).toBe("exec_command");
        expect(JSON.parse(String(item!["arguments"]))).toEqual({ cmd: "/bin/ls -la" });
    } finally {
        await model.close();
    }
});

test("a shell step falls back to the exec script form when only the custom tool is offered", async () => {
    const model = await startFakeModel({ script: [{ shell: "/bin/ls -la" }] });
    try {
        const request = {
            model: "fake",
            input: [{ type: "additional_tools", tools: [{ type: "namespace", name: "functions", tools: [{ type: "custom", name: "exec" }] }] }],
        };
        const { text } = await post(model.baseUrl, "/v1/responses", request);
        const item = sentItems(text).find((frame) => frame["type"] === "custom_tool_call");
        expect(item).toBeDefined();
        expect(item!["name"]).toBe("exec");
        expect(String(item!["input"])).toContain(`tools.exec_command({cmd: "/bin/ls -la"})`);
    } finally {
        await model.close();
    }
});

/* An execScript command carrying a quote must survive into the isolate: embedded raw it would close the
 * script's string literal, and the CLI would report a parse failure for a script the test believed it had
 * written. Asserted on the DECODED item rather than the wire text, which is JSON twice over (the item, then the
 * SSE data line) and would let a wrong number of backslashes read as right. */
test("an execScript step escapes the command into valid JavaScript", async () => {
    const model = await startFakeModel({ script: [{ execScript: `/bin/echo "quoted"` }] });
    try {
        const { text } = await post(model.baseUrl, "/v1/responses", body([]));
        const item = sentItems(text).find((frame) => frame["type"] === "custom_tool_call");
        expect(item).toBeDefined();
        expect(item!["name"]).toBe("exec");
        expect(String(item!["input"])).toBe(String.raw`const r = await tools.exec_command({cmd: "/bin/echo \"quoted\""}); text(r);`);
        // The escaped source is still valid JavaScript: what the isolate is handed must parse.
        expect(() => new Function(`return async () => { ${String(item!["input"])} }`)).not.toThrow();
    } finally {
        await model.close();
    }
});

/* ANSWERING BY CONTENT is what lets one shared model serve a whole suite: a retry gets the same answer rather
 * than the next scenario's, and tests stop depending on the order the runner happens to pick. */
test("respond answers by what was asked, repeatably, and falls through to the script when it declines", async () => {
    const model = await startFakeModel({
        script: [{ text: "fallback" }],
        respond: (request) => (userMessages(request).join(" ").includes("banana") ? { text: "matched banana" } : undefined),
    });
    try {
        const ask = (text: string) => post(model.baseUrl, "/v1/responses", body([{ type: "message", role: "user", content: [{ type: "input_text", text }] }]));
        expect((await ask("about banana please")).text).toContain("matched banana");
        // Again, and it is still the same answer: a retry must not consume somebody else's step.
        expect((await ask("about banana please")).text).toContain("matched banana");
        expect((await ask("something else")).text).toContain("fallback");
    } finally {
        await model.close();
    }
});

test("a failWith step answers at the HTTP layer, which is how a rate limit or an outage is scripted", async () => {
    const model = await startFakeModel({ script: [{ failWith: { status: 429, body: { error: { message: "slow down" } } } }, { text: "recovered" }] });
    try {
        const refused = await post(model.baseUrl, "/v1/responses", body([]));
        expect(refused.status).toBe(429);
        expect(refused.text).toContain("slow down");
        const next = await post(model.baseUrl, "/v1/responses", body([]));
        expect(next.status).toBe(200);
        expect(next.text).toContain("recovered");
    } finally {
        await model.close();
    }
});

test("requireKey refuses a wrong bearer and records every bearer seen", async () => {
    const model = await startFakeModel({ requireKey: "right-token" });
    try {
        expect((await post(model.baseUrl, "/v1/responses", body([]), { authorization: "Bearer wrong-token" })).status).toBe(401);
        expect((await post(model.baseUrl, "/v1/responses", body([]), { authorization: "Bearer right-token" })).status).toBe(200);
        expect(model.bearers).toEqual(["wrong-token", "right-token"]);
    } finally {
        await model.close();
    }
});

/* The two dialects are named apart because a base URL pointed at the wrong one is a real misconfiguration, and
 * a server that answered everything would go green on exactly that mistake. */
test("the Anthropic surface answers /v1/messages, and an unknown path is refused by name", async () => {
    const model = await startFakeModel({ script: [{ text: "claude-shaped" }] });
    try {
        const messages = await post(model.baseUrl, "/v1/messages", { model: "fake-claude", messages: [] });
        expect(messages.status).toBe(200);
        expect(messages.text).toContain("event: message_start");
        expect(messages.text).toContain("claude-shaped");
        const missing = await post(model.baseUrl, "/v1/embeddings", {});
        expect(missing.status).toBe(404);
        expect(missing.text).toContain("/v1/embeddings");
    } finally {
        await model.close();
    }
});

/* THE CHAT COMPLETIONS DIALECT, which OpenCode reaches every custom provider through. Its terminator is a
 * literal `[DONE]` rather than a typed event: a stream that merely stopped would leave the client waiting until
 * a timeout, which reads as the model hanging rather than as the shim being wrong. */
test("the chat-completions surface streams nameless chunks and terminates with [DONE]", async () => {
    const model = await startFakeModel({ script: [{ text: "opencode-shaped" }] });
    try {
        const { status, text } = await post(model.baseUrl, "/v1/chat/completions", {
            model: "fake-model",
            messages: [{ role: "user", content: "hello there" }],
        });
        expect(status).toBe(200);
        expect(text).toContain("chat.completion.chunk");
        expect(text).toContain("opencode-shaped");
        expect(text).toContain('"finish_reason":"stop"');
        expect(text.trimEnd().endsWith("data: [DONE]")).toBe(true);
        expect(text, "chat completions frames carry no event name").not.toContain("event: ");
        // Recorded through the same readers as a Responses body, so a scenario asserts one way about either.
        expect(userMessages(model.requests[0]!)).toEqual(["hello there"]);
    } finally {
        await model.close();
    }
});

test("a chat-completions shell step arrives as a tool_calls delta, and a failWith still refuses", async () => {
    const model = await startFakeModel({ script: [{ shell: "/bin/echo hi" }, { failWith: { status: 500, body: { error: "boom" } } }] });
    try {
        const call = await post(model.baseUrl, "/v1/chat/completions", { model: "m", messages: [] });
        expect(call.text).toContain('"finish_reason":"tool_calls"');
        expect(call.text).toContain("/bin/echo hi");
        const refused = await post(model.baseUrl, "/v1/chat/completions", { model: "m", messages: [] });
        expect(refused.status).toBe(500);
    } finally {
        await model.close();
    }
});

// Probed before the first turn by several clients, which read a 404 as "this provider is unreachable" rather
// than as "no listing" — a failure mode with nothing to do with the scenario under test.
test("a model listing is answered rather than 404'd", async () => {
    const model = await startFakeModel();
    try {
        const response = await fetch(`${model.baseUrl}/v1/models`);
        expect(response.status).toBe(200);
        expect(await response.text()).toContain("fake-model");
    } finally {
        await model.close();
    }
});

/* THE READERS, over both shapes the same binary sends. What these assert is that a reader looks in the right
 * PLACE, which is the part that differs between the two entry points and the part a suite gets silently wrong:
 * app-server puts the base prompt in a top-level `instructions` field and its tools in top-level `tools`, while
 * `codex exec` puts the prompt in a developer message and its tools in an `additional_tools` input item. */
test("the readers pull instructions, messages, tools and tool outputs out of an app-server body", () => {
    const request: ResponsesRequest = {
        model: "gpt-5-codex",
        instructions: "You are a coding agent running in the Codex CLI",
        tools: [
            { type: "function", name: "exec_command" },
            { type: "function", name: "request_user_input" },
            { type: "namespace", name: "image_gen", tools: [{ type: "function", name: "create" }] },
            { type: "web_search" },
        ],
        input: [
            { type: "message", role: "developer", content: [{ type: "input_text", text: "APPENDED <skills_instructions>" }] },
            { type: "message", role: "user", content: [{ type: "input_text", text: "do the thing" }] },
            { type: "function_call_output", call_id: "call_1", output: [{ type: "input_text", text: "SHIM-RAN-THIS" }] },
        ],
    };
    expect(baseInstructions(request)).toBe("You are a coding agent running in the Codex CLI");
    expect(developerMessages(request)).toEqual(["APPENDED <skills_instructions>"]);
    expect(userMessages(request)).toEqual(["do the thing"]);
    expect(toolNames(request)).toEqual(["exec_command", "request_user_input", "image_gen.create", "web_search"]);
    expect(toolOutputs(request).get("call_1")).toContain("SHIM-RAN-THIS");
});

/* THE SURFACE-AGNOSTIC PAIR, which is what a capability assertion should use. The same CLI moves the base
 * prompt and renames every tool depending on the model family, so a suite pinned to either spelling passes on
 * half the catalog and fails on the other half for a reason unrelated to the capability under test. */
test("systemInstructions and hasTool answer the same question on both model surfaces", () => {
    const flat: ResponsesRequest = {
        model: "gpt-5-codex",
        instructions: "You are a coding agent running in the Codex CLI",
        tools: [{ type: "function", name: "request_user_input" }],
        input: [],
    };
    const namespaced: ResponsesRequest = {
        model: "gpt-5.6-sol",
        input: [
            { type: "additional_tools", tools: [{ type: "namespace", name: "functions", tools: [{ type: "function", name: "request_user_input" }] }] },
            { type: "message", role: "developer", content: [{ type: "input_text", text: "You are Codex, an agent based on GPT-5" }] },
        ],
    };

    expect(systemInstructions(flat)).toContain("You are a coding agent");
    expect(systemInstructions(namespaced)).toContain("You are Codex");
    expect(hasTool(flat, "request_user_input")).toBe(true);
    expect(hasTool(namespaced, "request_user_input")).toBe(true);
    expect(hasTool(flat, "no_such_tool")).toBe(false);
    expect(hasTool(namespaced, "no_such_tool")).toBe(false);
    // A partial name must not match: `user_input` is not `request_user_input`, and a suffix test that ignored
    // the dot boundary would say it was.
    expect(hasTool(namespaced, "user_input")).toBe(false);
});

test("the tool reader also sees the namespaced additional_tools item that `codex exec` sends", () => {
    const request: ResponsesRequest = {
        model: "gpt-5-codex",
        input: [
            {
                type: "additional_tools",
                role: "developer",
                tools: [{ type: "namespace", name: "functions", tools: [{ type: "custom", name: "exec" }, { type: "function", name: "request_user_input" }] }],
            },
            { type: "message", role: "developer", content: [{ type: "input_text", text: "You are Codex, an agent based on GPT-5" }] },
        ],
    };
    expect(toolNames(request)).toEqual(["functions.exec", "functions.request_user_input"]);
    // No top-level field on this surface: the prompt is a developer message instead.
    expect(baseInstructions(request)).toBe("");
    expect(developerMessages(request)[0]).toContain("You are Codex");
});
