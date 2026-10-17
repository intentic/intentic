import { sandboxEmbedOf, sandboxKeyAllowed, sandboxSectionGroups, sandboxSections } from "./sandboxNav";

// How the Sandbox hub's index is filed. The reach group leads with the three pages that each set one part of who gets in
// and what the box reaches, and closes on the map, the read-only drawing of all of it. What this box does with what passes through it (the officer's page, what may
// leave, what the agent may do unasked, how long things are kept) is one group of its own, and the records of what
// happened, split by who did it, are the last; the one extension view a section draws inside itself is kept for that
// extension, since a stranger's view under the same name would read as the sandbox's own record.

const filing = (): readonly [string, readonly string[]][] => sandboxSectionGroups().map((group) => [group.key, group.items.map((row) => row.slug)]);

it(`files privacy and safety as one group, and the records after everything they read`, () => {
    expect(filing()).toEqual([
        [`box`, [`overview`, `usage`]],
        [`configuration`, [`models`, `agent`, `environment`, `secrets`, `extensions`]],
        [`reach`, [`access`, `areas`, `personas`, `map`]],
        [`privacy`, [`data-protection`, `privacy-shield`, `guardrails`, `retention`]],
        [`records`, [`activity`, `audit`]],
    ]);
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

it(`leaves out what an organisation hides`, () => {
    const slugs = sandboxSections(true, false, new Set([`guardrails`, `retention`])).map((section) => section.slug);
    expect(slugs).not.toContain(`guardrails`);
    expect(slugs).not.toContain(`retention`);
    expect(slugs).toContain(`privacy-shield`);
});
