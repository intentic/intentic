// WHAT THE LIST LOOKED LIKE BEFORE: forty-one rows in the order the daemon happened to return them, of which
// twelve could be switched and the rest were cheatsheets that arrived with an account. Four of those rows were
// the same Product Hunt skill under four connected logins, and the two the reader had written themselves were
// somewhere in the middle of it. What is pinned here is which skills get a card and which a name on a shelf, the
// order of both, why the filter reads more than the name, and when a trigger line earns a doubt.
import type { CapabilitySummary } from "@intentic/sandbox-contract/schemas/capabilities";
import type { SkillSummary } from "@intentic/sandbox-contract/schemas/settings";
import { bySection, isWorkspaceSkill, matchesSkill, shelvesOf, triggerDoubt } from "./skillList";

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

const connection = (id: string, kind: CapabilitySummary[`kind`]): CapabilitySummary => ({
    id,
    kind,
    status: { state: `active` },
    config: {},
    secrets: [],
});

it(`gives a card to the reader's own words, wherever they were written, and to nothing that came with something else`, () => {
    const own = skill({ name: `notes` });
    // A role card's kit is also the reader's own writing, scoped to that role's turns.
    const role = skill({ name: `triage`, origin: `role`, owner: `Support` });
    // A file dropped into the workspace by hand or by an agent: nobody else claims it.
    const loose = skill({ name: `scratch`, origin: `dropped`, removable: true });
    const builtin = skill({ name: `lsp`, origin: `builtin`, switchable: true });
    const fromConnection = skill({ name: `github`, origin: `capability`, owner: `github` });
    const fromExtension = skill({ name: `documenting`, origin: `extension`, owner: `documentation` });
    expect([own, role, loose, builtin, fromConnection, fromExtension].map(isWorkspaceSkill)).toEqual([true, true, true, false, false, false]);
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

it(`shelves a connection's skill under its tile's catalog section, extensions and plugins together, and built-ins last`, () => {
    const list = [
        skill({ name: `prod-box`, origin: `capability`, owner: `prod` }),
        skill({ name: `lsp`, origin: `builtin`, switchable: true }),
        skill({ name: `documenting`, origin: `extension`, owner: `documentation` }),
        skill({ name: `review`, origin: `plugin`, owner: `pack` }),
        // Its connection is gone or unknown to the catalog: still listed, under a plain heading after the sections.
        skill({ name: `orphan`, origin: `capability`, owner: `removed-long-ago` }),
        skill({ name: `notes` }),
    ];
    const shelves = shelvesOf(list, { capabilities: [connection(`prod`, `ssh`)], extensions: [] });
    expect(shelves.map((shelf) => [shelf.key, shelf.skills.map((entry) => entry.name)])).toEqual([
        [`servers`, [`prod-box`]],
        [`connections`, [`orphan`]],
        [`extensions`, [`documenting`, `review`]],
        [`builtin`, [`lsp`]],
    ]);
    // The reader's own skill is a card, never a shelf.
    expect(shelves.flatMap((shelf) => shelf.skills).some((entry) => entry.name === `notes`)).toBe(false);
});

it(`sorts by name inside one shelf, so four logins of one site read in order`, () => {
    const list = [`producthunt-radarsuspam2`, `producthunt-radarsuspam`, `producthunt-radarsuspam4`].map((name) =>
        skill({ name, origin: `capability`, owner: name }),
    );
    const [shelf] = shelvesOf(list, { capabilities: [], extensions: [] });
    expect(shelf?.skills.map((entry) => entry.name)).toEqual([`producthunt-radarsuspam`, `producthunt-radarsuspam2`, `producthunt-radarsuspam4`]);
});

it(`finds a shelved skill by where it came from, not only by its name`, () => {
    const row = skill({ name: `npmjs`, origin: `capability`, owner: `npmjs`, description: `Approve staged publishes.` });
    // The provenance word, which is what somebody accounting for what their agent carries actually types.
    expect(matchesSkill(row, `connection`)).toBe(true);
    expect(matchesSkill(row, `publishes`)).toBe(true);
    expect(matchesSkill(row, `discord`)).toBe(false);
    // An empty query is not a filter: every row survives it.
    expect(matchesSkill(row, ``)).toBe(true);
});

it(`doubts a trigger line that names no occasion, and never one that does or that runs long`, () => {
    expect(triggerDoubt(``)).toBe(`empty`);
    expect(triggerDoubt(`   `)).toBe(`empty`);
    // A label, not a "use when": what the agent reads every turn gives it nothing to match a task against.
    expect(triggerDoubt(`The summary scanner brief for Replay vision`)).toBe(`vague`);
    expect(triggerDoubt(`Use when the user asks for release notes.`)).toBeUndefined();
    expect(triggerDoubt(`Read BEFORE searching for CSS classes.`)).toBeUndefined();
    // Long enough to be describing its occasions in words the check doesn't know.
    expect(
        triggerDoubt(`Read binary files (docx, xlsx, pptx, pdf, odt, epub, ipynb, images, audio, archives, V8 profiles) as budgeted markdown with fileq`),
    ).toBeUndefined();
});
