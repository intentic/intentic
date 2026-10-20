import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { unstubbed } from "@intentic/testing";
import type { ConversationActors } from "../../../../conversations/actor/conversation-actors.js";
import { memoryFleet } from "../../../../conversations/registry/agents-registry.testing.js";
import type { ChildSupervisor } from "../../children.js";
import { subagentWaitServer } from "../subagent-wait.js";

// The fields of a JSON-RPC answer these tests read.
interface Reply {
    readonly id?: number;
    readonly result?: { readonly tools?: readonly { readonly name: string }[]; readonly content?: readonly { readonly text: string }[] };
    readonly error?: { readonly message: string };
}

interface Transport {
    start: () => Promise<void>;
    close: () => Promise<void>;
    send: (message: Reply) => Promise<void>;
    onmessage?: (message: unknown) => void;
}

// Drives the server over its public connect(), so tools/list converts every schema through the SDK the way the CLI's
// listing does.
const connect = async (server: McpSdkServerConfigWithInstance): Promise<(method: string, params: object) => Promise<Reply>> => {
    const pending = new Map<number, (reply: Reply) => void>();
    const transport: Transport = {
        start: async () => undefined,
        close: async () => undefined,
        send: async (message) => {
            if (message.id !== undefined) {
                pending.get(message.id)?.(message);
            }
        },
    };
    await (server.instance as unknown as { connect: (transport: Transport) => Promise<void> }).connect(transport);
    let next = 0;
    return (method, params) =>
        new Promise((resolve) => {
            next += 1;
            pending.set(next, resolve);
            transport.onmessage?.({ jsonrpc: "2.0", id: next, method, params });
        });
};

const serverWith = (children: ChildSupervisor | undefined): McpSdkServerConfigWithInstance =>
    subagentWaitServer({
        conversationId: "parent",
        conversations: unstubbed<ConversationActors>("conversations", {}),
        signal: new AbortController().signal,
        ...(children === undefined ? {} : { children }),
    });

const toolNames = async (server: McpSdkServerConfigWithInstance): Promise<readonly string[] | string> => {
    const reply = await (await connect(server))("tools/list", {});
    return reply.result?.tools?.map((tool) => tool.name) ?? `tools/list failed: ${reply.error?.message ?? "no result"}`;
};

// One schema the SDK cannot convert fails the whole listing, and the CLI then mounts the server with no tools at all.
test("a delegating turn's server lists wait and keep beside every supervision tool", async () => {
    await expect(toolNames(serverWith(unstubbed<ChildSupervisor>("children", {})))).resolves.toEqual([
        "providers",
        "spawn",
        "send",
        "cancel",
        "answer",
        "merge",
        "wait",
        "keep",
    ]);
});

test("a turn that may not delegate still lists wait and keep", async () => {
    await expect(toolNames(serverWith(undefined))).resolves.toEqual(["wait", "keep"]);
});

test("keep answers not ok, with the reason, for an id that names none of the conversation's commands", async () => {
    const call = await connect(
        subagentWaitServer({ conversationId: "parent", conversations: memoryFleet().conversations, signal: new AbortController().signal }),
    );
    const reply = await call("tools/call", { name: "keep", arguments: { target: "b-nobody", reason: "dev server" } });
    // SAFETY: the tool answers one JSON text block; `unknown` only narrows JSON.parse's `any` for toEqual to compare.
    expect(reply.result?.content?.map((block) => JSON.parse(block.text) as unknown)).toEqual([
        { ok: false, message: "No background command of this conversation has that ID." },
    ]);
});

test("answer hands the child its picks keyed by each question's text", async () => {
    const answered: { childId: string; answers: Record<string, string[]> }[] = [];
    const children = unstubbed<ChildSupervisor>("children", {
        answer: async (childId, answers) => {
            answered.push({ childId, answers });
            return { ok: true, note: "Answered." };
        },
    });
    const call = await connect(serverWith(children));
    const reply = await call("tools/call", {
        name: "answer",
        arguments: {
            child: "kid-1",
            answers: [
                { question: "Which store?", picks: ["Postgres"] },
                { question: "Which regions?", picks: ["eu", "us"] },
            ],
        },
    });
    expect(answered).toEqual([{ childId: "kid-1", answers: { "Which store?": ["Postgres"], "Which regions?": ["eu", "us"] } }]);
    expect(reply.result?.content?.map((block) => JSON.parse(block.text) as unknown)).toEqual([{ ok: true, note: "Answered." }]);
});

// A provider with no model went out as a plain send, whose "Sent" the parent read as the move having happened.
test("send refuses half a move and sends nothing, and passes a whole one on", async () => {
    const sent: { childId: string; rehome: unknown }[] = [];
    const children = unstubbed<ChildSupervisor>("children", {
        send: async (childId, _message, rehome) => {
            sent.push({ childId, rehome });
            return { ok: true, note: "Sent." };
        },
    });
    const call = await connect(serverWith(children));
    const half = await call("tools/call", { name: "send", arguments: { child: "kid-1", message: "Carry on.", provider: "claude" } });
    // SAFETY: the tool answers one JSON text block; `unknown` only narrows JSON.parse's `any` for toMatchObject to compare.
    expect(half.result?.content?.map((block) => JSON.parse(block.text) as unknown)).toMatchObject([{ ok: false, message: expect.stringContaining("Nothing was sent") }]);
    expect(sent).toEqual([]);
    await call("tools/call", { name: "send", arguments: { child: "kid-1", message: "Carry on.", provider: "claude", model: "claude-sonnet-4-6" } });
    expect(sent).toEqual([{ childId: "kid-1", rehome: { provider: "claude", model: "claude-sonnet-4-6" } }]);
});

// A child its parent gave a result schema: the schema itself is its tool's input, so the listing shows the model the shape
// and a value off it is refused before the door ever sees it.
test("a child given a result schema lists a result tool taking that shape, and a matching value reaches its door", async () => {
    const taken: unknown[] = [];
    const schema = { type: "object", properties: { verdict: { type: "string", enum: ["real", "false-positive"] } }, required: ["verdict"], additionalProperties: false };
    const call = await connect(
        subagentWaitServer({
            conversationId: "sub-kid",
            conversations: unstubbed<ConversationActors>("conversations", {}),
            signal: new AbortController().signal,
            result: {
                schema,
                take: (value) => {
                    taken.push(value);
                    return { value };
                },
            },
        }),
    );
    const listed = await call("tools/list", {});
    expect(listed.result?.tools?.map((tool) => tool.name)).toEqual(["wait", "result", "keep"]);
    // SAFETY: tools/list answers each tool with its JSON Schema input; read here only to compare.
    expect((listed.result?.tools?.find((tool) => tool.name === "result") as { inputSchema?: unknown } | undefined)?.inputSchema).toMatchObject({
        properties: { value: { type: "object", properties: { verdict: { type: "string", enum: ["real", "false-positive"] } }, required: ["verdict"], additionalProperties: false } },
        required: ["value"],
    });

    const off = await call("tools/call", { name: "result", arguments: { value: { verdict: "maybe" } } });
    expect(off.result?.content?.[0]?.text).toContain("Input validation error");
    expect(taken).toEqual([]);

    const on = await call("tools/call", { name: "result", arguments: { value: { verdict: "real" } } });
    // SAFETY: the tool answers one JSON text block; `unknown` only narrows JSON.parse's `any` for toEqual to compare.
    expect(on.result?.content?.map((block) => JSON.parse(block.text) as unknown)).toEqual([
        { ok: true, note: "Recorded: your parent receives this value with your report. End your turn with a short report." },
    ]);
    expect(taken).toEqual([{ verdict: "real" }]);
});

test("spawn passes a result schema on, and refuses one that is no JSON object before spawning anything", async () => {
    const spawned: unknown[] = [];
    const children = unstubbed<ChildSupervisor>("children", {
        spawn: async (spec) => {
            spawned.push(spec.result);
            return { ok: true, id: "sub-x" };
        },
    });
    const call = await connect(serverWith(children));
    await call("tools/call", {
        name: "spawn",
        arguments: { prompt: "Verify it", provider: "claude", model: "claude-sonnet-4-6", schema: { type: "object", properties: { ok: { type: "boolean" } } } },
    });
    expect(spawned).toEqual([{ schema: { type: "object", properties: { ok: { type: "boolean" } } } }]);
    const bad = await call("tools/call", {
        name: "spawn",
        arguments: { prompt: "Verify it", provider: "claude", model: "claude-sonnet-4-6", schema: { type: "object", default: Number.NaN } },
    });
    // NaN is no JSON value: the schema is refused whole rather than half-read.
    // SAFETY: the tool answers one JSON text block; `unknown` only narrows JSON.parse's `any` for toEqual to compare.
    expect(bad.result?.content?.map((block) => JSON.parse(block.text) as unknown)).toEqual([
        { ok: false, message: "The result schema must be a JSON object: a JSON Schema describing the value you want back." },
    ]);
    expect(spawned).toHaveLength(1);
});
