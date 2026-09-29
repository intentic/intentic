import { providerLabel, type SubagentSession } from "@intentic/sandbox-contract";
import { NO_ATTENTION } from "../../fleet/agentStatus";
import type { FleetAgent } from "../../fleet/useAgents-fleet";
import { childLook, runLook } from "./childLook";

// Pins what a child says it runs on: the model and tier its turn ran with, in one short chip, with the exact ids in its
// hover; and nothing at all where nothing was recorded, rather than a guess from its parent.

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
    it(`names the model and its tier, with the exact ids in the hover`, () => {
        const run = runLook(`claude`, `claude-custom-model`, `high`, undefined);
        expect(run?.label).toMatch(/ · High$/);
        expect(run?.tip.rows?.map((row) => row.value)).toEqual([providerLabel(`claude`), `claude-custom-model`, `High`]);
    });

    it(`names the model alone when no tier was pinned, and nothing when no model was recorded`, () => {
        expect(runLook(`claude`, `claude-custom-model`, undefined, undefined)?.label).not.toContain(`·`);
        expect(runLook(`claude`, undefined, `high`, undefined)).toBeUndefined();
    });

    it(`reads a spawned child's own turn, and puts it in the title's hover`, () => {
        const look = childLook(spawned({ provider: `codex`, model: `gpt-x`, effort: `low` }), `claude`);
        expect(look.run?.tip.rows?.map((row) => row.value)).toEqual([providerLabel(`codex`), `gpt-x`, `Low`]);
        expect(look.titleHint).toEqual(look.run?.tip);
    });

    it(`gives an in-process subagent its parent's provider and no tier, keeping the note on where it opens`, () => {
        const look = childLook(inProcess({ model: `claude-haiku-x` }), `claude`);
        expect(look.run?.tip.rows?.map((row) => row.value)).toEqual([providerLabel(`claude`), `claude-haiku-x`]);
        expect(look.titleHint).toMatchObject({ note: expect.any(String) });
        expect(childLook(inProcess(), `claude`).run).toBeUndefined();
    });
});
