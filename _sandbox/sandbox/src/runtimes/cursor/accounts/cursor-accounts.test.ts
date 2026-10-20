import { unstubbed } from "@intentic/testing";
import type { Services } from "../../../composition.js";
import { cursorAccountDoor } from "./cursor-accounts.js";

/* Cursor publishes no allowance, so its rows carry no reading of their own making: what tells two accounts apart is what
   each has refused, which every surface reads from the one refusal ledger and lays on the row by the one rule
   (plan-pools.ts judgedReading). A projection of the ledger into readings was a second copy, swept on its own clock. */

test("lists the connected accounts as stored, with no reading and no sweep", async () => {
    const services = unstubbed<Services>(`services`, {
        cursorStore: unstubbed<Services[`cursorStore`]>(`cursorStore`, {
            list: async () => [
                { id: `one`, label: `Cursor`, connectedAt: 0 },
                { id: `two`, label: `Cursor`, connectedAt: 1 },
            ],
        }),
    });

    const rows = await cursorAccountDoor(services).list(true);

    expect(rows).toEqual([
        { id: `one`, label: `Cursor`, connectedAt: 0 },
        { id: `two`, label: `Cursor`, connectedAt: 1 },
    ]);
});
