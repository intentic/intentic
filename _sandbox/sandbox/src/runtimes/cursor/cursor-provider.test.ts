import type { AgentTurn, Capability } from "@intentic/sandbox-contract";
import { unstubbed } from "@intentic/testing";
import { beforeEach, expect, test, vi } from "vitest";
import type { AgentRequest } from "../../agent/run/agent.js";
import type { TurnContext } from "../../agent/run/turn/turn-plan.js";
import type { Services } from "../../composition.js";
import { testConfig } from "../../testing.js";
import { cursorMcpServers } from "./cursor-tools.js";
import { planCursorTurn } from "./cursor-provider.js";

/* What a Cursor turn is handed to reach out of itself: the daemon's http MCP tools, which cursorMcpServers mounts. */

vi.mock("./cursor-sdk.js", () => ({ CURSOR_SDK_MISSING: "missing sdk", cursorSdk: async () => ({ Agent: {} }) }));

// The login door reaches the environment builder, which reaches the provider registry, which imports this module back:
// benign when the daemon boots through the registry, a half-built module when a suite enters here. Nothing below signs
// anyone in, so the door stays out of the graph.
vi.mock("./cursor-accounts.js", () => ({ cursorAccountDoor: {} }));

const browserServers = vi.fn();
vi.mock("../../browser/tools/browser-tools.js", () => ({ browserServersOf: (...args: unknown[]) => browserServers(...args) }));

const ROOT = "/nowhere/cursor-plan";

const services = (overrides: Partial<Services> = {}): Services =>
    unstubbed<Services>("services", {
        tools: [],
        config: testConfig,
        hostBridgeToken: "host-bridge",
        webextBridgeToken: "webext-bridge",
        workspace: unstubbed<Services["workspace"]>("workspace", { root: ROOT }),
        cursorStore: unstubbed<Services["cursorStore"]>("cursorStore", {
            credentials: async () => [{ id: "cursor-one", apiKey: "key", connectedAt: 0 }],
        }),
        cursorModels: unstubbed<Services["cursorModels"]>("cursorModels", {
            models: async () => ({ models: [{ id: "composer-2.5", label: "Composer 2.5" }], default: "composer-2.5" }),
        }),
        async *cursorAgent() {},
        ...overrides,
    });

const context: TurnContext = {
    base: { prompt: "look at my browser", cwd: ROOT, signal: new AbortController().signal },
    attachmentPaths: [],
    localCwd: ROOT,
    effectiveCwd: ROOT,
    cliEnv: {},
    steering: undefined,
};

const turn = (overrides: Partial<AgentTurn> = {}): AgentTurn => ({ prompt: "look at my browser", ...overrides }) as AgentTurn;

const planned = async (granted: readonly Capability[], overrides: Partial<Services> = {}): Promise<AgentRequest> => {
    const plan = await planCursorTurn(services(overrides), turn({ conversationId: "conv-1" }), context, granted);
    expect(plan.ok).toBe(true);
    return (plan as { request: AgentRequest }).request;
};

beforeEach(() => {
    browserServers.mockReset();
    browserServers.mockResolvedValue({ servers: {}, accounts: {}, ports: {}, passkeys: {} });
});

// The connected browser is a peer bridge, not a browser-kind capability: without this the extension pairs, the skill
// lands on disk, and the turn is told "MCP server does not exist: chrome".
test("a connected browser extension reaches the turn as an http MCP server named for its card", async () => {
    const request = await planned([{ kind: "webext", id: "chrome", config: {} } as Capability]);

    expect(request.tools).toEqual([{ name: "chrome", url: `http://127.0.0.1:${testConfig.sandbox.port}/mcp/webext/chrome`, token: "webext-bridge" }]);
    expect(cursorMcpServers(request)).toEqual({
        chrome: { type: "http", url: `http://127.0.0.1:${testConfig.sandbox.port}/mcp/webext/chrome`, headers: { Authorization: "Bearer webext-bridge" } },
    });
});

// The conversation only lets the host bridge judge a command in context; it grants nothing, and its absence made the
// gate read every Cursor call as conversationless.
test("a connected machine reaches the turn with the conversation the command gate judges it in", async () => {
    const request = await planned([{ kind: "host", id: "radarsu-rog", config: {} } as Capability]);

    expect(request.tools).toEqual([
        { name: "radarsu-rog", url: `http://127.0.0.1:${testConfig.sandbox.port}/mcp/hosts/radarsu-rog?conversation=conv-1`, token: "host-bridge" },
    ]);
});

// Internal first, external last: mcpServersOf and cursorMcpServers both merge last-wins, so a same-named capability is
// the owner's override rather than a collision.
test("the daemon's own tools and the workspace's mcp capabilities arrive together, the capability last", async () => {
    const request = await planned([{ kind: "mcp", id: "saldeo", config: { url: "https://saldeo.example/mcp" } } as Capability], {
        tools: [{ name: "platform", url: "https://platform.example/mcp", token: "internal" }],
    });

    expect(request.tools?.map((tool) => tool.name)).toEqual(["platform", "saldeo"]);
});

// Absent, not empty: an empty list would still read as "this turn has tools" to anything checking the field.
test("a sandbox with nothing connected carries no tools field at all", async () => {
    expect((await planned([])).tools).toBeUndefined();
});

// Cursor publishes no allowance, so which connection serves follows the refusals this sandbox has collected.
const fleet = (ledger: Record<string, readonly string[]>): Partial<Services> => ({
    // Two models, since placement follows the one a turn names, and an unoffered id falls back to the catalog default.
    cursorModels: unstubbed<Services["cursorModels"]>("cursorModels", {
        models: async () => ({
            models: [
                { id: "composer-2.5", label: "Composer 2.5" },
                { id: "auto", label: "Auto" },
            ],
            default: "composer-2.5",
        }),
    }),
    cursorStore: unstubbed<Services["cursorStore"]>("cursorStore", {
        credentials: async () => [
            { id: "one", apiKey: "key-one", connectedAt: 0 },
            { id: "two", apiKey: "key-two", connectedAt: 1 },
        ],
    }),
    observedLimits: unstubbed<Services["observedLimits"]>("observedLimits", {
        spent: async (_provider, account) =>
            Object.fromEntries((ledger[account] ?? []).map((model) => [model, { at: Date.now(), message: "429 usage limit reached" }])),
    }),
});

const placed = async (overrides: Partial<Services>, input: Partial<AgentTurn> = {}) => {
    const plan = await planCursorTurn(services(overrides), turn({ conversationId: "conv-1", ...input }), context, []);
    expect(plan.ok).toBe(true);
    return plan as { account: string; request: AgentRequest };
};

test("an unnamed turn is placed on the account that still has the model it asked for", async () => {
    const plan = await placed(fleet({ one: ["composer-2.5"] }), { model: "composer-2.5" });

    expect(plan.account).toBe("two");
    expect(plan.request.cursorApiKey).toBe("key-two");
});

// The picker's whole point: a chosen account is spent on, spent allowance and all, so the refusal is the user's to see.
test("a named account is used even when it is the one out of the model", async () => {
    const plan = await placed(fleet({ one: ["composer-2.5"] }), { model: "composer-2.5", account: "one" });

    expect(plan.account).toBe("one");
});

test("a model neither account was refused keeps first-connected-is-default", async () => {
    const plan = await placed(fleet({ one: ["composer-2.5"] }), { model: "auto" });

    expect(plan.account).toBe("one");
});
