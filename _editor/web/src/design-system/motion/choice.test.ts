import "@intentic/testing/dom";
import { freshImport, stubGlobal } from "@intentic/testing/bun";

// Storage and the OS's answer are read once, at module scope, so each case needs its own evaluation of it: of the
// setting's own module, since a fresh copy of the module's barrel would re-export the one evaluation it already has.
const MOTION = new URL(`choice.ts`, import.meta.resolve("@intentic/ui/motion")).href;
const load = () => freshImport<typeof import("@intentic/ui/motion")>(MOTION, import.meta.url);
const root = () => document.documentElement;

// The OS asking for less motion, or not, for the module evaluated after it.
const osReduces = (reduces: boolean): void => {
    const real = window.matchMedia.bind(window);
    stubGlobal(`matchMedia`, (query: string) =>
        // SAFETY: the module reads only `matches` and subscribes with `addEventListener`; both are on this stand-in.
        query.includes(`reduced-motion`) ? ({ ...real(query), matches: reduces, media: query, addEventListener: () => {} } as MediaQueryList) : real(query),
    );
};

beforeEach(() => {
    localStorage.clear();
    root().removeAttribute(`data-motion`);
});

describe(`useMotion`, () => {
    it(`moves when the OS has not asked for less`, async () => {
        osReduces(false);
        const { useMotion, lessMotion } = await load();

        expect(useMotion().reduced.value).toBe(false);
        expect(root().hasAttribute(`data-motion`)).toBe(false);
        expect(lessMotion()).toBe(false);
    });

    it(`stills the page when the OS asks for less`, async () => {
        osReduces(true);
        const { useMotion, lessMotion } = await load();

        expect(useMotion().reduced.value).toBe(true);
        expect(root().getAttribute(`data-motion`)).toBe(`reduced`);
        expect(lessMotion()).toBe(true);
    });

    // The Animations setting is gone: an Off a reader stored before it went must not still the page with no way back.
    it(`ignores a choice stored by the setting that used to sit over the OS`, async () => {
        osReduces(false);
        localStorage.setItem(`ui-motion`, `off`);
        const { useMotion } = await load();

        expect(useMotion().reduced.value).toBe(false);
        expect(root().hasAttribute(`data-motion`)).toBe(false);
    });
});
