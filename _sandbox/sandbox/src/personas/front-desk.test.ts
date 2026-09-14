import { FRONT_DESK_PERSONA, PersonaPowersSchema } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import { memoryPersonasStore } from "../harness/route-stores.testing.js";
import { ensureFrontDeskPersona } from "./front-desk.js";

/* The card follows the need. */
test("writes the front desk into a workspace that has no personas", async () => {
    const personas = memoryPersonasStore();
    await ensureFrontDeskPersona(personas);
    const card = await personas.get(FRONT_DESK_PERSONA);
    // Read-only and speaking for nobody: the two properties a stranger-driven wake depends on.
    expect(card?.powers).toMatchObject({ files: "read", shell: false, web: false, delegate: false });
    expect(card?.capabilities).toEqual([]);
});

/* THE OWNER'S EDITS SURVIVE. */
test("leaves a front desk the owner has widened alone", async () => {
    const personas = memoryPersonasStore([
        {
            id: FRONT_DESK_PERSONA,
            label: "Front desk",
            capabilities: ["reddit-work"],
            powers: PersonaPowersSchema.parse({ files: "read", web: true }),
        },
    ]);
    await ensureFrontDeskPersona(personas);
    expect(await personas.get(FRONT_DESK_PERSONA)).toMatchObject({ capabilities: ["reddit-work"], powers: { web: true } });
    // And no second copy of the card.
    expect(await personas.list()).toHaveLength(1);
});
