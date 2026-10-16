import type { Capability } from "@intentic/sandbox-contract/schemas/capabilities";
import { unstubbed } from "@intentic/testing";
import { z } from "zod";
import type { AgentTool } from "../../agent/tools/agent-tools.js";
import type { InProcessServer, MountSpec } from "../../agent/tools/turn-mounts.js";
import { armSupervisor, type ChildSupervisor } from "../../agent/subagents/children.js";
import type { DelegateAsk } from "../linked-children.js";
import { memoryFleet } from "../../conversations/registry/agents-registry.testing.js";
import { linkMountsOf } from "../link-mounts.js";

// A linked sandbox reaches a turn the way a connected computer does: a tool server named after its card, on the turn's
// lease, for the cards the turn was granted. Handing it work is spawning's sibling, so a turn no supervisor was armed
// for (an outside wake, a persona that does not delegate) is refused.

const ops: Capability = { id: "ops", kind: "link", config: { url: "https://sandbox-ops.sbx.test", token: "ilk_x", name: "Ops box" } };
const laptop: Capability = {
    id: "laptop",
    kind: "device",
    config: { platform: "linux", shell: "on", write: "on", screen: "off", control: "off", sandboxes: "off", destructive: "off", programs: "off" },
};

const AnswerSchema = z.object({
    result: z.object({ content: z.array(z.object({ text: z.string() })).optional(), tools: z.array(z.object({ name: z.string() })).optional() }).optional(),
});

// The servers a turn's lease was handed, by name, without a door: each is called as the door would call it.
const mounted = (granted: readonly Capability[], conversationId: string | undefined, conversations = memoryFleet().conversations) => {
    const opened: MountSpec[] = [];
    const lease = {
        open: (spec: MountSpec): AgentTool => {
            opened.push(spec);
            return unstubbed<AgentTool>("tool", { name: spec.name });
        },
    };
    const about = async (_conversationId: string, link: string) => ({ to: link, sandbox: "Ops box", online: true, approve: false, turnsPerHour: 20 });
    linkMountsOf({ conversations, about }, granted, lease, conversationId);
    return opened;
};

const serverOf = (spec: MountSpec | undefined): InProcessServer => {
    if (spec?.target.kind !== "daemon") {
        throw new Error("a link is mounted as a daemon server");
    }
    return spec.target.server;
};

let next = 0;
const call = async (server: InProcessServer, method: string, params: Record<string, unknown> = {}) => {
    next += 1;
    return AnswerSchema.parse(await server.handle({ jsonrpc: "2.0", id: next, method, params }));
};
const started = async (server: InProcessServer) => {
    await call(server, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } });
    return server;
};
const textOf = (answer: z.infer<typeof AnswerSchema>): string => (answer.result?.content ?? []).map((part) => part.text).join("");

test("each granted link card is a server of its own, named after it, beside nothing for any other kind", async () => {
    const opened = mounted([ops, laptop], "conv-a");
    expect(opened.map((spec) => spec.name)).toEqual(["ops"]);
    const server = await started(serverOf(opened[0]));
    expect((await call(server, "tools/list")).result?.tools?.map((tool) => tool.name).toSorted()).toEqual(["about", "delegate"]);
    expect(JSON.parse(textOf(await call(server, "tools/call", { name: "about", arguments: {} })))).toMatchObject({ ok: true, to: "ops", online: true });
    server.close();
});

test("a turn no supervisor was armed for may not hand work on; an armed one hands it to that card", async () => {
    const { conversations } = memoryFleet();
    const refused = await started(serverOf(mounted([ops], "conv-a", conversations)[0]));
    const no = JSON.parse(textOf(await call(refused, "tools/call", { name: "delegate", arguments: { task: "Count incidents." } })));
    expect(no).toMatchObject({ ok: false, message: expect.stringContaining("may not hand work on") });

    const asked: DelegateAsk[] = [];
    const supervisor = unstubbed<ChildSupervisor>("supervisor", {
        delegate: async (ask) => {
            asked.push(ask);
            return { ok: true, id: "linked-brave-otter-1", note: "Handed over." };
        },
    });
    armSupervisor(conversations, "conv-a", supervisor);
    const server = await started(serverOf(mounted([ops], "conv-a", conversations)[0]));
    const yes = JSON.parse(textOf(await call(server, "tools/call", { name: "delegate", arguments: { task: "Count incidents.", description: "incidents" } })));
    expect(yes).toEqual({ ok: true, child: "linked-brave-otter-1", note: "Handed over." });
    expect(asked).toEqual([{ to: "ops", task: "Count incidents.", description: "incidents" }]);
    refused.close();
    server.close();
});
