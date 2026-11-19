import { z } from "zod";
import { MCP_PROTOCOL_VERSION } from "@intentic/sandbox-contract/peer-mcp-server";
import type { MountCall, RpcEndpoint } from "../../agent/tools/turn-mounts.routes.js";
import type { RpcMessage } from "../../agent/tools/turn-mounts.js";
import { opt } from "../../opt.js";
import type { HostSummary } from "@intentic/sandbox-contract/schemas/hosts";
import type { Services } from "../../composition.js";
import { hostSummaries } from "../host-peer.js";

// EVERY CONNECTED COMPUTER BEHIND ONE MCP SERVER. A turn granted several devices used to mount each as a server of its
// own (`mcp__rog__run_command`, `mcp__omen__run_command`, …), every one listing the same ~46 tools: about 11k tokens of
// identical schemas per device before the user typed anything, four copies with four computers connected (2026-11-16).
// Now the turn mounts one `devices` server, and each tool takes a required `device` naming the card it acts on. Routing
// is all that moved: the call, stripped of `device`, goes through the per-card bridge exactly as a call to that card's
// own server did (hosts/host-peer.ts's mcp: the environment crossing, the call gate, approval cards, the destructive
// switch, the seal and the device's own audit trail), so every refusal and error reads as it did.

// The argument every devices tool takes, naming the computer by its card id.
const DEVICE_ARGUMENT = "device";

// Agents reach for Bash's `timeout` on run_command, whose deadline is `timeoutMs` (2026-11-16): taken as the same
// milliseconds here, so a device agent of any version reads it.
const TIMEOUT_ALIASED = new Set(["run_command"]);

export interface DevicesTarget {
    readonly kind: "devices";
    readonly ids: readonly string[];
}

export interface DevicesDeps {
    // One card's own bridge: what a per-card server answered before.
    readonly device: (target: { readonly kind: "device"; readonly id: string }, message: RpcMessage, call: MountCall) => Promise<RpcMessage | undefined>;
    // The granted cards with any side holding a socket now, for an error that names where a call could go.
    readonly connected: (ids: readonly string[]) => Promise<readonly string[]>;
    // One line per granted card (its OS and environments), said once in the server's instructions.
    readonly describe: (ids: readonly string[]) => Promise<readonly string[]>;
}

const ListedTool = z.looseObject({
    name: z.string(),
    description: z.string().optional(),
    inputSchema: z.looseObject({ properties: z.record(z.string(), z.unknown()).optional(), required: z.array(z.string()).optional() }).optional(),
});
type ListedTool = z.infer<typeof ListedTool>;
const Listing = z.looseObject({ tools: z.array(z.unknown()) });
const CallParams = z.looseObject({ name: z.string(), arguments: z.record(z.string(), z.unknown()).optional() });

const errorResult = (message: RpcMessage, text: string): RpcMessage | undefined =>
    message.id === undefined ? undefined : { jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text }], isError: true } };

const listOf = (ids: readonly string[]): string => (ids.length === 0 ? "none" : ids.map((id) => `"${id}"`).join(", "));

// One tool as the devices server lists it: its own schema with `device` first and required. The enum says what `device`
// takes; a description rides only on a tool some computers lack, since 46 copies of one sentence cost ~1k tokens.
const withDevice = (tool: ListedTool, ids: readonly string[], on: readonly string[]): ListedTool => {
    const schema = tool.inputSchema ?? {};
    const device = { type: "string", enum: [...ids], ...opt("description", on.length < ids.length ? `Only on ${on.join(", ")}.` : undefined) };
    const aliased = TIMEOUT_ALIASED.has(tool.name) && schema.properties?.["timeoutMs"] !== undefined;
    const timeout = { type: "integer", exclusiveMinimum: 0, description: "Same as timeoutMs, in milliseconds." };
    const properties = { [DEVICE_ARGUMENT]: device, ...schema.properties, ...opt("timeout", aliased ? timeout : undefined) };
    return { ...tool, inputSchema: { type: "object", ...schema, properties, required: [DEVICE_ARGUMENT, ...(schema.required ?? [])] } };
};

// The union of what each device lists, first listing first; a tool only some devices have says which.
const mergedListing = (listings: readonly { readonly id: string; readonly tools: readonly ListedTool[] }[], ids: readonly string[]): ListedTool[] => {
    const order: string[] = [];
    const first = new Map<string, ListedTool>();
    const holders = new Map<string, string[]>();
    for (const { id, tools } of listings) {
        for (const tool of tools) {
            if (!first.has(tool.name)) {
                first.set(tool.name, tool);
                order.push(tool.name);
            }
            holders.set(tool.name, [...(holders.get(tool.name) ?? []), id]);
        }
    }
    const listed = listings.map((listing) => listing.id);
    return order.flatMap((name) => {
        const tool = first.get(name);
        const on = holders.get(name) ?? [];
        return tool === undefined ? [] : [withDevice(tool, ids, on.length === listed.length ? ids : on)];
    });
};

const listTools = async (deps: DevicesDeps, ids: readonly string[], message: RpcMessage, call: MountCall): Promise<RpcMessage> => {
    const answers = await Promise.all(
        ids.map(async (id) => ({ id, answer: await deps.device({ kind: "device", id }, { jsonrpc: "2.0", id: message.id ?? 0, method: "tools/list" }, call) })),
    );
    const listings = answers.flatMap(({ id, answer }) => {
        const listing = Listing.safeParse(answer?.result);
        if (!listing.success) {
            return [];
        }
        return [{ id, tools: listing.data.tools.flatMap((raw) => (ListedTool.safeParse(raw).success ? [ListedTool.parse(raw)] : [])) }];
    });
    if (listings.length === 0) {
        // Nothing listed at all: the first bridge's own error says why, as one device's server did.
        return answers[0]?.answer ?? { jsonrpc: "2.0", id: message.id ?? null, result: { tools: [] } };
    }
    return { jsonrpc: "2.0", id: message.id ?? null, result: { tools: mergedListing(listings, ids) } };
};

// (2026-11-17, the shinobi-society audit) Agents moved tarballs and binaries with `docker cp` through run_command, which
// only works where this sandbox's container runs on that computer: the copy command is said where every device turn reads.
const instructionsOf = (lines: readonly string[]): string =>
    `The owner's connected computers, one server for all of them: every tool takes \`${DEVICE_ARGUMENT}\`, the computer it acts on. ` +
    `Call describe once on a computer before your first command there. A file or a folder moves between this sandbox and a computer, ` +
    `either way, with \`devices copy <from> <to>\` in your shell, one side written <device>:<path>: its bytes never pass through you, ` +
    `and it is never docker cp through run_command. A build, a test or a GPU run of this checkout on a computer is \`devices exec <device> -- <command>\`: ` +
    `a mirror of the checkout kept there by content hash, the output streamed back, results brought home with --fetch.\n${lines.map((line) => `- ${line}`).join("\n")}`;

// The call as the named card's bridge reads it: `device` taken out, run_command's `timeout` read as timeoutMs.
const forwardedCall = (message: RpcMessage, params: z.infer<typeof CallParams>): RpcMessage => {
    const { [DEVICE_ARGUMENT]: _named, ...rest } = params.arguments ?? {};
    const { timeout, ...kept } = rest;
    const args = TIMEOUT_ALIASED.has(params.name) && timeout !== undefined && kept["timeoutMs"] === undefined ? { ...kept, timeoutMs: timeout } : rest;
    return { ...message, params: { ...params, arguments: args } };
};

const callTool = async (deps: DevicesDeps, ids: readonly string[], message: RpcMessage, call: MountCall): Promise<RpcMessage | undefined> => {
    const params = CallParams.safeParse(message.params);
    if (!params.success) {
        return message.id === undefined ? undefined : { jsonrpc: "2.0", id: message.id, error: { code: -32602, message: "tools/call needs a tool name" } };
    }
    const named = z.string().safeParse(params.data.arguments?.[DEVICE_ARGUMENT]);
    // Card ids are lower-case slugs; a model's "ROG" means rog.
    const id = named.success ? ids.find((candidate) => candidate.toLowerCase() === named.data.toLowerCase()) : undefined;
    if (id === undefined) {
        const connected = await deps.connected(ids);
        const said = named.success ? `No connected computer is named "${named.data}".` : `${params.data.name} needs \`${DEVICE_ARGUMENT}\`: which computer to act on.`;
        return errorResult(message, `${said} Connected now: ${listOf(connected)}${connected.length < ids.length ? `; granted to this turn: ${listOf(ids)}` : ""}.`);
    }
    const answer = await deps.device({ kind: "device", id }, forwardedCall(message, params.data), call);
    if (answer?.error === undefined) {
        return answer;
    }
    // A transport error (the computer asleep, gone quiet mid-call) reads with where else a call could go.
    const connected = await deps.connected(ids);
    const others = connected.filter((other) => other !== id);
    const error = z.looseObject({ message: z.string() }).safeParse(answer.error);
    return error.success && others.length > 0 ? { ...answer, error: { ...error.data, message: `${error.data.message} Connected now: ${listOf(others)}.` } } : answer;
};

/** The devices server's endpoint: answers the handshake itself, merges the cards' tool lists, routes each call by `device`. */
export const createDevicesEndpoint =
    (deps: DevicesDeps): RpcEndpoint<DevicesTarget> =>
    async (target, message, call) => {
        switch (message.method) {
            case "initialize":
                return {
                    jsonrpc: "2.0",
                    id: message.id ?? null,
                    result: {
                        protocolVersion: MCP_PROTOCOL_VERSION,
                        capabilities: { tools: {} },
                        serverInfo: { name: "intentic-devices", version: "1" },
                        instructions: instructionsOf(await deps.describe(target.ids)),
                    },
                };
            case "tools/list":
                return await listTools(deps, target.ids, message, call);
            case "tools/call":
                return await callTool(deps, target.ids, message, call);
            case "ping":
                return { jsonrpc: "2.0", id: message.id ?? null, result: {} };
            default:
                // Notifications (initialized, cancelled) expect no answer; anything else is not a method this server has.
                return message.id === undefined ? undefined : { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `no method ${message.method ?? ""}` } };
        }
    };

// A summary's line in the server's instructions: `rog: Windows, environments native, wsl:archlinux (offline)`.
const summaryLine = (summary: HostSummary): string => {
    const sides = summary.environments.map((environment) => `${environment.key}${environment.online ? "" : " (offline)"}`);
    return `${summary.id}: ${summary.facts?.os ?? summary.platform}, environments ${sides.join(", ")}`;
};

/** The devices server's reach into the hosts door, read off the summaries every screen reads. */
export const hostDevicesDeps = (services: Services, device: DevicesDeps["device"]): DevicesDeps => ({
    device,
    connected: async (ids) =>
        (await hostSummaries(services)).filter((summary) => ids.includes(summary.id) && summary.environments.some((side) => side.online)).map((summary) => summary.id),
    describe: async (ids) => {
        const summaries = await hostSummaries(services);
        return ids.map((id) => {
            const summary = summaries.find((candidate) => candidate.id === id);
            return summary === undefined ? `${id}: not connected yet` : summaryLine(summary);
        });
    },
});
