import { isSandboxSlot, sandboxKeyAllowed, sandboxSectionGroups, sandboxSections } from "./sandboxNav";

// How the Sandbox hub's index is filed. The records of what happened (Activity, the audit trail) and what a data
// protection officer files from them sit in one group, below everything they read, and the one row an extension fills
// there is kept for that extension: a stranger's view under the same name would read as the sandbox's own record.

const filing = (): readonly [string, readonly string[]][] => sandboxSectionGroups().map((group) => [group.key, group.items.map((row) => row.slug)]);

it(`files the records and the officer's page together, after the groups they read`, () => {
    expect(filing()).toEqual([
        [`box`, [`overview`, `usage`]],
        [`configuration`, [`models`, `agent`, `environment`, `secrets`, `extensions`]],
        [`reach`, [`access`, `areas`, `personas`]],
        [`oversight`, [`activity`, `audit`, `data-protection`]],
    ]);
});

it(`keeps Activity's row for the Activity extension, which fills it with its own words`, () => {
    const oversight = sandboxSectionGroups().find((group) => group.key === `oversight`);
    const activity = oversight?.items.find((row) => row.slug === `activity`);
    expect(activity !== undefined && isSandboxSlot(activity) ? activity.extension : undefined).toBe(`intentic.activity`);
});

it(`gives a slot's name to its own extension only`, () => {
    expect(sandboxKeyAllowed(`intentic.activity`, `activity`)).toBe(true);
    expect(sandboxKeyAllowed(`someone.activity`, `activity`)).toBe(false);
});

it(`gives no extension a built-in section's name`, () => {
    expect(sandboxKeyAllowed(`intentic.activity`, `audit`)).toBe(false);
    expect(sandboxKeyAllowed(`someone.logs`, `secrets`)).toBe(false);
});

it(`leaves every other name to whichever extension asks`, () => {
    expect(sandboxKeyAllowed(`someone.logs`, `logs`)).toBe(true);
});

it(`lists the built-in sections a reader can open, never a slot`, () => {
    expect(sandboxSections(true).map((section) => section.slug)).not.toContain(`activity`);
    expect(sandboxSections(false).map((section) => section.slug)).toEqual([`overview`, `environment`, `extensions`, `access`]);
    expect(sandboxSections(false, true).map((section) => section.slug)).toEqual([`access`]);
});
