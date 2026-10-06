import { experimentArm } from "@intentic/agent-context/experiments";
import { type AgentTurn, SandboxSettingsSchema, capabilitiesOf } from "@intentic/sandbox-contract";
import { premiseOf, type TurnRuntime } from "./turn-premise.js";

// The map's form as the premise settles it: the arm picks compact or full, and a sandbox measuring nothing gets compact.

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
    ["a treated conversation", { workspaceMap: true, workspaceMapHoldout: 0.5 }, conversationIn("workspace-map-form", true), "compact"],
    ["a held-out conversation", { workspaceMap: true, workspaceMapHoldout: 0.5 }, conversationIn("workspace-map-form", false), "full"],
    ["a sandbox measuring nothing", { workspaceMap: true }, "conversation-0", "compact"],
] as const)("%s is sent a map on its opening turn, in the form its arm picks", (_case, settings, conversationId, form) => {
    const settled = premise(settings, conversationId);

    expect(settled.send.map).toBe(true);
    expect(settled.mapForm).toBe(form);
});

test("with the switch off neither arm is sent a map", () => {
    expect(premise({ workspaceMap: false, workspaceMapHoldout: 0.5 }, conversationIn("workspace-map-form", false)).send.map).toBe(false);
});
