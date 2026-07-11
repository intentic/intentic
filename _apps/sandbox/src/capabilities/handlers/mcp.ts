import type { McpConfig } from "@intentic/sandbox-contract";
import type { CapabilityHandler } from "../capability.js";

// A single-shot reachability probe: the agent reaches the MCP over HTTP, so "healthy" ≈ it answers at all within
// 2s (a bare GET may 401/404 but that still proves it's up). Never throws — a probe failure is just "error".
const reachable = async (url: string, token: string | undefined): Promise<boolean> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);
    try {
        const response = await fetch(url, {
            signal: controller.signal,
            ...(token !== undefined ? { headers: { Authorization: `Bearer ${token}` } } : {}),
        });
        return response.status < 500;
    } catch {
        return false;
    } finally {
        clearTimeout(timer);
    }
};

// MCP server: an agent tool. Registration IS the manifest entry — the route upserts it and the agent merge reads
// mcp-kind capabilities — so apply just confirms and status probes the endpoint. remove is a no-op: dropping the
// manifest entry (in the route) is what removes it from the agent.
export const mcpHandler: CapabilityHandler = {
    apply: async function* (_ctx, _id, config) {
        const { url } = config as McpConfig;
        yield { kind: "log", message: `Registered MCP server ${url} — the agent can call it next turn.` };
    },
    status: async (_ctx, _id, config) => {
        const { url, token } = config as McpConfig;
        return (await reachable(url, token)) ? { state: "active" } : { state: "error", detail: "unreachable" };
    },
    remove: async () => {},
};
