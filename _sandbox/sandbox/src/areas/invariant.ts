import { fenceHoldsPersona } from "@intentic/sandbox-contract";
import type { InvariantCheck } from "../invariants/invariants.js";
import type { MembersStore } from "../auth/auth.js";
import type { PersonasStore } from "../personas/personas-store.js";
import { type AreasStore, foldersOf } from "./areas-store.js";

// A fence is made of files that have to agree: the roster names area ids, the manifest says what each holds, and the
// persona cards say where each works. All are tracked, all are hand-editable, and a member row pointing at an area
// the manifest no longer has resolves to a fence admitting NOTHING — which is the safe direction, and therefore the
// silent one. Somebody would find out when a colleague reported an empty file tree, not when the area was deleted.
// The routes already refuse every shape below; this catches the files being edited around them.

export interface AreaRosterDeps {
    readonly areas: AreasStore;
    readonly members: MembersStore;
    readonly personas: PersonasStore;
}

export const owner = "areas";

export const checks = ({ areas, members, personas }: AreaRosterDeps): readonly InvariantCheck[] => [
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
        name: "every-desk-reaches-an-assistant",
        on: ["boot", "sweep"],
        run: async ({ fail }) => {
            // A desk reaches nothing but the cards its areas hold, so a desk whose folders no card works in signs in
            // to a chat that answers nothing. The grant route refuses this; it comes back when a card's starting
            // folder is edited, or the card deleted, long after the grant was made — which is why it is swept for.
            const [cards, manifest, roster] = await Promise.all([personas.list(), areas.list(), members.list()]);
            const stranded = roster
                .filter((member) => member.role === "desk")
                .filter((member) => !cards.some((card) => fenceHoldsPersona(foldersOf(manifest, member.areas), card)))
                .map((member) => member.email);
            if (stranded.length > 0) {
                fail(
                    `${stranded.join(", ")}: each holds a desk whose areas no assistant works in, so they can sign in and then talk to nobody; give an assistant a starting folder inside one of those areas, or move the desk onto an area that has one`,
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
