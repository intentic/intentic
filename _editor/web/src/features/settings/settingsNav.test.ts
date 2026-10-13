import { settingsSections } from "./settingsNav";

// Which sections the settings index offers: a plan only where the platform sells one, nothing about a keyboard (or the
// wake word, which only a desktop-sized window listens for) on a phone, and nothing about a sandbox in a desktop window
// on a folder, which has none.

const slugs = (planOffered: boolean, phone?: boolean, noSandbox = false): readonly string[] =>
    settingsSections(planOffered, phone, noSandbox).map((section) => section.slug);

it(`offers every section on a desktop where a plan is sold`, () => {
    expect(slugs(true)).toEqual([`profile`, `billing`, `appearance`, `notifications`, `voice`, `keybindings`, `tokens`, `data`]);
});

it(`leaves billing out where no plan is sold`, () => {
    expect(slugs(false)).toEqual([`profile`, `appearance`, `notifications`, `voice`, `keybindings`, `tokens`, `data`]);
});

it(`leaves keybindings and the wake word out of a phone's index`, () => {
    expect(slugs(true, true)).toEqual([`profile`, `billing`, `appearance`, `notifications`, `tokens`, `data`]);
});

it(`leaves notifications and the wake word out of a window with no sandbox to push them or hear it`, () => {
    expect(slugs(true, false, true)).toEqual([`profile`, `billing`, `appearance`, `keybindings`, `tokens`, `data`]);
});

it(`asks the window itself whether it has a sandbox when not told`, () => {
    expect(settingsSections(false).map((section) => section.slug)).toEqual([`profile`, `appearance`, `notifications`, `voice`, `keybindings`, `tokens`, `data`]);
});
