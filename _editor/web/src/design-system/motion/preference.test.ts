import "@intentic/testing/dom";
import { freshImport, stubGlobal } from "@intentic/testing/bun";

// Storage and the OS's answer are read once, at module scope, so each case needs its own evaluation of it: of the
// setting's own module, since a fresh copy of the module's barrel would re-export the one evaluation it already has.
const MOTION = new URL(`preference.ts`, import.meta.resolve("@intentic/ui/motion")).href;
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

describe(`resolveReducedMotion`, () => {
    it(`lets the reader's choice decide, and the OS only under system`, async () => {
        const { resolveReducedMotion } = await load();

        expect(resolveReducedMotion(`system`, false)).toBe(false);
        expect(resolveReducedMotion(`system`, true)).toBe(true);
        expect(resolveReducedMotion(`off`, false)).toBe(true);
        expect(resolveReducedMotion(`on`, true)).toBe(false);
    });
});

describe(`useMotion`, () => {
    it(`opens at system and moves when the OS has not asked for less`, async () => {
        osReduces(false);
        const { useMotion } = await load();

        expect(useMotion().motion.value).toBe(`system`);
        expect(useMotion().reduced.value).toBe(false);
        expect(root().hasAttribute(`data-motion`)).toBe(false);
    });

    it(`stills the page under system when the OS asks for less`, async () => {
        osReduces(true);
        const { useMotion } = await load();

        expect(useMotion().reduced.value).toBe(true);
        expect(root().getAttribute(`data-motion`)).toBe(`reduced`);
    });

    it(`keeps moving when the reader pinned it on, whatever the OS says`, async () => {
        osReduces(true);
        localStorage.setItem(`ui-motion`, `on`);
        const { useMotion } = await load();

        expect(useMotion().reduced.value).toBe(false);
        expect(root().hasAttribute(`data-motion`)).toBe(false);
    });

    it(`stills the page when turned off, persists it, and stores system as nothing`, async () => {
        osReduces(false);
        const { useMotion, lessMotion } = await load();
        const { setMotion } = useMotion();

        setMotion(`off`);
        expect(root().getAttribute(`data-motion`)).toBe(`reduced`);
        expect(localStorage.getItem(`ui-motion`)).toBe(`off`);
        expect(lessMotion()).toBe(true);

        setMotion(`system`);
        expect(root().hasAttribute(`data-motion`)).toBe(false);
        expect(localStorage.getItem(`ui-motion`)).toBeNull();
        expect(lessMotion()).toBe(false);
    });

    it(`ignores a stored value that is not a choice`, async () => {
        osReduces(false);
        localStorage.setItem(`ui-motion`, `slow`);
        const { useMotion } = await load();

        expect(useMotion().motion.value).toBe(`system`);
    });
});
