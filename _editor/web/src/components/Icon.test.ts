// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { type App, createApp, h, nextTick } from "vue";
import Icon from "@intentic/ui/icon";
import { areaIcon, ICONS, isIconName, type IconName } from "../../../ui/src/icons/iconSets.js";
import { installUi } from "../../../ui/src/plugin.js";

let app: App | undefined;
// Props are cast through `as never` since the accessibility tests below pass raw fallthrough attrs (`aria-label`,
// `title`) that the component doesn't declare, that lack of a typed prop is exactly the mechanism under test.
// `name`/`spin` are the real, typed props.
const mount = async (props: { name: IconName; spin?: boolean } & Record<string, unknown>): Promise<HTMLElement> => {
    const host = document.createElement(`div`);
    document.body.append(host);
    app = createApp({ render: () => h(Icon, props as never) });
    installUi(app);
    app.mount(host);
    await nextTick();
    return host;
};
const spinner = async (spin: boolean): Promise<HTMLElement> => mount({ name: `spinner`, spin });

afterEach(() => {
    app?.unmount();
    app = undefined;
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

// The one accessibility rule: a named glyph is announced, an unnamed one stays hidden. Pinned since the failure
// was silent: Iconify hides every svg by default and clears that only for an explicit `aria-hidden={false}`, not
// for `aria-label` alone, so a labelled call site could still ship a hidden node. Asserts on the rendered
// attributes, not the props, since the question is what the library does with what we hand it.

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

// A named glyph is read out: `role="img"` is Iconify's own and stays; what this asserts is that the hiding gets
// lifted.
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

it(`renders the whole offline vocabulary, including the custom collection, with one geometry and stroke weight`, async () => {
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
    installUi(app);
    app.mount(host);
    await nextTick();

    const rendered = [...host.querySelectorAll(`svg`)];
    expect(rendered.map((svg) => svg.getAttribute(`data-icon-name`))).toEqual(names);
    for (const [at, svg] of rendered.entries()) {
        expect(svg.getAttribute(`viewBox`)).toBe(`0 0 24 24`);
        expect(svg.querySelectorAll(`path`).length).toBeGreaterThan(0);
        if (ICONS[names[at]!].startsWith(`intentic:`)) {
            expect(svg.querySelector(`g`)?.getAttribute(`stroke-width`)).toBe(`2`);
        }
    }
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
