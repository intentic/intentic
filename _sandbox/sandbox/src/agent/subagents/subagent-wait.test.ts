import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { unstubbed } from "@intentic/testing";
import type { ConversationActors } from "../../agents/actor/conversation-actors.js";
import type { ChildSupervisor } from "./children.js";
import { subagentWaitServer } from "./subagent-wait.js";

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
test("a delegating turn's server lists wait beside every supervision tool", async () => {
    await expect(toolNames(serverWith(unstubbed<ChildSupervisor>("children", {})))).resolves.toEqual(["providers", "spawn", "send", "answer", "wait"]);
});

test("a turn that may not delegate still lists wait", async () => {
    await expect(toolNames(serverWith(undefined))).resolves.toEqual(["wait"]);
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
