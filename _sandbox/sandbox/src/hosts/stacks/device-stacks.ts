import { createReadStream } from "node:fs";
import { errorMessage } from "@intentic/base/errors";
import { sizeLabel } from "@intentic/base/format";
import { ARTIFACT_CHUNK_BYTES } from "@intentic/sandbox-contract/schemas/device-artifacts";
import {
    type DeployStackToolArgs,
    type DeployStackToolResult,
    DeployStackToolResultSchema,
    type DeviceStackDeployInput,
    type DeviceStackDeployResult,
    type DeviceStackLogsInput,
    type DeviceStackOpInput,
    type DeviceStacks,
    DeviceStacksSchema,
    type StackLogs,
    type StackOpResult,
} from "@intentic/sandbox-contract/schemas/device-stacks";
import { type HostStats, HostStatsSchema } from "@intentic/sandbox-contract/schemas/deploys";
import { DEVICE_FEATURE_HOST_STATS, DEVICE_FEATURE_PROGRAMS, DEVICE_FEATURE_STACKS, DEVICE_FEATURE_STACKS_MANAGED } from "@intentic/sandbox-contract/schemas/hosts";
import { ORPCError } from "@orpc/server";
import { z } from "zod";
import type { Services } from "../../composition.js";
import { DEVICE_ANSWER_MARGIN_MS, DEVICE_CALL_CEILING_MS, QUICK_CALL_MS } from "../../peers/device-call-deadline.js";
import { type DeviceNeed, deviceClientFor, parsedToolAnswer, relayTool } from "../devices/device-tool-relay.js";
import { committedStack, type PackedTree, repoFolder, stackAtCommit, withPackedTree } from "./device-stack-bundle.js";
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
const STACKS: DeviceNeed = { feature: DEVICE_FEATURE_STACKS, to: "read or drive Docker compose stacks" };
const PROGRAMS: DeviceNeed = { feature: DEVICE_FEATURE_PROGRAMS, to: "receive what this sandbox sends" };
// (2026-11-25) A managed deploy's fields (a rendered `.env`, registry logins, hooks, health, pins): an older agent's args
// are strict and would refuse them, so it is refused here first, saying to update it.
const STACKS_MANAGED: DeviceNeed = { feature: DEVICE_FEATURE_STACKS_MANAGED, to: "take a stack this sandbox manages (its .env, registry logins, hooks, health checks and image pins)" };

// Every compose project on the computer, as `list_stacks` reads them.
export const deviceStacks = async (services: StackServices, id: string): Promise<DeviceStacks> => {
    deviceClientFor(services, id, [STACKS]);
    return parsedToolAnswer(id, "list_stacks", await relayTool(services, id, "list_stacks", {}, READ_DEADLINE_MS), DeviceStacksSchema);
};

// (2026-11-25) How full the computer is (`host_stats`): its Docker and stacks disks, memory and load, for the deploys
// monitor (deploys/deploy-monitor.ts).
const HOST_STATS: DeviceNeed = { feature: DEVICE_FEATURE_HOST_STATS, to: "say how full its disks and memory are" };
export const deviceHostStats = async (services: StackServices, id: string): Promise<HostStats> => {
    deviceClientFor(services, id, [HOST_STATS]);
    return parsedToolAnswer(id, "host_stats", await relayTool(services, id, "host_stats", {}, READ_DEADLINE_MS), HostStatsSchema);
};

export const deviceStackOp = async (services: StackServices, input: DeviceStackOpInput): Promise<StackOpResult> => {
    deviceClientFor(services, input.id, [STACKS]);
    return { output: await relayTool(services, input.id, "stack_action", { name: input.name, op: input.op }, OP_DEADLINE_MS) };
};

export const deviceStackLogs = async (services: StackServices, input: DeviceStackLogsInput): Promise<StackLogs> => {
    deviceClientFor(services, input.id, [STACKS]);
    const args = input.tail === undefined ? { name: input.name } : { name: input.name, tail: input.tail };
    return { text: await relayTool(services, input.id, "stack_logs", args, READ_DEADLINE_MS) };
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
    const client = deviceClientFor(services, input.id, [STACKS, PROGRAMS]);
    const dir = await repoFolder(services.workspace.root, input.repo);
    const { commit, composeFile } = await committedStack(dir, input.repo, input.composeFile);
    const source = await withPackedTree(dir, input.repo, commit, (packed) => staged(client, input.id, input.name, packed));
    const args: DeployStackToolArgs = { source, name: input.name, composeFile, commit };
    const text = await relayTool(services, input.id, "deploy_stack", args, DEPLOY_DEADLINE_MS);
    const deployed = parsedToolAnswer(input.id, "deploy_stack", text, DeployedSchema);
    return { stack: input.name, path: deployed.path, commit, output: deployed.output };
};

// (2026-11-25) MANAGED DEPLOYS (deploys/): the computer's client once its agent can take every part of one, refused
// before anything is packed or carried otherwise, in the hub's words (offline) or saying which update it needs.
export const managedStackClient = (services: StackServices, id: string): HostClient => deviceClientFor(services, id, [STACKS, PROGRAMS, STACKS_MANAGED]);

// What the engine hands the machine besides the tree: the managed fields of deploy_stack's args, rendered already.
export type ManagedStackFields = Omit<DeployStackToolArgs, "source" | "name" | "composeFile" | "commit">;

export interface ManagedStackDeploy {
    // The device's connection key, as the hub keys it.
    readonly id: string;
    readonly name: string;
    readonly repo: string;
    // A full sha the repository holds (device-stack-bundle.ts exactCommit).
    readonly commit: string;
    readonly composeFile?: string | undefined;
    readonly fields: ManagedStackFields;
}

// How a managed deploy ended, by where: `refused` never reached the stack (the repository, a switch, the staging),
// `carried` lost the link before the machine was asked to run anything, `machine` is the machine's own answer that the
// deploy failed (compose, a hook, health), and `lost` is a link that dropped while it ran, which may or may not have
// finished there. The engine rolls back only on `machine`: it is the one case the stack is known to be broken.
export type ManagedStackOutcome =
    | { readonly kind: "deployed"; readonly composeFile: string; readonly result: DeployStackToolResult }
    | { readonly kind: "refused" | "carried" | "machine" | "lost"; readonly error: string };

// The commit's tree, carried into the machine's staging (a tree it already holds is not sent again) and run there by
// `deploy_stack` with the managed fields. Over `input.id`'s own connection throughout, as `deployDeviceStack` is.
export const deployManagedStack = async (services: StackServices, input: ManagedStackDeploy): Promise<ManagedStackOutcome> => {
    let source: string;
    let composeFile: string;
    try {
        const client = managedStackClient(services, input.id);
        const dir = await repoFolder(services.workspace.root, input.repo);
        composeFile = (await stackAtCommit(dir, input.repo, input.commit, input.composeFile)).composeFile;
        source = await withPackedTree(dir, input.repo, input.commit, (packed) => staged(client, input.id, input.name, packed));
    } catch (error) {
        // A staging cut by the link is the only failure here that is not a refusal: nothing ran, so nothing to undo.
        const carried = error instanceof ORPCError && error.code === "BAD_GATEWAY";
        return { kind: carried ? "carried" : "refused", error: errorMessage(error) };
    }
    const args: DeployStackToolArgs = { source, name: input.name, composeFile, commit: input.commit, ...input.fields };
    let text: string;
    try {
        text = await relayTool(services, input.id, "deploy_stack", args, DEPLOY_DEADLINE_MS);
    } catch (error) {
        // relayTool says FORBIDDEN for every answer the machine marked an error, which for deploy_stack is the deploy
        // failing there (its switches were read by the staging and the stack list before this), and BAD_GATEWAY for a
        // link that dropped under the call.
        const said = error instanceof ORPCError && error.code === "FORBIDDEN";
        return { kind: said ? "machine" : "lost", error: errorMessage(error) };
    }
    try {
        return { kind: "deployed", composeFile, result: parsedToolAnswer(input.id, "deploy_stack", text, DeployStackToolResultSchema) };
    } catch (error) {
        // It ran and answered something else: what it did is unknown, as with a dropped link.
        return { kind: "lost", error: errorMessage(error) };
    }
};
