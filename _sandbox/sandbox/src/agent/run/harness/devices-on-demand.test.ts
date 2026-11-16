import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { devicesOnDemand, REACH_SERVER, sessionHandle } from "./devices-on-demand.js";

const devices: McpServerConfig = { type: "http", url: "http://127.0.0.1:1/mcp/devices", headers: { Authorization: "Bearer t" } };
const chrome: McpServerConfig = { type: "http", url: "http://127.0.0.1:1/mcp/chrome" };
const reach = { ids: ["rog", "omen"], self: "rog", machines: [{ id: "rog", environments: [{ key: "native" }, { key: "wsl:archlinux", distro: "archlinux" }] }] };

// The loader through the SDK server's own registry; `_registeredTools` is private to McpServer, hence the cast.
const callDevices = async (servers: Record<string, McpServerConfig>): Promise<{ text: string; isError: boolean | undefined }> => {
    const loader = servers[REACH_SERVER];
    // SAFETY: devicesOnDemand mounts the loader as an SDK server, whose live McpServer files each tool under its name.
    const registry = (loader as unknown as { instance: { _registeredTools: Record<string, { handler: (a: unknown, e: unknown) => Promise<unknown> }> } }).instance;
    // SAFETY: the handler answers a CallToolResult of text parts, as every tool here does.
    const result = (await registry["_registeredTools"]["devices"]?.handler({}, {})) as { content: { text: string }[]; isError?: boolean };
    return { text: result.content.map((part) => part.text).join("\n"), isError: result.isError };
};

test("a turn with no devices is handed back as it was", () => {
    expect(devicesOnDemand({ chrome }, sessionHandle(undefined, undefined), undefined).servers).toEqual({ chrome });
});

test("devices waits behind the loader, which adds it to the running session once, naming every in-process server again", async () => {
    const session = sessionHandle(undefined, "c1");
    const { servers } = devicesOnDemand({ chrome, devices }, session, reach);
    expect(Object.keys(servers)).toEqual(["chrome", REACH_SERVER]);

    const calls: Record<string, McpServerConfig>[] = [];
    const running = {
        setMcpServers: async (next: Record<string, McpServerConfig>) => {
            calls.push(next);
            return { added: ["devices"], removed: [], errors: {} };
        },
    };
    // An in-process sibling, as `ui` is beside the loader in a real turn.
    const sibling = devicesOnDemand({ devices }, sessionHandle(undefined, undefined), reach).servers[REACH_SERVER];
    session.started(running, sibling === undefined ? servers : { ...servers, ui: sibling });

    const first = await callDevices(servers);
    expect(first.text).toContain("- rog (environments native, wsl:archlinux), the computer this sandbox runs on\n- omen");
    expect(first.text).toContain("`mcp__devices__<tool>`");
    await callDevices(servers);
    expect(calls).toHaveLength(1);
    // setMcpServers drops every in-process server a call leaves out, so the loader and its siblings ride along; an HTTP
    // server the session started with stays without being named.
    expect(Object.keys(calls[0] ?? {}).toSorted()).toEqual(["devices", "reach", "ui"]);
    expect(calls[0]?.["devices"]).toBe(devices);
});

test("a server that does not connect is said as the tool's error, and the next call tries again", async () => {
    const session = sessionHandle(undefined, undefined);
    const { servers } = devicesOnDemand({ devices }, session, reach);
    let attempts = 0;
    session.started(
        {
            setMcpServers: async () => {
                attempts += 1;
                return { added: [], removed: [], errors: attempts === 1 ? { devices: "connection refused" } : {} };
            },
        },
        servers,
    );
    expect(await callDevices(servers)).toEqual({ text: "The devices server did not connect: connection refused", isError: true });
    expect((await callDevices(servers)).isError).not.toBe(true);
    expect(attempts).toBe(2);
});
