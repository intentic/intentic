import { experimentArm } from "@intentic/agent-context/experiments";
import { type AgentTurn, SandboxSettingsSchema, capabilitiesOf } from "@intentic/sandbox-contract";
import { premiseOf, type TurnRuntime } from "./turn-premise.js";

// Whether the premise sends the map: the arm decides where one was drawn, the switch where none was.

const conversationIn = (salt: string, arm: boolean): string => {
    const id = Array.from({ length: 64 }, (_, index) => `conversation-${index}`).find((each) => experimentArm(salt, each, 0.5) === arm);
    if (id === undefined) {
        throw new Error(`no conversation draws ${String(arm)} under ${salt}`);
    }
    return id;
};

const RUNTIME: TurnRuntime = { provider: "claude", harness: "claude-code", capabilities: capabilitiesOf("claude", "claude-code"), conversationTurns: 0 };

const premise = (settings: object, conversationId: string | undefined) =>
    premiseOf(
        { entry: undefined, settings: SandboxSettingsSchema.parse(settings), personas: [], areas: [] },
        { prompt: "hi", ...(conversationId === undefined ? {} : { conversationId }) } as AgentTurn,
        RUNTIME,
    );

test.each([
    ["a treated conversation", { workspaceMap: true, workspaceMapHoldout: 0.5 }, conversationIn("workspace-map-or-none", true), true],
    ["a held-out conversation", { workspaceMap: true, workspaceMapHoldout: 0.5 }, conversationIn("workspace-map-or-none", false), false],
    ["a sandbox measuring nothing", { workspaceMap: true }, "conversation-0", true],
] as const)("%s is sent the map on its opening turn only if its arm says so", (_case, settings, conversationId, sent) => {
    expect(premise(settings, conversationId).send.map).toBe(sent);
});

test("with the switch off neither arm is sent a map", () => {
    expect(premise({ workspaceMap: false, workspaceMapHoldout: 0.5 }, conversationIn("workspace-map-or-none", true)).send.map).toBe(false);
});
