import "@intentic/testing/dom";
import { stubGlobal, unstubAllGlobals } from "@intentic/testing/bun";
import { type App, createApp, h, nextTick } from "vue";
import ThinkingRosette from "./ThinkingRosette.vue";

let app: App | undefined;

const mount = async (): Promise<HTMLElement> => {
    const host = document.createElement(`div`);
    document.body.append(host);
    app = createApp({ render: () => h(ThinkingRosette) });
    app.mount(host);
    await nextTick();
    return host;
};

afterEach(() => {
    app?.unmount();
    app = undefined;
    jest.restoreAllMocks();
    unstubAllGlobals();
    document.body.innerHTML = ``;
});

// The rosette replaces a glyph on a text line, so it has to occupy exactly the footprint the icon pack does: a
// different box or intrinsic size would shift the status word every time a turn starts.
it(`keeps the icon pack's box and intrinsic size`, async () => {
    const svg = (await mount()).querySelector(`svg`)!;

    expect({ box: svg.getAttribute(`viewBox`), width: svg.getAttribute(`width`), height: svg.getAttribute(`height`) }).toEqual({
        box: `0 0 24 24`,
        width: `1em`,
        height: `1em`,
    });
    // The status word beside it already says the turn is live; a second announcement is noise.
    expect(svg.getAttribute(`aria-hidden`)).toBe(`true`);
});

// What makes it a wave rather than eight petals blinking at once: one shared petal drawing, eight rotations, and a
// distinct negative start offset per petal. Collapse any of the three and the motion stops reading as travel.
it(`lights eight identical petals on staggered offsets`, async () => {
    const host = await mount();
    const petals = [...host.querySelectorAll(`g[transform^="rotate"]`)];

    expect(petals.map((petal) => petal.getAttribute(`transform`))).toEqual([
        `rotate(0)`,
        `rotate(45)`,
        `rotate(90)`,
        `rotate(135)`,
        `rotate(180)`,
        `rotate(225)`,
        `rotate(270)`,
        `rotate(315)`,
    ]);
    expect(new Set(petals.map((petal) => petal.querySelector(`path`)?.getAttribute(`d`))).size).toBe(1);
    expect(petals.map((petal) => petal.querySelector(`animate`)?.getAttribute(`begin`))).toEqual([
        `0s`,
        `-0.075s`,
        `-0.15s`,
        `-0.225s`,
        `-0.3s`,
        `-0.375s`,
        `-0.45s`,
        `-0.525s`,
    ]);
});

// SMIL, never a CSS animation: reducedMotion.test.ts bans those app-wide because DevTools rebuilds an open Styles
// editor whenever one starts or stops, and a turn's status line starts one on every turn.
it(`animates inside the SVG rather than with a CSS animation`, async () => {
    const host = await mount();

    expect(host.querySelectorAll(`animate`).length).toBeGreaterThan(0);
    expect(host.querySelector(`animateTransform, animatetransform`)).not.toBeNull();
    expect(host.querySelector(`[class*="animate-"]`)).toBeNull();
});

// Slowed, not stopped. A still mark beside "Musing…" reads as a hung turn, which is the one thing this must never say.
it(`stretches the breath for reduced motion instead of holding still`, async () => {
    const query = window.matchMedia(`(prefers-reduced-motion: reduce)`);
    const remove = jest.spyOn(query, `removeEventListener`);
    Object.defineProperty(query, `matches`, { value: true });
    // stubGlobal, not spyOn: the jsdom install defines every window member as an accessor, which spyOn refuses.
    stubGlobal(`matchMedia`, () => query);

    const host = await mount();

    expect(new Set([...host.querySelectorAll(`animate, animateTransform`)].map((node) => node.getAttribute(`dur`)))).toEqual(new Set([`6.5s`]));
    app!.unmount();
    app = undefined;
    expect(remove).toHaveBeenCalledWith(`change`, expect.any(Function));
});
