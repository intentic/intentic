// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { type App, createApp, h, nextTick } from "vue";
import Icon from "../../../ui/src/components/Icon.vue";
import type { IconName } from "../../../ui/src/icons/iconSets.js";
import { installUi } from "../../../ui/src/plugin.js";

let app: App | undefined;
/* Mount the real component into a detached host. The props/attrs bag is passed through a cast because the
 * accessibility tests below hand it raw HTML attributes (`aria-label`, `title`), which are FALLTHROUGH attrs
 * precisely because the component does not declare them — that is the mechanism under test, so there is no
 * typed prop surface for them to arrive on. `name` and `spin` are the real props and stay typed. */
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

/* THE ONE ACCESSIBILITY RULE: a glyph that was given a name is announced, and a glyph that was not stays out
 * of the way.
 *
 * Pinned because the failure it replaces was SILENT and only reachable by doing the right thing. Iconify hides
 * every svg it draws (`aria-hidden: true` among its svg defaults) and clears that only for a caller who passes
 * `aria-hidden` falsy — an `aria-label` does not do it. So every call site that bothered to label its icon
 * shipped a labelled node that assistive tech skips, and nothing anywhere said so.
 *
 * These read the RENDERED attributes rather than the component's own props, because the whole question is what
 * the library does with what we hand it: a test of our intent would have passed against the broken version. */

const svgOf = async (props: { name: IconName } & Record<string, unknown>): Promise<SVGElement> => {
    const svg = (await mount(props)).querySelector(`svg`);
    expect(svg).not.toBeNull();
    return svg!;
};

/* DECORATION STAYS SILENT, which is right for the overwhelming majority of icons in the app: they sit beside
 * text that says the same thing, and reading both is how a list of rows becomes twice as long to listen to. */
it(`keeps an unlabelled glyph out of the accessibility tree`, async () => {
    expect((await svgOf({ name: `check` })).getAttribute(`aria-hidden`)).toBe(`true`);
});

/* ...AND A NAMED ONE IS READ OUT. `role="img"` is Iconify's own and stays; what this asserts is that the
 * hiding is LIFTED, which is the half that used to be missing and the half no call site could see. */
it(`announces a glyph that was given a label`, async () => {
    const svg = await svgOf({ name: `exclamation-circle`, "aria-label": `Needs you` });

    expect({
        hidden: svg.getAttribute(`aria-hidden`),
        role: svg.getAttribute(`role`),
        label: svg.getAttribute(`aria-label`),
    }).toEqual({ hidden: null, role: `img`, label: `Needs you` });
});

// A `title` counts as a name too: it is the other way an icon says what it is, and the rule is about HAVING a
// name rather than about which attribute carries it.
it(`announces a glyph named by its title`, async () => {
    expect((await svgOf({ name: `clock`, title: `Waiting` })).getAttribute(`aria-hidden`)).toBeNull();
});
