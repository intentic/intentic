import { isTabbedRow, sandboxEmbedOf, sandboxKeyAllowed, sandboxSectionGroups, sandboxSections } from "./sandboxNav";

// How the Sandbox hub's index is filed. The reach group leads with the three pages that each set one part of who gets in
// and what the box reaches, and closes on the map, the read-only drawing of all of it. What this box does with what
// passes through it and what happened in it are pages few readers open, so they are the last group and two rows: one
// that sets (the officer's page, what may leave, what the agent may do unasked, how long things are kept) with its pages
// as tabs, and one that reads, Activity, whose parts end on the audit trail. The one extension view a section draws
// inside itself is kept for that extension, since a stranger's view under the same name would read as the sandbox's own
// record.

const filing = (): readonly [string, readonly string[]][] =>
    sandboxSectionGroups().map((group) => [group.key, group.items.map((row) => (isTabbedRow(row) ? row.key : row.slug))]);

it(`files what is set about data and what happened as two rows, after everything else`, () => {
    expect(filing()).toEqual([
        [`box`, [`overview`, `usage`]],
        [`configuration`, [`models`, `agent`, `environment`, `secrets`, `extensions`]],
        [`reach`, [`access`, `personas`, `map`]],
        [`oversight`, [`privacy`, `activity`]],
    ]);
});

it(`draws the privacy and safety pages as one row's tabs, in the order they are read`, () => {
    const row = sandboxSectionGroups()
        .flatMap((group) => group.items)
        .find((item) => isTabbedRow(item) && item.key === `privacy`);
    expect(row !== undefined && isTabbedRow(row) ? row.parts.map((part) => part.slug) : []).toEqual([
        `data-protection`,
        `privacy-shield`,
        `guardrails`,
        `retention`,
    ]);
});

it(`keeps every page a destination by name, the tabs and Activity's audit trail among them`, () => {
    const slugs = sandboxSections(true).map((section) => section.slug);
    expect(slugs).toEqual(expect.arrayContaining([`data-protection`, `privacy-shield`, `guardrails`, `retention`, `activity`, `audit`]));
    expect(slugs).not.toContain(`privacy`);
});

it(`draws the Activity extension's view inside Activity, and no other extension's`, () => {
    expect(sandboxEmbedOf(`activity`)).toBe(`intentic.activity`);
    expect(sandboxEmbedOf(`audit`)).toBeUndefined();
});

it(`gives no extension a built-in section's name as a row of its own`, () => {
    expect(sandboxKeyAllowed(`activity`)).toBe(false);
    expect(sandboxKeyAllowed(`audit`)).toBe(false);
    expect(sandboxKeyAllowed(`guardrails`)).toBe(false);
    expect(sandboxKeyAllowed(`secrets`)).toBe(false);
});

it(`leaves every other name to whichever extension asks`, () => {
    expect(sandboxKeyAllowed(`logs`)).toBe(true);
});

it(`lists the built-in sections a reader can open`, () => {
    expect(sandboxSections(true).map((section) => section.slug)).toContain(`activity`);
    // Below maintainer: Activity is their own turns; every privacy and safety page is refused by the daemon.
    expect(sandboxSections(false).map((section) => section.slug)).toEqual([`overview`, `environment`, `extensions`, `access`, `activity`]);
    expect(sandboxSections(false, true).map((section) => section.slug)).toEqual([`access`]);
});

// A part of the sandbox given to someone below maintainer opens its section for them, and only that one.
it(`opens a section to a reader given the part it runs`, () => {
    const given = (...rights: string[]) => (right: string) => rights.includes(right);
    const slugs = (holds: (right: string) => boolean) => sandboxSections(false, false, new Set(), holds).map((section) => section.slug);
    expect(slugs(given(`secrets`))).toContain(`secrets`);
    expect(slugs(given(`secrets`))).not.toContain(`privacy-shield`);
    expect(slugs(given(`privacy`, `ownAccounts`))).toEqual(expect.arrayContaining([`privacy-shield`, `models`]));
    expect(slugs(given(`privacy`))).not.toContain(`data-protection`);
    // People & access is drawn inside Access, which every member opens already.
    expect(slugs(given(`people`))).toEqual(slugs(given()));
});

it(`leaves out what an organisation hides`, () => {
    const slugs = sandboxSections(true, false, new Set([`guardrails`, `retention`])).map((section) => section.slug);
    expect(slugs).not.toContain(`guardrails`);
    expect(slugs).not.toContain(`retention`);
    expect(slugs).toContain(`privacy-shield`);
});
