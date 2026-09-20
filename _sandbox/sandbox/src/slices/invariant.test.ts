import type { Slice } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import type { Member } from "../auth/auth.js";
import { memoryMembersStore, memorySlicesStore } from "../harness/route-stores.testing.js";
import { checks } from "./invariant.js";

/* The roster names slice ids and the manifest says what each holds: two tracked, hand-editable files of one fact. */

const fail = (message: string): never => {
    throw new Error(message);
};

const run = async (index: number, slices: Slice[], members: Member[]): Promise<void> => {
    const check = checks({ slices: memorySlicesStore(slices), members: memoryMembersStore(members) })[index];
    await check?.run({ moment: "sweep", fail });
};

const heldSlices = (slices: Slice[], members: Member[]): Promise<void> => run(0, slices, members);
const fencedMaintainers = (members: Member[]): Promise<void> => run(1, [], members);

test("a grant naming a slice the manifest holds reports nothing", async () => {
    await expect(
        heldSlices([{ id: "support", folders: ["support"] }], [{ email: "fay@example.com", role: "viewer", slices: ["support"] }]),
    ).resolves.toBeUndefined();
});

test("a grant naming no slice at all is the whole workspace, not an orphan", async () => {
    await expect(heldSlices([], [{ email: "fay@example.com", role: "viewer" }])).resolves.toBeUndefined();
});

// Fail-shut is the safe direction and therefore the silent one: that person's file tree simply empties, and nothing
// says why. The check is what turns it into a sentence.
test("a grant naming a slice that has been deleted is named, with whose grant it is", async () => {
    await expect(heldSlices([], [{ email: "fay@example.com", role: "viewer", slices: ["support"] }])).rejects.toThrow(
        /fay@example.com → support.*reaches no folder at all/s,
    );
});

test("an unfenced maintainer reports nothing", async () => {
    await expect(fencedMaintainers([{ email: "mai@example.com", role: "maintainer" }])).resolves.toBeUndefined();
});

// The route refuses this shape; the file can still be edited around it, and a roster claiming a fence that enforces
// nothing is worse than one that claims none.
test("a maintainer row carrying slices is named, since nothing at that tier enforces them", async () => {
    await expect(fencedMaintainers([{ email: "mai@example.com", role: "maintainer", slices: ["support"] }])).rejects.toThrow(
        /mai@example.com.*enforce nothing at that tier/s,
    );
});
