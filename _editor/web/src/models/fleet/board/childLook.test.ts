import { providerLabel } from "@intentic/sandbox-contract/models/agent-catalog";
import type { SubagentSession } from "@intentic/sandbox-contract/schemas/terminal";
import { NO_ATTENTION } from "../../agent-status/agentStatus-lanes";
import type { FleetAgent } from "../useAgents-fleet";
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
        expect(look.titleHint).toEqual({ title: providerLabel(`codex`) });
        expect(childLook(spawned({ provider: `claude` }), `claude`).titleHint).toBeUndefined();
    });

    it(`names only a chosen subagent type, and only in the title's hover`, () => {
        expect(childLook(inProcess({ description: `Scan`, agentType: `general-purpose` }), `claude`).titleHint?.title).toBe(`In-process`);
        expect(childLook(inProcess({ description: `Scan` }), `claude`).titleHint?.title).toBe(`In-process · Explore`);
    });

    it(`reads an in-process subagent's served model and tier on its parent's provider, keeping the note on where it opens`, () => {
        const look = childLook(inProcess({ model: `claude-opus-x`, effort: `max` }), `claude`);
        expect(look.run).toMatchObject({ provider: `claude`, modelId: `claude-opus-x`, effort: { label: `Max` } });
        expect(look.titleHint).toMatchObject({ note: expect.any(String) });
        expect(childLook(inProcess(), `claude`).run).toBeUndefined();
    });
});

describe(`what a fresh session on the parent's work says it is`, () => {
    it(`names its kind, and what its review found once it reported`, () => {
        expect(childLook(spawned(), `claude`).fresh).toBeUndefined();
        expect(childLook(spawned({ fresh: { of: `p`, kind: `test`, at: 1 } }), `claude`).fresh).toMatchObject({ icon: `play`, result: undefined, tone: `neutral` });
        const reviewed = spawned({ fresh: { of: `p`, kind: `review`, at: 1 }, review: { at: 2, source: `claude`, findings: 3, open: 2 } });
        expect(childLook(reviewed, `claude`).fresh).toMatchObject({ label: undefined, icon: `list-check`, result: `3 findings`, tone: `warning` });
        // Titled by its kind, its own title (which repeats the origin's name) in the hover.
        expect(childLook(reviewed, `claude`)).toMatchObject({ title: `Code review`, titleHint: { title: `child` } });
        const asked = spawned({ fresh: { of: `p`, kind: `ask`, at: 1 } });
        expect(childLook(asked, `claude`)).toMatchObject({ title: `child`, fresh: { label: `Fresh` } });
        const clean = spawned({ fresh: { of: `p`, kind: `review`, at: 1 }, review: { at: 2, source: `codex`, findings: 0, open: 0 } });
        expect(childLook(clean, `claude`).fresh).toMatchObject({ result: `no findings`, tone: `neutral` });
        expect(childLook(inProcess(), `claude`).fresh).toBeUndefined();
    });
});
