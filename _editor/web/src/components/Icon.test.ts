// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { type App, createApp, h, nextTick, ref } from "vue";
import Icon from "@intentic/ui/icon";
import { areaIcon, ICONS, isIconName, type IconName } from "../../../ui/src/icons/iconSets.js";

let app: App | undefined;
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
    vi.restoreAllMocks();
    document.body.innerHTML = ``;
});

it(`animates a running icon inside the SVG without a CSS animation class`, async () => {
    const host = await spinner(true);

    expect(host.querySelector(`svg`)).not.toBeNull();
    expect(host.querySelector(`animateTransform, animatetransform`)).not.toBeNull();
    expect(host.querySelector(`.animate-spin`)).toBeNull();
});

it(`leaves an ordinary icon still`, async () => {
    const host = await spinner(false);

    expect(host.querySelector(`svg`)).not.toBeNull();
    expect(host.querySelector(`animateTransform, animatetransform`)).toBeNull();
});

it(`slows the spinner for reduced motion and removes its preference listener on unmount`, async () => {
    const query = window.matchMedia(`(prefers-reduced-motion: reduce)`);
    const remove = vi.spyOn(query, `removeEventListener`);
    Object.defineProperty(query, `matches`, { value: true });
    vi.spyOn(window, `matchMedia`).mockReturnValue(query);
    const host = await spinner(true);
    expect(host.querySelector(`animateTransform`)?.getAttribute(`dur`)).toBe(`3s`);
    app!.unmount();
    app = undefined;
    expect(remove).toHaveBeenCalledWith(`change`, expect.any(Function));
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
        expect(svg.querySelector(`g`)?.getAttribute(`stroke-width`)).toBe(`2`);
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
    expect(areaIcon(`terminal`, `code`)).toBe(`terminal`);
    expect(areaIcon(`workspace`, `file-tree`)).toBe(`folder`);
    expect(areaIcon(`agent`, `sparkles`)).toBe(`robot`);
    expect(areaIcon(`third-party-view`, `camera`)).toBe(`camera`);
    expect(areaIcon(`third-party-view`)).toBeUndefined();
    expect(isIconName(`constructor`)).toBe(false);
    expect(isIconName(`toString`)).toBe(false);
});
