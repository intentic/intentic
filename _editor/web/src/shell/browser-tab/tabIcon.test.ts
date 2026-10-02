import { iconKey, iconSvg, overlaySvg } from "./tabIcon";

describe(`the tab's icon`, () => {
    it(`writes the count in the disc while one digit holds it`, () => {
        const svg = iconSvg({ kind: `asks`, count: 3 });
        expect(svg).toContain(`fill="#e5484d"`);
        expect(svg).toMatch(/<text[^>]*>3<\/text>/);
    });

    it(`draws a bare disc past nine, where the title spells the count`, () => {
        const svg = iconSvg({ kind: `asks`, count: 12 });
        expect(svg).toContain(`fill="#e5484d"`);
        expect(svg).not.toContain(`<text`);
    });

    it(`checks off a finish and dots work under way`, () => {
        expect(iconSvg({ kind: `done` })).toContain(`fill="#2f9e64"`);
        expect(iconSvg({ kind: `working` })).toContain(`r="6.5" fill="#3d8bf2"`);
    });

    it(`greys the lotus for offline, with no disc`, () => {
        const svg = iconSvg({ kind: `offline` });
        expect(svg).toContain(`fill="#8f8a84"`);
        expect(svg).not.toContain(`<circle`);
    });

    it(`draws two counts alike once neither fits the disc`, () => {
        expect(iconKey({ kind: `asks`, count: 12 })).toBe(iconKey({ kind: `asks`, count: 40 }));
        expect(iconKey({ kind: `asks`, count: 2 })).toBe(`asks:2`);
        expect(iconKey(undefined)).toBeUndefined();
    });
});

// The mark alone, for the desktop app's taskbar button, where Windows draws it over the app's own icon.
describe(`the taskbar's overlay`, () => {
    it(`is the disc alone, with the count while one digit holds it`, () => {
        const svg = overlaySvg({ kind: `asks`, count: 4 });
        expect(svg).toContain(`<circle cx="16" cy="16" r="15" fill="#e5484d"/>`);
        expect(svg).toMatch(/<text[^>]*>4<\/text>/);
        expect(svg).not.toContain(`<path d="M16 9.5`);
        expect(overlaySvg({ kind: `asks`, count: 10 })).not.toContain(`<text`);
    });

    it(`checks off a finish, and draws work and an outage as smaller, quieter dots`, () => {
        expect(overlaySvg({ kind: `done` })).toContain(`r="15" fill="#2f9e64"`);
        expect(overlaySvg({ kind: `done` })).toContain(`stroke="#fff"`);
        expect(overlaySvg({ kind: `working` })).toContain(`r="11" fill="#3d8bf2"`);
        expect(overlaySvg({ kind: `offline` })).toContain(`r="11" fill="#8f8a84"`);
    });
});
