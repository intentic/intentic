// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { type App, createApp, h, nextTick } from "vue";
import Icon from "../../../ui/src/components/Icon.vue";
import { installUi } from "../../../ui/src/plugin.js";

let app: App | undefined;
const mount = async (spin: boolean): Promise<HTMLElement> => {
    const host = document.createElement(`div`);
    document.body.append(host);
    app = createApp({ render: () => h(Icon, { name: `spinner`, spin }) });
    installUi(app);
    app.mount(host);
    await nextTick();
    return host;
};

afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
});

it(`animates a running icon inside the SVG without a CSS animation class`, async () => {
    const host = await mount(true);

    expect(host.querySelector(`svg`)).not.toBeNull();
    expect(host.querySelector(`animateTransform, animatetransform`)).not.toBeNull();
    expect(host.querySelector(`.animate-spin`)).toBeNull();
});

it(`leaves an ordinary icon still`, async () => {
    const host = await mount(false);

    expect(host.querySelector(`svg`)).not.toBeNull();
    expect(host.querySelector(`animateTransform, animatetransform`)).toBeNull();
});
