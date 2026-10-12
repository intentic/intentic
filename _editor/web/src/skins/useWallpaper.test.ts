// Pins that mist is worn until somebody picks otherwise, and that picking one sets and clears data-wallpaper.
// jsdom: the composable writes directly to the document, and reads its storage once as it loads, so each case gets
// its own evaluation.
import "@intentic/testing/dom";
import { freshImport } from "@intentic/testing/bun";

const load = () => freshImport<typeof import("./useWallpaper")>("./useWallpaper", import.meta.url);
const root = () => document.documentElement;

beforeEach(() => {
    localStorage.clear();
    root().removeAttribute(`data-wallpaper`);
});

describe(`useWallpaper`, () => {
    it(`wears mist when nobody has chosen one`, async () => {
        const { useWallpaper } = await load();

        expect(useWallpaper().wallpaper.value).toBe(`mist`);
        expect(root().getAttribute(`data-wallpaper`)).toBe(`mist`);
    });

    it(`puts the chosen wallpaper on <html>, and takes it off again for none`, async () => {
        const { useWallpaper } = await load();
        const { wallpaper } = useWallpaper();

        wallpaper.value = `none`;
        expect(root().hasAttribute(`data-wallpaper`)).toBe(false);
        expect(localStorage.getItem(`ui-wallpaper`)).toBe(`none`);

        wallpaper.value = `mist`;
        expect(root().getAttribute(`data-wallpaper`)).toBe(`mist`);
        expect(localStorage.getItem(`ui-wallpaper`)).toBe(`mist`);
    });

    it(`wears what storage holds from the first frame`, async () => {
        localStorage.setItem(`ui-wallpaper`, `mist`);
        await load();

        expect(root().getAttribute(`data-wallpaper`)).toBe(`mist`);
    });

    // A value a later release retired, or one hand-edited into storage, falls back to the default wallpaper.
    it(`reads an unknown stored value as mist`, async () => {
        localStorage.setItem(`ui-wallpaper`, `aurora`);
        const { useWallpaper } = await load();

        expect(useWallpaper().wallpaper.value).toBe(`mist`);
        expect(root().getAttribute(`data-wallpaper`)).toBe(`mist`);
    });
});
