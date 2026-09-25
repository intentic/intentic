import type { AgentTurn, Capability } from "@intentic/sandbox-contract";
import { unstubbed } from "@intentic/testing";
import type { AgentRequest } from "../../agent/providers/agent-request.js";
import type { TurnContext } from "../../agent/providers/adapter.js";
import type { Services } from "../../composition.js";
import { memoryFleet, testConfig, testTurnMounts } from "../../testing.js";
import * as browserToolsOriginal from "../../browser/tools/browser-tools.js";
import * as cursorSdkOriginal from "./cursor-sdk.js";
import { parkedCards } from "../../agents/actor/parked-cards.js";

// Where a turn here parks its cards: one fleet's actors.
const cards = parkedCards(memoryFleet().conversations);

/* What a Cursor turn is handed to reach out of itself: the turn's remote MCP servers, which cursorMcpServers mounts. */

jest.mock("./cursor-sdk.js", () => ({ ...cursorSdkOriginal, CURSOR_SDK_MISSING: "missing sdk", cursorSdk: async () => ({ Agent: {} }) }));

const browserServers = jest.fn();
jest.mock("../../browser/tools/browser-tools.js", () => ({
    ...browserToolsOriginal,
    browserServersOf: (...args: unknown[]) => browserServers(...args),
}));

// Loaded after the mocks: jest.mock binds at this point, and a static import would have already evaluated the graph.
const { cursorMcpServers } = await import("./cursor-tools.js");
const { planCursorTurn } = await import("./cursor-provider.js");

const ROOT = "/nowhere/cursor-plan";

const services = (overrides: Partial<Services> = {}): Services =>
    unstubbed<Services>("services", {
        tools: [],
        config: testConfig,
        ...testTurnMounts(),
        // Every turn looks for extensions serving tools of their own; none are installed here.
        capabilities: unstubbed<Services["capabilities"]>("capabilities", { list: async () => [] }),
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
    base: { spec: { prompt: "look at my browser", cwd: ROOT }, policy: {}, tools: {}, hooks: { cards }, signal: new AbortController().signal },
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
    browserServers.mockResolvedValue({ servers: [], accounts: {}, ports: {}, passkeys: {} });
});

// The connected browser is a peer bridge, not a browser-kind capability: without this the extension pairs, the skill
// lands on disk, and the turn is told "MCP server does not exist: chrome".
test("a connected browser extension reaches the turn as an http MCP server named for its card", async () => {
    const mounts = testTurnMounts();
    const request = await planned([{ kind: "webext", id: "chrome", config: {} } as Capability], mounts);
    const token = request.tools.remote?.[0]?.token ?? "";

    expect(request.tools.remote).toEqual([{ name: "chrome", url: `http://127.0.0.1:${testConfig.sandbox.port}/mcp/chrome`, token }]);
    expect(mounts.turnMounts.resolve(token, "chrome")).toEqual({ target: { kind: "webext", id: "chrome" }, conversationId: "conv-1" });
    expect(cursorMcpServers(request)).toEqual({
        chrome: {
            type: "http",
            url: `http://127.0.0.1:${testConfig.sandbox.port}/mcp/chrome`,
            headers: { Authorization: `Bearer ${token}` },
        },
    });
});

// The conversation lets the host bridge judge a command in context; it rides the mount, never the URL, and its absence
// made the gate read every Cursor call as conversationless.
test("a connected machine reaches the turn with the conversation the command gate judges it in", async () => {
    const mounts = testTurnMounts();
    const request = await planned([{ kind: "device", id: "radarsu-rog", config: {} } as Capability], mounts);
    const token = request.tools.remote?.[0]?.token ?? "";

    expect(request.tools.remote).toEqual([{ name: "radarsu-rog", url: `http://127.0.0.1:${testConfig.sandbox.port}/mcp/radarsu-rog`, token }]);
    expect(mounts.turnMounts.resolve(token, "radarsu-rog")).toEqual({ target: { kind: "device", id: "radarsu-rog" }, conversationId: "conv-1" });
});

// Internal first, external last: mcpServersOf and cursorMcpServers both merge last-wins, so a same-named capability is
// the owner's override rather than a collision.
test("the daemon's own tools and the workspace's mcp capabilities arrive together, the capability last", async () => {
    const request = await planned([{ kind: "mcp", id: "saldeo", config: { url: "https://saldeo.example/mcp" } } as Capability], {
        tools: [{ name: "platform", url: "https://platform.example/mcp", token: "internal" }],
    });

    expect(request.tools.remote?.map((tool) => tool.name)).toEqual(["platform", "saldeo"]);
});

// Absent, not empty: an empty list would still read as "this turn has tools" to anything checking the field.
test("a sandbox with nothing connected carries no tools field at all", async () => {
    expect((await planned([])).tools.remote).toBeUndefined();
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
    expect(plan.request.credential).toEqual({ kind: "cursor-key", apiKey: "key-two" });
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
