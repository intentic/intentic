import type { InvariantCheck } from "../invariants/invariants.js";
import type { MembersStore } from "../auth/auth.js";
import type { AreasStore } from "./areas-store.js";

// A fence is made of two files that have to agree: the roster names area ids, the manifest says what each holds.
// Both are tracked, both are hand-editable, and a member row pointing at an area the manifest no longer has resolves
// to a fence admitting NOTHING — which is the safe direction, and therefore the silent one. Somebody would find out
// when a colleague reported an empty file tree, not when the area was deleted.
// The routes already refuse both shapes below; this catches the file being edited around them.

export interface AreaRosterDeps {
    readonly areas: AreasStore;
    readonly members: MembersStore;
}

export const owner = "areas";

export const checks = ({ areas, members }: AreaRosterDeps): readonly InvariantCheck[] => [
    {
        name: "every-held-area-exists",
        // Boot and sweep: both files are edited out of band (by hand, by an agent, by a restore), never through a
        // turn, so `turn-settled` would be the one moment that could not have changed them.
        on: ["boot", "sweep"],
        run: async ({ fail }) => {
            const known = new Set((await areas.list()).map((area) => area.id));
            const orphans = (await members.list()).flatMap((member) =>
                (member.areas ?? []).filter((area) => !known.has(area)).map((area) => `${member.email} → ${area}`),
            );
            if (orphans.length > 0) {
                fail(
                    `${orphans.join(", ")}: these grants name an area this workspace no longer has, so each of those people reaches no folder at all while the Access tab still shows them as having access`,
                );
            }
        },
    },
    {
        name: "no-maintainer-is-fenced",
        on: ["boot", "sweep"],
        run: async ({ fail }) => {
            // The tier holds the owner's operating authority and reads every credential, so a folder fence over it
            // would be a line on a screen rather than a boundary — and a roster that carries one is telling whoever
            // reads it something untrue about what that person can see.
            const fenced = (await members.list()).filter((member) => member.role === "maintainer" && member.areas !== undefined);
            if (fenced.length > 0) {
                fail(
                    `${fenced.map((member) => member.email).join(", ")}: a maintainer row carries areas, which enforce nothing at that tier; the roster is claiming a fence that is not there`,
                );
            }
        },
    },
];
