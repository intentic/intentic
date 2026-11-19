import type { StageArtifact, StageArtifactResult } from "@intentic/sandbox-contract/schemas/device-artifacts";
import type { DeviceFacts, DeviceFeature } from "@intentic/sandbox-contract/schemas/hosts";
import { unstubbed } from "@intentic/testing";
import { z } from "zod";
import { workspacePaths } from "../../workspace/workspace.js";
import type { StackServices } from "./device-stacks.js";
import type { HostClient } from "../host-peer.js";

// ONE CONNECTED COMPUTER FOR THE STACK SUITES (device-stacks.ts): whether it is connected, what its agent advertises, and
// what its tools and its staging answer, every call recorded. The hub is the seam faked; the tool call goes through the
// real `callTool`, so a suite reads answers the way the daemon does. Not part of the build.

export const STACK_DEVICE = "rog";

// What one tool call answers: its text, and whether the machine refused it (`isError`). A thrown error is the link failing.
export interface ToolAnswer {
    readonly text: string;
    readonly refused?: boolean;
}

export interface ToolCall {
    // The connection the call went over, as the hub keys it.
    readonly device: string;
    readonly tool: string;
    readonly args: Readonly<Record<string, string | number>>;
    readonly signal: AbortSignal | undefined;
}

// The facts an agent reports about itself; only `features` is read here, the rest is what any Linux agent says.
const FACTS: DeviceFacts = { os: "Ubuntu 24.04", arch: "x64", shell: "bash", home: "/home/me", roots: ["/home/me"] };

// The MCP request callTool sends, read back as the machine would read it.
const ToolRequestSchema = z.object({
    params: z.object({ name: z.string(), arguments: z.record(z.string(), z.union([z.string(), z.number()])) }),
});

// A staging that has nothing yet and files each upload under its name and hash, as the machine's runs folder does.
const freshStaging = async (op: StageArtifact): Promise<StageArtifactResult> =>
    op.op === "commit" ? { path: `/home/me/.intentic/runs/${op.name}/${op.sha256.slice(0, 12)}` } : {};

// A tool that answers with nothing, for a suite that only asserts what was asked.
const silent = async (): Promise<ToolAnswer> => ({ text: "" });

export interface StackDeviceOptions {
    readonly online?: boolean;
    readonly features?: readonly DeviceFeature[];
    readonly tool?: (call: ToolCall) => Promise<ToolAnswer>;
    readonly stage?: (op: StageArtifact) => Promise<StageArtifactResult>;
    // The workspace a deploy resolves its repository in.
    readonly root?: string;
}

export const stackDevice = (over: StackDeviceOptions = {}) => {
    const tools: ToolCall[] = [];
    const staging: StageArtifact[] = [];
    const online = over.online ?? true;
    const client = unstubbed<HostClient>("client", {
        stageArtifact: async (op: StageArtifact) => {
            staging.push(op);
            return await (over.stage ?? freshStaging)(op);
        },
    });
    const services: StackServices = {
        workspace: workspacePaths(over.root ?? "/nowhere"),
        hostHub: unstubbed<StackServices["hostHub"]>("hostHub", {
            client: (id) => (online && id === STACK_DEVICE ? client : undefined),
            online: (id) => online && id === STACK_DEVICE,
            offline: (id) => `"${id}" is not connected right now: the device is asleep, offline, or its agent isn't running.`,
            state: () => ({ online, facts: { ...FACTS, features: [...(over.features ?? ["stacks", "programs"])] } }),
            mcp: async (device, payload, options) => {
                const { name, arguments: args } = ToolRequestSchema.parse(payload).params;
                const call: ToolCall = { device, tool: name, args, signal: options?.signal };
                tools.push(call);
                const answer = await (over.tool ?? silent)(call);
                return { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: answer.text }], isError: answer.refused === true } };
            },
        }),
    };
    return { services, tools, staging };
};
