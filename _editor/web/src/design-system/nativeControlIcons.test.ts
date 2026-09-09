// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { type App, type Component, createApp, h, nextTick } from "vue";
import Checkbox from "primevue/checkbox";
import Dialog from "primevue/dialog";
import Drawer from "primevue/drawer";
import Button from "primevue/button";
import { installUi } from "../../../ui/src/plugin.js";
import { ICONS, type IconName } from "../../../ui/src/icons/iconSets.js";

let app: App | undefined;
const mount = async (component: Component, props: Record<string, unknown>): Promise<HTMLElement> => {
    const host = document.createElement(`div`);
    document.body.append(host);
    app = createApp({ render: () => h(component, props) });
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

const expectDrawing = (host: ParentNode, name: IconName): void => {
    expect([...host.querySelectorAll(`svg.ui-icon path`)].map((path) => path.getAttribute(`d`))).toContain(ICONS[name].outline);
    expect(host.querySelector(`.p-icon`)).toBeNull();
};

it(`draws a native checkmark and keeps checkbox changes working`, async () => {
    const changed: boolean[] = [];
    const host = await mount(Checkbox, { binary: true, modelValue: true, "onUpdate:modelValue": (value: boolean) => changed.push(value) });
    expectDrawing(host, `check`);
    const input = host.querySelector(`input`)!;
    expect(input.checked).toBe(true);
    input.click();
    await nextTick();
    expect(changed).toEqual([false]);
});

it(`draws an indeterminate checkbox with the native minus`, async () => {
    const host = await mount(Checkbox, { binary: true, indeterminate: true });
    expectDrawing(host, `minus`);
    expect(host.querySelector(`input`)?.indeterminate).toBe(true);
});

it(`uses the native spinner for a library button's loading fallback`, async () => {
    const host = await mount(Button, { label: `Save`, loading: true });
    expectDrawing(host, `spinner`);
    expect(host.querySelector(`animateTransform`)?.getAttribute(`dur`)).toBe(`1.1s`);
    expect(host.querySelector(`button`)?.disabled).toBe(true);
});

it(`draws native dialog controls and closes through the original button`, async () => {
    const changed: boolean[] = [];
    const host = await mount(Dialog, {
        visible: true,
        header: `Preview`,
        maximizable: true,
        appendTo: `self`,
        "onUpdate:visible": (open: boolean) => changed.push(open),
    });
    expectDrawing(host, `times`);
    expectDrawing(host, `expand`);
    const close = host.querySelector<HTMLButtonElement>(`button[aria-label="Close"]`)!;
    close.click();
    await nextTick();
    expect(changed).toEqual([false]);
});

it(`draws the same native close mark in a drawer`, async () => {
    const changed: boolean[] = [];
    await mount(Drawer, { visible: true, header: `Options`, "onUpdate:visible": (open: boolean) => changed.push(open) });
    expectDrawing(document.body, `times`);
    document.querySelector<HTMLButtonElement>(`button[aria-label="Close"]`)!.click();
    await nextTick();
    expect(changed).toEqual([false]);
});
