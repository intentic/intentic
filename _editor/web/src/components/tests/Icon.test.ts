import "@intentic/testing/dom";
import { stubGlobal, unstubAllGlobals } from "@intentic/testing/bun";
import { type App, createApp, h, nextTick, ref } from "vue";
import Icon from "@intentic/ui/icon";
import { setDeveloperBuild } from "@intentic/ui/motion";
import ViewBadgeChip from "../../core-views/ViewBadgeChip.vue";
import { glyphBody } from "../../../../ui/src/icons/glyph.js";
import { sectionIcon, ICONS, isIconName, type IconName } from "../../../../ui/src/icons/iconSets.js";

let app: App | undefined;

it.each([`exclamation-circle`, `exclamation-triangle`, `exclamation`] as const)(
    `renders %s as the same circular attention in icons, badges and diagrams`,
    async (name) => {
        const host = document.createElement(`div`);
        document.body.append(host);
        app = createApp({
            render: () => h(`div`, [h(Icon, { name }), h(ViewBadgeChip, { badge: { mark: name, tone: `warning` } })]),
        });
        app.mount(host);
        await nextTick();
        const paths = [...host.querySelectorAll(`svg path`)];
        expect(paths.map((path) => path.getAttribute(`d`))).toEqual([ICONS[`exclamation-circle`].solid, ICONS[`exclamation-circle`].solid]);
        expect(glyphBody(ICONS[name])).toBe(glyphBody(ICONS[`exclamation-circle`]));
        const badge = host.querySelector(`.ui-badge`)!;
        expect(badge.classList.contains(`text-warning`)).toBe(true);
        expect([...badge.classList].filter((cls) => cls.startsWith(`bg-`))).toEqual([`bg-[color:var(--ui-tile-ground)]`]);
        expect(badge.querySelector(`svg`)!.classList.contains(`text-[1.8em]`)).toBe(true);
    },
);
// Props are cast through `as never` since the accessibility tests below pass raw fallthrough attrs (`aria-label`,
// `title`) that the component doesn't declare, that lack of a typed prop is exactly the mechanism under test.
// `name`/`spin` are the real, typed props.
const mount = async (props: { name: IconName; spin?: boolean } & Record<string, unknown>): Promise<HTMLElement> => {
    const host = document.createElement(`div`);
    document.body.append(host);
    app = createApp({ render: () => h(Icon, props as never) });
    app.mount(host);
    await nextTick();
    return host;
};
const spinner = async (spin: boolean): Promise<HTMLElement> => mount({ name: `spinner`, spin });

afterEach(() => {
    app?.unmount();
    app = undefined;
    jest.restoreAllMocks();
    unstubAllGlobals();
    document.body.innerHTML = ``;
});

it(`animates a running icon inside the SVG without a CSS animation class`, async () => {
    const host = await spinner(true);

    expect(host.querySelector(`svg`)).not.toBeNull();
    expect(host.querySelector(`animateTransform, animatetransform`)).not.toBeNull();
    expect(host.querySelector(`.animate-spin`)).toBeNull();
});

// The spinner is drawn for motion, not for silhouette: a still ring behind the arc, so the shape the eye holds onto
// rasterises once instead of being rebuilt from different sub-pixels on every frame. That only works while the track
// stays OUT of the group the animation turns, which is what this pins.
it(`turns the spinner's arc over a track that holds still`, async () => {
    const host = await spinner(true);
    const turning = host.querySelector(`animateTransform`)!.parentElement!;

    expect(turning.querySelector(`path`)?.getAttribute(`d`)).toBe(ICONS.spinner.outline);
    expect(turning.querySelector(`circle`)).toBeNull();
    expect(host.querySelector(`svg > circle`)).not.toBeNull();
    // Round ends and a stroke heavier than the pack's 2: at rail size a square-ended hairline is caps and grey.
    expect({ cap: turning.getAttribute(`stroke-linecap`), width: turning.getAttribute(`stroke-width`) }).toEqual({
        cap: `round`,
        width: `2.5`,
    });
});

it(`leaves an ordinary icon still`, async () => {
    const host = await spinner(false);

    expect(host.querySelector(`svg`)).not.toBeNull();
    expect(host.querySelector(`animateTransform, animatetransform`)).toBeNull();
});

it(`slows the spinner for reduced motion and removes its preference listener on unmount`, async () => {
    const query = window.matchMedia(`(prefers-reduced-motion: reduce)`);
    const remove = jest.spyOn(query, `removeEventListener`);
    Object.defineProperty(query, `matches`, { value: true });
    const desktop = window.matchMedia(`(hover: none) and (pointer: coarse)`);
    // Stubbed rather than spied on: the DOM shim carries `matchMedia` as an accessor, and a spy cannot stand in for one.
    // Only the reduced-motion question answers yes; the screen stays a desktop pointer, where the spinner is SMIL.
    stubGlobal(`matchMedia`, (asked: string) => (asked.includes(`reduced-motion`) ? query : desktop));
    const host = await spinner(true);
    expect(host.querySelector(`animateTransform`)?.getAttribute(`dur`)).toBe(`3s`);
    app!.unmount();
    app = undefined;
    expect(remove).toHaveBeenCalledWith(`change`, expect.any(Function));
});

// A still icon never asks: a thousand icons on a board would otherwise hold a thousand preference listeners.
it(`asks the reduced-motion question only while it spins`, async () => {
    const asked: string[] = [];
    const real = window.matchMedia.bind(window);
    stubGlobal(`matchMedia`, (query: string) => {
        asked.push(query);
        return real(query);
    });
    await spinner(false);

    expect(asked.filter((query) => query.includes(`reduced-motion`))).toEqual([]);
});

// ON A TOUCH SCREEN the spinner turns on the compositor: a CSS animation on the whole glyph, and no SMIL, which would
// re-style and re-paint the page on the main thread every frame it is on screen.
it(`turns the whole glyph on the compositor on a touch screen`, async () => {
    const touch = window.matchMedia(`(hover: none) and (pointer: coarse)`);
    Object.defineProperty(touch, `matches`, { value: true });
    const real = window.matchMedia.bind(window);
    stubGlobal(`matchMedia`, (query: string) => (query.includes(`pointer: coarse`) ? touch : real(query)));
    const host = await spinner(true);

    expect(host.querySelector(`animateTransform, animatetransform`)).toBeNull();
    expect(host.querySelector(`svg`)?.classList.contains(`ui-icon-turning`)).toBe(true);
});

// OUTSIDE A DEVELOPER'S BUILD a desktop pointer turns it on the compositor too: SMIL is kept only where a DevTools Styles
// editor is open to be rebuilt (useCompositedLoops).
it(`turns the whole glyph on the compositor under a desktop pointer outside a developer's build`, async () => {
    setDeveloperBuild(false);
    try {
        const host = await spinner(true);

        expect(host.querySelector(`animateTransform, animatetransform`)).toBeNull();
        expect(host.querySelector(`svg`)?.classList.contains(`ui-icon-turning`)).toBe(true);
    } finally {
        setDeveloperBuild(true);
    }
});

it(`keeps a still icon still on a touch screen`, async () => {
    const touch = window.matchMedia(`(hover: none) and (pointer: coarse)`);
    Object.defineProperty(touch, `matches`, { value: true });
    const real = window.matchMedia.bind(window);
    stubGlobal(`matchMedia`, (query: string) => (query.includes(`pointer: coarse`) ? touch : real(query)));
    const host = await spinner(false);

    expect(host.querySelector(`svg`)?.classList.contains(`ui-icon-turning`)).toBe(false);
});

// Assert the actual accessible SVG, including attribute changes after mount.

const svgOf = async (props: { name: IconName } & Record<string, unknown>): Promise<SVGElement> => {
    const svg = (await mount(props)).querySelector(`svg`);
    expect(svg).not.toBeNull();
    return svg!;
};

// Decoration stays silent, right for most icons in the app: they sit beside text that already says the same
// thing.
it(`keeps an unlabelled glyph out of the accessibility tree`, async () => {
    expect((await svgOf({ name: `check` })).getAttribute(`aria-hidden`)).toBe(`true`);
});

it(`announces a glyph that was given a label`, async () => {
    const svg = await svgOf({ name: `exclamation-circle`, "aria-label": `Needs you` });

    expect({
        hidden: svg.getAttribute(`aria-hidden`),
        role: svg.getAttribute(`role`),
        label: svg.getAttribute(`aria-label`),
    }).toEqual({ hidden: null, role: `img`, label: `Needs you` });
});

// A `title` counts as a name too; the rule is about having a name, not which attribute carries it.
it(`announces a glyph named by its title`, async () => {
    expect((await svgOf({ name: `clock`, title: `Waiting` })).getAttribute(`aria-hidden`)).toBeNull();
});

it(`renders the whole vocabulary without a plugin, with one geometry and stroke weight`, async () => {
    const names = Object.keys(ICONS) as IconName[];
    const host = document.createElement(`div`);
    document.body.append(host);
    app = createApp({
        render: () =>
            h(
                `div`,
                names.map((name) => h(Icon, { name, "data-icon-name": name })),
            ),
    });
    app.mount(host);
    await nextTick();

    const rendered = [...host.querySelectorAll(`svg`)];
    expect(rendered.map((svg) => svg.getAttribute(`data-icon-name`))).toEqual(names);
    for (const svg of rendered) {
        expect(svg.getAttribute(`viewBox`)).toBe(`0 0 24 24`);
        expect(svg.querySelectorAll(`path`).length).toBeGreaterThan(0);
        expect(svg.getAttribute(`stroke-width`)).toBe(`2`);
        // A still glyph is the svg and its paths: the pack's ink is inherited from the svg, with no group of its own.
        // The spinner keeps one, for the arc it turns over its track.
        expect(svg.querySelector(`g`) === null).toBe(svg.getAttribute(`data-icon-name`) !== `spinner`);
        expect(svg.getAttribute(`width`)).toBe(`1em`);
        expect(svg.getAttribute(`height`)).toBe(`1em`);
        expect(svg.getAttribute(`focusable`)).toBe(`false`);
    }
});

it(`updates both its drawing and its accessible name after mount`, async () => {
    const name = ref<IconName>(`check`);
    const label = ref<string>();
    const host = document.createElement(`div`);
    app = createApp({ render: () => h(Icon, { name: name.value, "aria-label": label.value }) });
    app.mount(host);
    const svg = host.querySelector(`svg`)!;
    expect(svg.getAttribute(`aria-hidden`)).toBe(`true`);
    name.value = `times`;
    label.value = `Failed`;
    await nextTick();
    expect(svg.querySelector(`path`)?.getAttribute(`d`)).toBe(ICONS.times.outline);
    expect(svg.getAttribute(`aria-hidden`)).toBeNull();
    expect(svg.getAttribute(`aria-label`)).toBe(`Failed`);
    label.value = undefined;
    await nextTick();
    expect(svg.getAttribute(`aria-hidden`)).toBe(`true`);
});

it(`keeps section meanings consistent while accepting valid extension fallbacks`, () => {
    expect(sectionIcon(`terminal`, `code`)).toBe(`terminal`);
    expect(sectionIcon(`workspace`, `file-tree`)).toBe(`folder`);
    expect(sectionIcon(`agent`, `sparkles`)).toBe(`robot`);
    expect(sectionIcon(`third-party-view`, `camera`)).toBe(`camera`);
    expect(sectionIcon(`third-party-view`)).toBeUndefined();
    expect(isIconName(`constructor`)).toBe(false);
    expect(isIconName(`toString`)).toBe(false);
});
