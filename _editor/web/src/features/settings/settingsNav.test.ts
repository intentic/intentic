import { settingsDestinations, settingsGroups, settingsPartHosts, settingsPartPath, settingsSections } from "./settingsNav";

// Which sections the settings index offers: a plan only where the platform sells one, nothing about a keyboard (or the
// wake word, which only a desktop-sized window listens for) on a phone, and nothing about a sandbox in a desktop window
// on a folder, which has none. Rows stand under three headings, and a page too small for a row of its own is drawn at
// the foot of the section it belongs with.

const slugs = (planOffered: boolean, phone?: boolean, noSandbox = false): readonly string[] =>
    settingsSections(planOffered, phone, noSandbox).map((section) => section.slug);

const parts = (planOffered: boolean, phone?: boolean, noSandbox = false): readonly string[] =>
    settingsSections(planOffered, phone, noSandbox).flatMap((section) => (section.within ?? []).map((part) => `${section.slug}#${part.slug}`));

it(`offers every section on a desktop where a plan is sold, account first, then preferences, then a developer's tools`, () => {
    expect(slugs(true)).toEqual([`profile`, `billing`, `organisation`, `appearance`, `notifications`, `keybindings`, `tokens`]);
    expect(settingsGroups(settingsSections(true, false, false)).map((group) => [group.key, group.sections.map((section) => section.slug)])).toEqual([
        [`account`, [`profile`, `billing`, `organisation`]],
        [`preferences`, [`appearance`, `notifications`]],
        [`developer`, [`keybindings`, `tokens`]],
    ]);
});

it(`draws the account's data under Profile and the wake word under Notifications`, () => {
    expect(parts(true)).toEqual([`profile#data`, `notifications#voice`]);
});

it(`leaves billing out where no plan is sold`, () => {
    expect(slugs(false)).toEqual([`profile`, `organisation`, `appearance`, `notifications`, `keybindings`, `tokens`]);
});

it(`leaves keybindings and the wake word out of a phone's index, and Notifications its own name there`, () => {
    expect(slugs(true, true)).toEqual([`profile`, `billing`, `organisation`, `appearance`, `notifications`, `tokens`]);
    expect(parts(true, true)).toEqual([`profile#data`]);
    const desktop = settingsSections(true, false, false).find((section) => section.slug === `notifications`);
    const phone = settingsSections(true, true, false).find((section) => section.slug === `notifications`);
    expect(desktop?.label).not.toBe(phone?.label);
});

it(`leaves notifications and the wake word out of a window with no sandbox to push them or hear it`, () => {
    expect(slugs(true, false, true)).toEqual([`profile`, `billing`, `organisation`, `appearance`, `keybindings`, `tokens`]);
    expect(parts(true, false, true)).toEqual([`profile#data`]);
});

it(`asks the window itself whether it has a sandbox when not told`, () => {
    expect(settingsSections(false).map((section) => section.slug)).toEqual([`profile`, `organisation`, `appearance`, `notifications`, `keybindings`, `tokens`]);
});

// A reader who does not write code is not shown the developer's tools in the index; a developer's index is unchanged.
it(`leaves the shortcut table and the tokens out of a non-coder's index, and their heading with them`, () => {
    // An organisation's console is an office administrator's, not a developer's, so it stays; so does the wake word.
    const plain = settingsSections(true, false, false, true);
    expect(plain.map((section) => section.slug)).toEqual([`profile`, `billing`, `organisation`, `appearance`, `notifications`]);
    expect(settingsGroups(plain).map((group) => group.key)).toEqual([`account`, `preferences`]);
    expect(settingsSections(true, false, false).map((section) => section.slug)).toContain(`tokens`);
});

// The rows Voice and Data were until 2026-10-17: their old addresses and their palette names still lead to them.
it(`sends a part's old address and its name to its anchor on the section it is drawn on`, () => {
    expect(settingsPartHosts()).toEqual([
        { part: `data`, host: `profile` },
        { part: `voice`, host: `notifications` },
    ]);
    expect(settingsPartPath(`data`)).toBe(`/settings#data`);
    expect(settingsPartPath(`voice`)).toBe(`/settings/notifications#voice`);
    expect(settingsDestinations(true).map((place) => place.path)).toEqual(expect.arrayContaining([`/settings#data`, `/settings/notifications#voice`]));
});
