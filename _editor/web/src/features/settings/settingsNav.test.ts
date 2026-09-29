import { settingsSections } from "./settingsNav";

// Which sections the settings index offers: a plan only where the platform sells one, and nothing about a keyboard on
// a phone, which has none.

const slugs = (planOffered: boolean, phone?: boolean): readonly string[] => settingsSections(planOffered, phone).map((section) => section.slug);

it(`offers every section on a desktop where a plan is sold`, () => {
    expect(slugs(true)).toEqual([`profile`, `billing`, `appearance`, `notifications`, `keybindings`, `tokens`, `data`]);
});

it(`leaves billing out where no plan is sold`, () => {
    expect(slugs(false)).toEqual([`profile`, `appearance`, `notifications`, `keybindings`, `tokens`, `data`]);
});

it(`leaves keybindings out of a phone's index`, () => {
    expect(slugs(true, true)).toEqual([`profile`, `billing`, `appearance`, `notifications`, `tokens`, `data`]);
});
