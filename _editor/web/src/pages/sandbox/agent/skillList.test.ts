// WHAT THE LIST LOOKED LIKE BEFORE: forty-one rows in the order the daemon happened to return them, of which
// twelve could be switched and the rest were cheatsheets that arrived with an account. Four of those rows were
// the same Product Hunt skill under four connected logins, and the two the reader had written themselves were
// somewhere in the middle of it. What is pinned here is the line the fold is drawn on and the order either side
// of it — plus the reason the filter reads more than the name.
import type { SkillSummary } from "@intentic-app/api-contract";
import { expect, it } from "vitest";
import { bySection, isTunable, matchesSkill } from "./skillList";

const skill = (over: Partial<SkillSummary> & Pick<SkillSummary, `name`>): SkillSummary => ({
    id: over.name,
    description: `Use when asked.`,
    origin: `own`,
    enabled: true,
    switchable: false,
    editable: false,
    removable: false,
    ...over,
});

it(`counts a skill as tunable exactly when this surface can do something about it`, () => {
    const own = skill({ name: `notes`, switchable: true, editable: true, removable: true });
    const builtin = skill({ name: `lsp`, origin: `builtin`, switchable: true });
    // Nobody's to switch, but absolutely the owner's to clear out — which is a thing you can do here.
    const loose = skill({ name: `scratch`, origin: `dropped`, removable: true });
    // On because the thing that ships it is on; the row names that owner instead of offering a dead switch.
    const fromConnection = skill({ name: `github`, origin: `capability`, owner: `github` });
    expect([own, builtin, loose, fromConnection].map(isTunable)).toEqual([true, true, true, false]);
});

it(`opens on what the reader wrote and ends on what their connections brought`, () => {
    const list = [
        skill({ name: `github`, origin: `capability`, owner: `github` }),
        skill({ name: `documenting`, origin: `extension`, owner: `documentation` }),
        skill({ name: `lsp`, origin: `builtin`, switchable: true }),
        skill({ name: `scratch`, origin: `dropped`, removable: true }),
        skill({ name: `notes`, switchable: true }),
        skill({ name: `review`, origin: `plugin`, owner: `pack` }),
    ].toSorted(bySection);
    expect(list.map((entry) => entry.name)).toEqual([`notes`, `scratch`, `lsp`, `documenting`, `review`, `github`]);
});

it(`sorts by name inside one origin, so four logins of one site read in order`, () => {
    const list = [`producthunt-radarsuspam2`, `producthunt-radarsuspam`, `producthunt-radarsuspam4`]
        .map((name) => skill({ name, origin: `capability`, owner: name }))
        .toSorted(bySection);
    expect(list.map((entry) => entry.name)).toEqual([`producthunt-radarsuspam`, `producthunt-radarsuspam2`, `producthunt-radarsuspam4`]);
});

it(`finds a folded row by where it came from, not only by its name`, () => {
    const row = skill({ name: `npmjs`, origin: `capability`, owner: `npmjs`, description: `Approve staged publishes.` });
    // The word on the chip, which is what somebody accounting for what their agent carries actually types.
    expect(matchesSkill(row, `connection`)).toBe(true);
    expect(matchesSkill(row, `publishes`)).toBe(true);
    expect(matchesSkill(row, `discord`)).toBe(false);
    // An empty query is not a filter — every row survives it.
    expect(matchesSkill(row, ``)).toBe(true);
});
