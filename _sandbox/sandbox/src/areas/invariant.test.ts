import type { Area, Persona } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import type { Member } from "../auth/auth.js";
import { memoryMembersStore, memoryAreasStore, memoryPersonasStore } from "../harness/route-stores.testing.js";
import { checks } from "./invariant.js";

/* The roster names area ids, the manifest says what each holds, and the cards say where each works: three tracked,
   hand-editable files of one fact. */

const fail = (message: string): never => {
    throw new Error(message);
};

const run = async (index: number, areas: Area[], members: Member[], personas: Persona[] = []): Promise<void> => {
    const check = checks({ areas: memoryAreasStore(areas), members: memoryMembersStore(members), personas: memoryPersonasStore(personas) })[index];
    await check?.run({ moment: "sweep", fail });
};

const heldAreas = (areas: Area[], members: Member[]): Promise<void> => run(0, areas, members);
const strandedGuests = (areas: Area[], members: Member[], personas: Persona[]): Promise<void> => run(1, areas, members, personas);
const fencedMaintainers = (members: Member[]): Promise<void> => run(2, [], members);

test("a grant naming an area the manifest holds reports nothing", async () => {
    await expect(
        heldAreas([{ id: "support", folders: ["support"] }], [{ email: "fay@example.com", role: "viewer", areas: ["support"] }]),
    ).resolves.toBeUndefined();
});

test("a grant naming no area at all is the whole workspace, not an orphan", async () => {
    await expect(heldAreas([], [{ email: "fay@example.com", role: "viewer" }])).resolves.toBeUndefined();
});

// Fail-shut is the safe direction and therefore the silent one: that person's file tree simply empties, and nothing
// says why. The check is what turns it into a sentence.
test("a grant naming an area that has been deleted is named, with whose grant it is", async () => {
    await expect(heldAreas([], [{ email: "fay@example.com", role: "viewer", areas: ["support"] }])).rejects.toThrow(
        /fay@example.com → support.*reaches no folder at all/s,
    );
});

// A guest reaches its assistants and nothing else. The grant route refuses a fence holding none; this catches the
// card's starting folder being edited, or the card deleted, long after the grant was made.
test("a guest whose areas hold an assistant reports nothing", async () => {
    await expect(
        strandedGuests(
            [{ id: "support", folders: ["support"] }],
            [{ email: "dee@example.com", role: "guest", areas: ["support"] }],
            [{ id: "helper", capabilities: [], workspace: { startIn: "support" } }],
        ),
    ).resolves.toBeUndefined();
});

test("a guest whose areas hold no assistant is named, since it can sign in and then talk to nobody", async () => {
    await expect(
        strandedGuests(
            [{ id: "support", folders: ["support"] }],
            [{ email: "dee@example.com", role: "guest", areas: ["support"] }],
            // Homed at the root, which no fence covers: the card exists and this guest still reaches none.
            [{ id: "helper", capabilities: [] }],
        ),
    ).rejects.toThrow(/dee@example.com.*no assistant works in/s);
});

test("an unfenced maintainer reports nothing", async () => {
    await expect(fencedMaintainers([{ email: "mai@example.com", role: "maintainer" }])).resolves.toBeUndefined();
});

// The route refuses this shape; the file can still be edited around it, and a roster claiming a fence that enforces
// nothing is worse than one that claims none.
test("a maintainer row carrying areas is named, since nothing at that tier enforces them", async () => {
    await expect(fencedMaintainers([{ email: "mai@example.com", role: "maintainer", areas: ["support"] }])).rejects.toThrow(
        /mai@example.com.*enforce nothing at that tier/s,
    );
});
