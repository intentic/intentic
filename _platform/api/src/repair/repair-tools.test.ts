import { REPAIR_SYSTEM_PROMPT, REPAIR_TOOL_NAMES, repairToolDefinitions } from "./repair-tools.js";
import { repairTurnBodySchema } from "./repair-turn-schema.js";

// Repair's tools as the model is handed them: one definition for every name the turn schema takes, and the move between
// engines described as what it is, a change the reader allows on the PC, minutes long, to one of two engines.

const fn = (definition: Record<string, unknown>) => definition[`function`] as { name: string; description: string; parameters: Record<string, unknown> };

describe(`Repair's tools`, () => {
    it(`defines exactly the tools it names, once each`, () => {
        const defined = repairToolDefinitions().map((definition) => fn(definition).name);
        expect(new Set(defined).size).toBe(defined.length);
        expect([...defined].sort()).toEqual([...REPAIR_TOOL_NAMES].sort());
    });

    it(`moves sandboxes between engines only at the reader's Allow, to one of the two engines`, () => {
        const move = repairToolDefinitions().map(fn).find((tool) => tool.name === `engine_move`);
        expect(move?.description).toContain(`must Allow`);
        expect(move?.description).toContain(`put back`);
        expect(move?.parameters).toMatchObject({ required: [`to`], properties: { to: { enum: [`intentic`, `docker-desktop`] } } });
        expect(REPAIR_SYSTEM_PROMPT).toContain(`engine_move`);
    });

    it(`takes a turn in which the model asked for a move`, () => {
        const turn = {
            messages: [
                { role: `user`, content: `move my sandboxes off Docker Desktop` },
                { role: `assistant`, content: ``, toolCalls: [{ id: `c1`, name: `engine_move`, arguments: `{"to":"intentic"}` }] },
            ],
        };
        expect(repairTurnBodySchema.safeParse(turn).success).toBe(true);
    });
});
