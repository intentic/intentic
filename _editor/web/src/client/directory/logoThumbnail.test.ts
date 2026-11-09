import { LOGO_KEEP_CHARS, thumbnailOf } from "./logoThumbnail";

// Pins what a device remembers of a logo: small ones untouched, large ones made smaller, and never a worse result than
// the logo itself.

const large = `data:image/png;base64,${`A`.repeat(LOGO_KEEP_CHARS * 2)}`;

describe(`the logo a device remembers`, () => {
    it(`keeps no logo, a small logo and anything that is not an image data URL as they are`, async () => {
        const render = jest.fn(async () => `data:image/webp;base64,AA`);
        const small = `data:image/svg+xml,%3Csvg%20data-intentic-logo%3D%22x%22%3E%3C%2Fsvg%3E`;
        expect(await thumbnailOf(null, render)).toBe(null);
        expect(await thumbnailOf(small, render)).toBe(small);
        expect(await thumbnailOf(`https://example.com/${`a`.repeat(LOGO_KEEP_CHARS)}`, render)).toBe(`https://example.com/${`a`.repeat(LOGO_KEEP_CHARS)}`);
        expect(render).not.toHaveBeenCalled();
    });

    it(`remembers a large logo as its thumbnail`, async () => {
        expect(await thumbnailOf(large, async () => `data:image/webp;base64,THUMB`)).toBe(`data:image/webp;base64,THUMB`);
    });

    it(`keeps the logo when its thumbnail would not be smaller, is not an image, or cannot be drawn`, async () => {
        expect(await thumbnailOf(large, async () => `${large}AAAA`)).toBe(large);
        expect(await thumbnailOf(large, async () => `data:,`)).toBe(large);
        expect(
            await thumbnailOf(large, async () => {
                throw new Error(`no canvas`);
            }),
        ).toBe(large);
    });
});
