import type { McpServerConfig, McpSdkServerConfigWithInstance, Query } from "@anthropic-ai/claude-agent-sdk";
import { toolAnnotations } from "@intentic/sandbox-contract/peer-mcp-server";
import { sdk } from "../../../engines/claude-sdk.js";
import { DEVICES_SERVER } from "../../../peers/peer-tools.js";
import type { HostDeviceReach } from "../../../hosts/self-host.js";
import { opt } from "../../../opt.js";
import { recordSdkToolSchemas } from "./sdk-tool-listing.js";

// THE OWNER'S COMPUTERS, LOADED WHEN A TURN NEEDS THEM. The `devices` server (hosts/devices/devices-server.ts) lists ~46 tools,
// about 11k tokens of schemas, which a Claude Code turn without tool search carried from its first request whether or
// not it ever touched a computer. A Claude turn granted devices instead starts with one small tool, `devices` on the
// `reach` server: it says which computers are connected and adds the `devices` server to the running session, so its
// tools are there for the rest of the turn. The Claude Agent SDK adds a server mid-session with Query.setMcpServers,
// which is why this lives in the Claude harness only: the other runtimes (Codex, OpenCode, Cursor, ACP agents) are
// handed their MCP servers when they start and keep mounting `devices` from the first request.

/** The server the loader rides on: `mcp__reach__devices`. */
export const REACH_SERVER = "reach";

type Running = { readonly setMcpServers?: Query["setMcpServers"] };

// The running session and the servers it started with, told once the SDK's query exists (claude-code-stream.ts
// streamSdk). Starting is also when what each in-process server's tools cost is recorded (sdk-tool-listing.ts).
export interface SessionHandle {
    readonly started: (running: Running, servers: Record<string, McpServerConfig>) => void;
    readonly current: () => { readonly running: Running; readonly servers: Record<string, McpServerConfig> } | undefined;
}

export const sessionHandle = (logsDir: string | undefined, conversationId: string | undefined): SessionHandle => {
    let held: { readonly running: Running; readonly servers: Record<string, McpServerConfig> } | undefined;
    return {
        started: (running, servers) => {
            held = { running, servers };
            // allow(silent-catch): the record is a measurement (diagnostics tools); failing to write it costs the turn nothing.
            void recordSdkToolSchemas(logsDir, conversationId, servers).catch(() => undefined);
        },
        current: () => held,
    };
};

// setMcpServers drops every in-process server the call leaves out, so each call names all of them again.
const sdkServersOf = (servers: Record<string, McpServerConfig>): Record<string, McpSdkServerConfigWithInstance> =>
    Object.fromEntries(Object.entries(servers).filter((entry): entry is [string, McpSdkServerConfigWithInstance] => entry[1].type === "sdk"));

const reachLines = (reach: HostDeviceReach | undefined, ids: readonly string[]): string[] =>
    ids.map((id) => {
        const machine = reach?.machines?.find((candidate) => candidate.id === id);
        const sides = machine === undefined ? "" : ` (environments ${machine.environments.map((environment) => environment.key).join(", ")})`;
        return `- ${id}${sides}${reach?.self === id ? ", the computer this sandbox runs on" : ""}`;
    });

export interface DevicesOnDemand {
    // What the session is started with: every server but `devices`, and the loader in its place.
    readonly servers: Record<string, McpServerConfig>;
}

/**
 * Holds the `devices` server out of a Claude turn's starting servers and mounts the loader in its place; a turn with no
 * devices granted is handed back as it was.
 */
export const devicesOnDemand = (remote: Record<string, McpServerConfig>, session: SessionHandle, reach: HostDeviceReach | undefined): DevicesOnDemand => {
    const { [DEVICES_SERVER]: devices, ...rest } = remote;
    if (devices === undefined) {
        return { servers: remote };
    }
    const ids = reach?.ids ?? [];
    let loaded = false;
    const load = async (): Promise<string | undefined> => {
        if (loaded) {
            return undefined;
        }
        const current = session.current();
        const set = current?.running.setMcpServers;
        if (current === undefined || set === undefined) {
            return "The session is not running yet; call devices again.";
        }
        const result = await set.call(current.running, { ...sdkServersOf(current.servers), [DEVICES_SERVER]: devices });
        const error = result.errors[DEVICES_SERVER];
        if (error !== undefined) {
            return `The devices server did not connect: ${error}`;
        }
        loaded = true;
        return undefined;
    };
    const loader = sdk().createSdkMcpServer({
        name: REACH_SERVER,
        alwaysLoad: true,
        tools: [
            sdk().tool(
                "devices",
                `The owner's connected computers (${ids.join(", ")}): lists them and loads their tools for the rest of this turn ` +
                    `(run_command, read_file, write_file, screenshot, browser_*, android_*, list_sandboxes and the rest, as ` +
                    `\`mcp__${DEVICES_SERVER}__<tool>\`, each taking \`device\`). Call it once before your first action on a computer.`,
                {},
                async () => {
                    const failed = await load();
                    return {
                        content: [
                            {
                                type: "text" as const,
                                text:
                                    failed ??
                                    `Connected computers:\n${reachLines(reach, ids).join("\n")}\n` +
                                        `Their tools are loaded as \`mcp__${DEVICES_SERVER}__<tool>\` with \`device\` naming the computer. Where ` +
                                        `tools are deferred, load them with ToolSearch \`+mcp__${DEVICES_SERVER}__\`. Call describe once on a ` +
                                        `computer before your first command there.`,
                            },
                        ],
                        ...opt("isError", failed === undefined ? undefined : true),
                    };
                },
                // Adds tools to this turn and lists the computers: nothing outside the session changes.
                { annotations: toolAnnotations("read") },
            ),
        ],
    });
    return { servers: { ...rest, [REACH_SERVER]: loader } };
};
