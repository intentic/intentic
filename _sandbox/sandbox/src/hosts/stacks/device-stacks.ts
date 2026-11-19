import { createReadStream } from "node:fs";
import { errorMessage } from "@intentic/base/errors";
import { sizeLabel } from "@intentic/base/format";
import { parseJsonWith } from "@intentic/base/json";
import { ARTIFACT_CHUNK_BYTES } from "@intentic/sandbox-contract/schemas/device-artifacts";
import {
    type DeployStackToolArgs,
    type DeviceStackDeployInput,
    type DeviceStackDeployResult,
    type DeviceStackLogsInput,
    type DeviceStackOpInput,
    type DeviceStacks,
    DeviceStacksSchema,
    type StackLogs,
    type StackOpResult,
} from "@intentic/sandbox-contract/schemas/device-stacks";
import { DEVICE_FEATURE_PROGRAMS, DEVICE_FEATURE_STACKS, type DeviceFeature, deviceSupports } from "@intentic/sandbox-contract/schemas/hosts";
import { ORPCError } from "@orpc/server";
import { z } from "zod";
import type { Services } from "../../composition.js";
import { callFailure } from "../../peers/call-failure.js";
import { DEVICE_ANSWER_MARGIN_MS, DEVICE_CALL_CEILING_MS, QUICK_CALL_MS } from "../../peers/device-call-deadline.js";
import { callTool } from "../device-reports.js";
import { committedStack, type PackedTree, repoFolder, withPackedTree } from "./device-stack-bundle.js";
import { alreadyStaged, type StagedBundle, stageBundle, type StagingDeadlines } from "../runs/device-staging.js";
import type { HostClient } from "../host-peer.js";

// DOCKER COMPOSE STACKS ON ONE OF THE OWNER'S COMPUTERS (schemas/device-stacks.ts), for the Deployments board: relayed
// to the machine's own tools (`list_stacks`, `stack_action`, `stack_logs`, `deploy_stack`), which run compose and check
// the computer's switches themselves. The daemon adds no judgement of its own past the routes' floor: it refuses only
// what the machine could not answer (offline, an agent too old to have the tools), and passes a refusal on in the
// machine's words, which name the switch to flip. A deploy also packs the repository here and carries it over the
// link first (device-stack-bundle.ts, ../runs/device-staging.ts).

export type StackServices = Pick<Services, "hostHub" | "workspace">;

// Bounds on waiting for each tool, each past the machine's own bound on the work (tools/stacks/stacks.ts in _devices/machine),
// so a compose that overran arrives as the machine's answer saying so, and only a computer gone quiet is cut here. A
// read stops there at 25 s; the minute leaves room for a loaded machine to answer at all (device-commands.ts measured
// a 20 s budget cut mid-read at load 19.5).
const READ_DEADLINE_MS = 60_000;
// `pull` fetches images and `up` may build one: the machine stops either at ten minutes.
const OP_DEADLINE_MS = 10 * 60_000 + DEVICE_ANSWER_MARGIN_MS;
// A deploy copies the tree into the stack's folder and then builds and starts it, which the machine stops at ten
// minutes: the hub's ceiling on any one device call covers both.
const DEPLOY_DEADLINE_MS = DEVICE_CALL_CEILING_MS;
// Carrying the tree: a 2 MiB chunk that takes two minutes means the computer went quiet, and the commit unpacks the tar
// under the machine's own ten-minute bound (tools/programs/artifacts.ts in _devices/machine).
const STAGING_DEADLINES: StagingDeadlines = { chunkMs: QUICK_CALL_MS, commitMs: 10 * 60_000 + DEVICE_ANSWER_MARGIN_MS };

// What each part of this needs of the computer's agent, and how a refusal says what it could not do.
interface Need {
    readonly feature: DeviceFeature;
    readonly to: string;
}
const STACKS: Need = { feature: DEVICE_FEATURE_STACKS, to: "read or drive Docker compose stacks" };
const PROGRAMS: Need = { feature: DEVICE_FEATURE_PROGRAMS, to: "receive what this sandbox sends" };

// The computer's client, once it is connected and its agent has every tool the call needs. An older agent would answer
// an unknown tool with an error the reader cannot act on, so it is refused here, saying how to update it.
const clientFor = (services: StackServices, id: string, needs: readonly Need[]): HostClient => {
    const client = services.hostHub.client(id);
    if (client === undefined || !services.hostHub.online(id)) {
        throw new ORPCError("CONFLICT", { message: services.hostHub.offline(id) });
    }
    const facts = services.hostHub.state(id).facts;
    const missing = needs.find((need) => !deviceSupports(facts, need.feature));
    if (missing !== undefined) {
        throw new ORPCError("CONFLICT", {
            message: `The agent on "${id}" is too old to ${missing.to}: update it there (\`intentic-machine upgrade\`, or Update on its Devices card), then try again.`,
        });
    }
    return client;
};

// What the stack tools take: a stack's name, an op, a count, a path; never anything nested.
type ToolArgs = Readonly<Record<string, string | number>>;

// One of the machine's tools, its answer as text. A refusal (a switch that is off) is FORBIDDEN in the machine's own
// words; a call that got no answer is BAD_GATEWAY, said as what it means for the call (it may have run).
const relay = async (services: StackServices, id: string, tool: string, args: ToolArgs, deadlineMs: number): Promise<string> => {
    const answer = await callTool(services, id, tool, args, AbortSignal.timeout(deadlineMs)).catch((error: Error) => {
        throw new ORPCError("BAD_GATEWAY", { message: callFailure("device", id, tool, error, deadlineMs).text });
    });
    if (answer.refused) {
        throw new ORPCError("FORBIDDEN", { message: answer.text.trim() === "" ? `"${id}" refused ${tool} without saying why.` : answer.text });
    }
    return answer.text;
};

// How much of an answer that is not what the tool promised is quoted back: enough to recognise it, never a whole log.
const QUOTED_CHARS = 300;

// A tool's JSON answer, read against what it promises; anything else is the computer's fault, named by what came back.
const parsedAnswer = <T>(id: string, tool: string, text: string, schema: z.ZodType<T>): T => {
    const value = parseJsonWith(text, schema);
    if (value === undefined) {
        const quoted = text.trim() === "" ? "nothing" : JSON.stringify(text.length > QUOTED_CHARS ? `${text.slice(0, QUOTED_CHARS)}…` : text);
        throw new ORPCError("BAD_GATEWAY", { message: `"${id}" answered ${tool} with something other than what it promises: ${quoted}` });
    }
    return value;
};

// Every compose project on the computer, as `list_stacks` reads them.
export const deviceStacks = async (services: StackServices, id: string): Promise<DeviceStacks> => {
    clientFor(services, id, [STACKS]);
    return parsedAnswer(id, "list_stacks", await relay(services, id, "list_stacks", {}, READ_DEADLINE_MS), DeviceStacksSchema);
};

export const deviceStackOp = async (services: StackServices, input: DeviceStackOpInput): Promise<StackOpResult> => {
    clientFor(services, input.id, [STACKS]);
    return { output: await relay(services, input.id, "stack_action", { name: input.name, op: input.op }, OP_DEADLINE_MS) };
};

export const deviceStackLogs = async (services: StackServices, input: DeviceStackLogsInput): Promise<StackLogs> => {
    clientFor(services, input.id, [STACKS]);
    const args = input.tail === undefined ? { name: input.name } : { name: input.name, tail: input.tail };
    return { text: await relay(services, input.id, "stack_logs", args, READ_DEADLINE_MS) };
};

// What `deploy_stack` answers: the folder the stack now runs from, and what `docker compose up` printed.
const DeployedSchema = z.object({ path: z.string(), output: z.string() });

// A staging failure: the machine's own refusal (its "Run programs this sandbox sends" switch) in its words, anything
// else the link, with how far the bytes got.
const stagingFailure = (id: string, failure: Error, sent: number, size: number): ORPCError<string, unknown> =>
    failure instanceof ORPCError && failure.code === "FORBIDDEN"
        ? new ORPCError("FORBIDDEN", { message: failure.message })
        : new ORPCError("BAD_GATEWAY", { message: `Carrying the repository to "${id}" stopped after ${sizeLabel(sent)} of ${sizeLabel(size)}: ${errorMessage(failure)}` });

// The packed tree in the machine's staging, unpacked; answered from what is already there when this exact tree was
// carried before (a redeploy of the same commit sends nothing). The staging name is the stack's, cut to what the
// machine's folder names allow: it is only where the copy is taken from.
const staged = async (client: HostClient, id: string, name: string, packed: PackedTree): Promise<string> => {
    const bundle: StagedBundle = { name: `stack-${name}`.slice(0, 64), kind: "tar", fileName: `${name}.tar`, size: packed.size, sha256: packed.sha256 };
    const had = await alreadyStaged(client, bundle, QUICK_CALL_MS).catch((error: Error) => {
        throw stagingFailure(id, error, 0, packed.size);
    });
    if (had !== undefined) {
        return had;
    }
    const outcome = await stageBundle(client, bundle, createReadStream(packed.file, { highWaterMark: ARTIFACT_CHUNK_BYTES }), STAGING_DEADLINES);
    if ("failure" in outcome) {
        throw stagingFailure(id, outcome.failure, outcome.sent, packed.size);
    }
    return outcome.path;
};

// A workspace repository's last commit, run on the computer as a compose stack: packed here, carried into the
// machine's staging, then copied into the stack's folder there and brought up with `--build` by `deploy_stack`. The
// staging and the tool call both go to `input.id`'s own connection (the hub's `client` and `mcp` read the same entry,
// and nothing reroutes either), because the machine takes as `source` only a build staged in this sandbox's runs folder
// on that very agent: the WSL side of a PC cannot answer for its Windows side here.
export const deployDeviceStack = async (services: StackServices, input: DeviceStackDeployInput): Promise<DeviceStackDeployResult> => {
    const client = clientFor(services, input.id, [STACKS, PROGRAMS]);
    const dir = await repoFolder(services.workspace.root, input.repo);
    const { commit, composeFile } = await committedStack(dir, input.repo, input.composeFile);
    const source = await withPackedTree(dir, input.repo, commit, (packed) => staged(client, input.id, input.name, packed));
    const args: DeployStackToolArgs = { source, name: input.name, composeFile, commit };
    const text = await relay(services, input.id, "deploy_stack", args, DEPLOY_DEADLINE_MS);
    const deployed = parsedAnswer(input.id, "deploy_stack", text, DeployedSchema);
    return { stack: input.name, path: deployed.path, commit, output: deployed.output };
};
