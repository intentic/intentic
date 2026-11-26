import type { CiFleet, CiRunner } from "@intentic/sandbox-contract/schemas/ci-fleet";
import type { DeviceFacts } from "@intentic/sandbox-contract/schemas/hosts";
import { unstubbed } from "@intentic/testing";
import { z } from "zod";
import type { Capability } from "@intentic/sandbox-contract/schemas/capabilities";
import type { FetchFn } from "../../forge/http.js";
import { workspacePaths } from "../../workspace/workspace.js";
import type { CiFleetServices } from "../../ci/fleet/runner-registration.js";

// ONE CONNECTED COMPUTER WITH CI RUNNERS, AND GITHUB, FOR THE CI FLEET SUITES (device-ci-fleet.ts): whether the
// computer is connected, what its agent advertises and what its tools answer, whether a GitHub account is connected,
// and what GitHub answers a token request; every tool call and request recorded. The hub, the capabilities store and
// fetch are the seams faked; the tool call goes through the real `callTool`. Not part of the build.

export const FLEET_DEVICE = "omen";

// A token as GitHub mints one: long enough for the machine's schema, and never to appear in anything but the tool call.
export const MINTED = "AABBCCDDEEFFGGHHIIJJKKLLMMNN";

export interface ToolAnswer {
    readonly text: string;
    readonly refused?: boolean;
}

// What a CI fleet tool takes: names, ops, counts, a token, and a new runner's labels.
const ToolArgsSchema = z.record(z.string(), z.union([z.string(), z.number(), z.array(z.string())]));

export interface ToolCall {
    readonly tool: string;
    readonly args: z.infer<typeof ToolArgsSchema>;
    readonly signal: AbortSignal | undefined;
}

export interface MintRequest {
    readonly url: string;
    readonly method: string | undefined;
    readonly authorization: string | undefined;
}

const FACTS: DeviceFacts = { os: "Arch Linux", arch: "x64", shell: "zsh", home: "/home/radarsu", roots: ["/home/radarsu"], wsl: { distro: "archlinux" } };

const ToolRequestSchema = z.object({ params: z.object({ name: z.string(), arguments: ToolArgsSchema }) });

const GITHUB: Capability = { id: "github", kind: "cli", config: { provider: "github", token: "ghp_connection" } };

export const RUNNER: CiRunner = {
    name: "radarsu-worker-3",
    unit: "actions.runner.acme-web.radarsu-worker-3.service",
    dir: "/home/radarsu/actions-runner-3",
    user: "radarsu",
    url: "https://github.com/acme/web",
    version: "2.329.0",
    light: false,
    state: "active",
    busy: false,
    draining: false,
};

export const FLEET: CiFleet = {
    service: { running: true, installed: true, version: "0.42.0" },
    runners: [RUNNER],
    cacheRoot: "/ci-cache",
    caches: [{ name: "pnpm-store", bytes: 4_000_000_000 }],
};

const silent = async (): Promise<ToolAnswer> => ({ text: "" });
const minted: FetchFn = async () => new Response(JSON.stringify({ token: MINTED, expires_at: "2026-11-24T13:00:00Z" }), { status: 201 });

export interface FleetDeviceOptions {
    readonly online?: boolean;
    readonly features?: readonly string[];
    readonly tool?: (call: ToolCall) => Promise<ToolAnswer>;
    // Whether a GitHub account is connected to the sandbox.
    readonly github?: boolean;
    // What GitHub answers a token request.
    readonly mint?: FetchFn;
    // The workspace a registration resolves its repository in.
    readonly root?: string;
}

export const fleetDevice = (over: FleetDeviceOptions = {}) => {
    const tools: ToolCall[] = [];
    const mints: MintRequest[] = [];
    const online = over.online ?? true;
    const services: CiFleetServices = {
        workspace: workspacePaths(over.root ?? "/nowhere"),
        capabilities: unstubbed<CiFleetServices["capabilities"]>("capabilities", { list: async () => (over.github === false ? [] : [GITHUB]) }),
        hostHub: unstubbed<CiFleetServices["hostHub"]>("hostHub", {
            client: (id) => (online && id === FLEET_DEVICE ? unstubbed("client", {}) : undefined),
            online: (id) => online && id === FLEET_DEVICE,
            offline: (id) => `"${id}" is not connected right now: the device is asleep, offline, or its agent isn't running.`,
            state: () => ({ online, facts: { ...FACTS, features: [...(over.features ?? ["ci-runners"])] } }),
            mcp: async (_device, payload, options) => {
                const { name, arguments: args } = ToolRequestSchema.parse(payload).params;
                const call: ToolCall = { tool: name, args, signal: options?.signal };
                tools.push(call);
                const answer = await (over.tool ?? silent)(call);
                return { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: answer.text }], isError: answer.refused === true } };
            },
        }),
    };
    const fetchFn: FetchFn = async (input, init) => {
        const headers = new Headers(init?.headers);
        mints.push({ url: String(input), method: init?.method, authorization: headers.get("authorization") ?? undefined });
        return await (over.mint ?? minted)(input, init);
    };
    return { services, tools, mints, fetchFn };
};
