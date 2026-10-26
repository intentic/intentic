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

describe(`the tab's icon over the sandbox's logo`, () => {
    const LOGO = `data:image/webp;base64,AAAA`;

    it(`draws the logo in the lotus's place, alone when there is no mark`, () => {
        const svg = iconSvg(undefined, LOGO);
        expect(svg).toContain(`<image href="${LOGO}"`);
        expect(svg).not.toContain(`<path d="M16 9.5`);
        expect(svg).not.toContain(`<circle`);
    });

    it(`keeps the mark's disc, cutting only the ring out of the logo`, () => {
        const svg = iconSvg({ kind: `asks`, count: 2 }, LOGO);
        expect(svg).toContain(`<image href="${LOGO}"`);
        expect(svg).toContain(`fill="#e5484d"`);
        expect(svg).toMatch(/<text[^>]*>2<\/text>/);
        expect(svg).not.toMatch(/<mask[^]*<rect x=/);
        expect(iconSvg({ kind: `working` }, LOGO)).toContain(`r="6.5" fill="#3d8bf2"`);
    });

    it(`greys the logo for offline`, () => {
        const svg = iconSvg({ kind: `offline` }, LOGO);
        expect(svg).toContain(`feColorMatrix type="saturate" values="0"`);
        expect(svg).toContain(`filter="url(#grey)"`);
    });

    it(`keeps the lotus for a logo that is not an inline picture, and escapes one that is`, () => {
        expect(iconSvg(undefined, `https://example.com/logo.png`)).toContain(`<path d="M16 9.5`);
        expect(iconSvg(undefined, `data:image/svg+xml,<svg a="b"/>`)).toContain(`href="data:image/svg+xml,&lt;svg a=&quot;b&quot;/>"`);
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
