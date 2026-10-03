import { settingsSections } from "./settingsNav";

// Which sections the settings index offers: a plan only where the platform sells one, nothing about a keyboard on a
// phone, which has none, and nothing about a sandbox in a desktop window on a folder, which has none either.

const slugs = (planOffered: boolean, phone?: boolean, noSandbox = false): readonly string[] =>
    settingsSections(planOffered, phone, noSandbox).map((section) => section.slug);

it(`offers every section on a desktop where a plan is sold`, () => {
    expect(slugs(true)).toEqual([`profile`, `billing`, `appearance`, `notifications`, `keybindings`, `tokens`, `data`]);
});

it(`leaves billing out where no plan is sold`, () => {
    expect(slugs(false)).toEqual([`profile`, `appearance`, `notifications`, `keybindings`, `tokens`, `data`]);
});

it(`leaves keybindings out of a phone's index`, () => {
    expect(slugs(true, true)).toEqual([`profile`, `billing`, `appearance`, `notifications`, `tokens`, `data`]);
});

it(`leaves notifications out of a window with no sandbox to push them`, () => {
    expect(slugs(true, false, true)).toEqual([`profile`, `billing`, `appearance`, `keybindings`, `tokens`, `data`]);
});

it(`asks the window itself whether it has a sandbox when not told`, () => {
    expect(settingsSections(false).map((section) => section.slug)).toEqual([`profile`, `appearance`, `notifications`, `keybindings`, `tokens`, `data`]);
});
