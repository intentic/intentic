import { settingsSections } from "./settingsNav";

// Which sections the settings index offers: a plan only where the platform sells one, nothing about a keyboard (or the
// wake word, which only a desktop-sized window listens for) on a phone, and nothing about a sandbox in a desktop window
// on a folder, which has none.

const slugs = (planOffered: boolean, phone?: boolean, noSandbox = false): readonly string[] =>
    settingsSections(planOffered, phone, noSandbox).map((section) => section.slug);

it(`offers every section on a desktop where a plan is sold`, () => {
    expect(slugs(true)).toEqual([`profile`, `billing`, `appearance`, `notifications`, `voice`, `keybindings`, `tokens`, `organisation`, `data`]);
});

it(`leaves billing out where no plan is sold`, () => {
    expect(slugs(false)).toEqual([`profile`, `appearance`, `notifications`, `voice`, `keybindings`, `tokens`, `organisation`, `data`]);
});

it(`leaves keybindings and the wake word out of a phone's index`, () => {
    expect(slugs(true, true)).toEqual([`profile`, `billing`, `appearance`, `notifications`, `tokens`, `organisation`, `data`]);
});

it(`leaves notifications and the wake word out of a window with no sandbox to push them or hear it`, () => {
    expect(slugs(true, false, true)).toEqual([`profile`, `billing`, `appearance`, `keybindings`, `tokens`, `organisation`, `data`]);
});

it(`asks the window itself whether it has a sandbox when not told`, () => {
    expect(settingsSections(false).map((section) => section.slug)).toEqual([`profile`, `appearance`, `notifications`, `voice`, `keybindings`, `tokens`, `organisation`, `data`]);
});

// A reader who does not write code is not shown the developer's tools in the index; a developer's index is unchanged.
it(`leaves the shortcut table and the tokens out of a non-coder's index, and only theirs`, () => {
    // An organisation's console is an office administrator's, not a developer's, so it stays; so does the wake word.
    expect(settingsSections(true, false, false, true).map((section) => section.slug)).toEqual([
        `profile`,
        `billing`,
        `appearance`,
        `notifications`,
        `voice`,
        `organisation`,
        `data`,
    ]);
    expect(settingsSections(true, false, false).map((section) => section.slug)).toContain(`tokens`);
});
