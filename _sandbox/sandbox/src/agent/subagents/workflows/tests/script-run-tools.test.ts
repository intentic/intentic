import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { unstubbed } from "@intentic/testing";
import { z } from "zod";
import type { ConversationActors } from "../../../../conversations/actor/conversation-actors.js";
import type { ChildSupervisor } from "../../children.js";
import { subagentWaitServer } from "../../waiting/subagent-wait.js";
import { workflowTools } from "../script-run-tools.js";

// The workflow tools as a delegating turn's `subagents` server lists and answers them: one schema the SDK cannot convert
// would empty the whole listing.

// The server's live instance and the transport its connect takes, read off the SDK's own types.
type DoorTransport = Parameters<McpSdkServerConfigWithInstance["instance"]["connect"]>[0];
type JsonRpc = Parameters<DoorTransport["send"]>[0];

// The fields of a JSON-RPC answer these tests read, parsed off what the server sent.
const ReplySchema = z.object({
    id: z.number().optional(),
    result: z
        .object({
            tools: z.array(z.object({ name: z.string() })).optional(),
            content: z.array(z.object({ text: z.string() })).optional(),
        })
        .optional(),
});
type Reply = z.infer<typeof ReplySchema>;

// Drives the server over its public connect(), so tools/list converts every schema through the SDK the way the CLI's
// listing does.
const connect = async (server: McpSdkServerConfigWithInstance): Promise<(method: string, params: Record<string, unknown>) => Promise<Reply>> => {
    const pending = new Map<number, (reply: Reply) => void>();
    const transport: DoorTransport = {
        start: async () => undefined,
        close: async () => undefined,
        send: async (message: JsonRpc) => {
            const reply = ReplySchema.safeParse(message);
            if (reply.success && reply.data.id !== undefined) {
                pending.get(reply.data.id)?.(reply.data);
            }
        },
    };
    await server.instance.connect(transport);
    let next = 0;
    return (method, params) =>
        new Promise((resolve) => {
            next += 1;
            pending.set(next, resolve);
            transport.onmessage?.({ jsonrpc: "2.0", id: next, method, params });
        });
};

test("a delegating turn with workflow runs lists the workflow tools, and passes a run's defaults and args on", async () => {
    const asked: unknown[] = [];
    const call = await connect(
        subagentWaitServer({
            conversationId: "parent",
            conversations: unstubbed<ConversationActors>("conversations", {}),
            signal: new AbortController().signal,
            children: unstubbed<ChildSupervisor>("children", {}),
            extraTools: workflowTools(
                {
                    start: async (request) => {
                        asked.push(request);
                        return { ok: true, run: "wfr-1", note: "Running." };
                    },
                    status: async () => ({ ok: false, message: "No run." }),
                    stop: () => ({ ok: false, message: "No run." }),
                },
                new AbortController().signal,
            ),
        }),
    );
    const listed = await call("tools/list", {});
    expect(listed.result?.tools?.map((tool) => tool.name)).toEqual([
        "providers",
        "spawn",
        "send",
        "cancel",
        "answer",
        "merge",
        "wait",
        "workflow",
        "workflow_status",
        "workflow_stop",
        "keep",
    ]);
    const started = await call("tools/call", {
        name: "workflow",
        arguments: { script: 'export const meta = { name: "x" };', provider: "claude", model: "claude-sonnet-4-6", args: { files: ["a.ts"] } },
    });
    // SAFETY: the tool answers one JSON text block; `unknown` only narrows JSON.parse's `any` for toEqual to compare.
    expect(started.result?.content?.map((block) => JSON.parse(block.text) as unknown)).toEqual([{ ok: true, run: "wfr-1", note: "Running." }]);
    expect(asked).toEqual([{ script: 'export const meta = { name: "x" };', args: { files: ["a.ts"] }, defaults: { provider: "claude", model: "claude-sonnet-4-6" } }]);
    const half = await call("tools/call", { name: "workflow", arguments: { script: "x", provider: "claude" } });
    // SAFETY: as above.
    expect(half.result?.content?.map((block) => JSON.parse(block.text) as unknown)).toEqual([
        { ok: false, message: "Name the run's `provider` and `model` together, or neither." },
    ]);
});
