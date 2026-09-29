import type { SubagentSession } from "@intentic/sandbox-contract";
import { NO_ATTENTION } from "../../fleet/agentStatus";
import type { FleetAgent } from "../../fleet/useAgents-fleet";
import { childLook, runLook } from "./childLook";

// Pins what a child says it runs on: the model by name and the tier on that model's own ladder, drawn in words on the
// row and the bar rather than behind a hover; and nothing at all where nothing was recorded, rather than a guess.

const spawned = (over: Partial<FleetAgent> = {}): FleetAgent => ({
    id: `c`,
    title: `child`,
    status: `running`,
    provider: `claude`,
    harness: `native`,
    updatedAt: 1_000,
    attention: NO_ATTENTION,
    open: false,
    unread: false,
    unsent: false,
    startedBy: `agent:p`,
    ...over,
});
const inProcess = (over: Partial<SubagentSession> = {}): SubagentSession => ({
    id: `task-1`,
    kind: `subagent`,
    conversationId: `p`,
    agentType: `Explore`,
    status: `running`,
    startedAt: 1_000,
    activityAt: 1_000,
    ...over,
});

describe(`what a child says it runs on`, () => {
    it(`places its tier on the model's ladder, as the composer draws it`, () => {
        // Claude's floor ladder: low, medium, high, xhigh, max.
        expect(runLook(`claude`, `claude-custom-model`, `high`, undefined)).toMatchObject({
            provider: `claude`,
            modelId: `claude-custom-model`,
            effort: { label: `High`, rung: 2, rungs: 5 },
        });
        expect(runLook(`claude`, `claude-custom-model`, `max`, undefined)?.effort).toMatchObject({ label: `Max`, rung: 4 });
    });

    it(`names the model alone when no tier was recorded, and says nothing when no model was`, () => {
        expect(runLook(`claude`, `claude-custom-model`, undefined, undefined)?.effort).toBeUndefined();
        expect(runLook(`claude`, undefined, `high`, undefined)).toBeUndefined();
    });

    it(`reads a spawned child's own turn, on its own provider`, () => {
        const look = childLook(spawned({ provider: `codex`, model: `gpt-x`, effort: `low` }), `claude`);
        expect(look.run).toMatchObject({ provider: `codex`, modelId: `gpt-x`, effort: { label: `Low`, rung: 0 } });
        expect(look.titleHint).toBeUndefined();
    });

    it(`drops Claude's default subagent type from the row, keeping a chosen one`, () => {
        expect(childLook(inProcess({ description: `Scan`, agentType: `general-purpose` }), `claude`).tag).toBeUndefined();
        expect(childLook(inProcess({ description: `Scan` }), `claude`).tag).toBe(`Explore`);
    });

    it(`reads an in-process subagent's served model and tier on its parent's provider, keeping the note on where it opens`, () => {
        const look = childLook(inProcess({ model: `claude-opus-x`, effort: `max` }), `claude`);
        expect(look.run).toMatchObject({ provider: `claude`, modelId: `claude-opus-x`, effort: { label: `Max` } });
        expect(look.titleHint).toMatchObject({ note: expect.any(String) });
        expect(childLook(inProcess(), `claude`).run).toBeUndefined();
    });
});
